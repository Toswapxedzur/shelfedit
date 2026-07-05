//! Video decode via the FFmpeg CLI (hardware `videotoolbox`), yielding raw RGBA
//! frames. Chosen over in-process libav bindings because the local FFmpeg (8.1 /
//! libav 62) is newer than the Rust binding crates support; the CLI is robust
//! and still uses the hardware decoder. See NATIVE_REWRITE.md.
//!
//! Two modes:
//!  - `VideoStream`: a running decode-ahead pipe for playback (CFR-normalized,
//!    which also neutralizes the VFR sources that caused the old lag).
//!  - `decode_one`: grab a single frame at a time (for scrubbing while paused).

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::Arc;
use std::thread;

use anyhow::{anyhow, Result};

/// One decoded frame: RGBA8 at `width`x`height`, tagged with its source time.
pub struct Frame {
    pub time: f64,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Even-dimension preview size that fits `max_dim`, preserving aspect.
pub fn preview_size(w: u32, h: u32, max_dim: u32) -> (u32, u32) {
    let long = w.max(h) as f64;
    let scale = if long > max_dim as f64 {
        max_dim as f64 / long
    } else {
        1.0
    };
    let ow = (((w as f64 * scale) as u32) / 2) * 2;
    let oh = (((h as f64 * scale) as u32) / 2) * 2;
    (ow.max(2), oh.max(2))
}

/// A running decode-ahead video pipe.
pub struct VideoStream {
    pub rx: Receiver<Frame>,
    child: Child,
    stop: Arc<AtomicBool>,
}

impl VideoStream {
    pub fn start(path: &str, start: f64, fps: u32, out_w: u32, out_h: u32) -> Result<Self> {
        let mut child = Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-hwaccel",
                "videotoolbox",
                "-ss",
                &format!("{start}"),
                "-i",
                path,
                "-an",
                "-vf",
                &format!("scale={out_w}:{out_h}"),
                "-r",
                &format!("{fps}"),
                "-pix_fmt",
                "rgba",
                "-f",
                "rawvideo",
                "-",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;

        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("ffmpeg stdout unavailable"))?;

        let (tx, rx) = sync_channel::<Frame>(8);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_reader = stop.clone();
        let frame_size = (out_w * out_h * 4) as usize;

        thread::spawn(move || {
            let mut idx: u64 = 0;
            let mut buf = vec![0u8; frame_size];
            loop {
                if stop_reader.load(Ordering::Relaxed) {
                    break;
                }
                match stdout.read_exact(&mut buf) {
                    Ok(()) => {
                        let time = start + idx as f64 / fps as f64;
                        idx += 1;
                        let frame = Frame {
                            time,
                            width: out_w,
                            height: out_h,
                            rgba: buf.clone(),
                        };
                        if tx.send(frame).is_err() {
                            break; // consumer dropped
                        }
                    }
                    Err(_) => break, // EOF or pipe closed
                }
            }
        });

        Ok(Self { rx, child, stop })
    }
}

impl Drop for VideoStream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Decode a single frame at `t` (fast input seek). Used for paused scrubbing.
///
/// Deliberately *software* decode: the VideoToolbox hwaccel adds a ~300-600ms
/// session init on every process spawn, which dominates single-frame latency.
/// Software decode of one frame after an input `-ss` seek is ~3-4x faster here,
/// so scrubbing feels responsive. (Streaming playback still uses hwaccel.)
pub fn decode_one(path: &str, t: f64, out_w: u32, out_h: u32) -> Result<Frame> {
    let out = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            &format!("{t}"),
            "-i",
            path,
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={out_w}:{out_h}"),
            "-pix_fmt",
            "rgba",
            "-f",
            "rawvideo",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()?;

    let size = (out_w * out_h * 4) as usize;
    if out.stdout.len() < size {
        return Err(anyhow!(
            "short frame: got {} of {} bytes",
            out.stdout.len(),
            size
        ));
    }
    Ok(Frame {
        time: t,
        width: out_w,
        height: out_h,
        rgba: out.stdout[..size].to_vec(),
    })
}

/// Background scrub worker: coalesces seek targets and decodes the latest one.
/// A single-frame decoder backend. Given a source time it returns the frame at
/// (or nearest at/behind) that time. macOS uses a persistent, hardware
/// AVFoundation generator kept warm across seeks; other platforms fall back to
/// the FFmpeg CLI. New platforms slot in behind this trait.
pub trait FrameDecoder: Send {
    fn frame_at(&mut self, t: f64) -> Result<Frame>;
}

/// Portable fallback: one FFmpeg process per frame (used off-macOS or if the
/// platform decoder can't open the file).
struct FfmpegDecoder {
    path: String,
    w: u32,
    h: u32,
}
impl FrameDecoder for FfmpegDecoder {
    fn frame_at(&mut self, t: f64) -> Result<Frame> {
        decode_one(&self.path, t, self.w, self.h)
    }
}

/// Pick the best single-frame decoder for this platform/media. `tolerance_ms`
/// trades precision for speed (0 = exact/park, >0 = fast/scrub).
fn open_decoder(
    path: &str,
    max_dim: u32,
    src_w: u32,
    src_h: u32,
    tolerance_ms: u32,
) -> Box<dyn FrameDecoder> {
    #[cfg(target_os = "macos")]
    {
        match crate::avdecode::AvDecoder::open(path, max_dim, tolerance_ms) {
            Ok(d) => return Box::new(d),
            Err(e) => log::warn!("AVFoundation decoder unavailable for {path}: {e}; using ffmpeg"),
        }
    }
    let _ = tolerance_ms; // ffmpeg's input `-ss` is already a coarse seek
    let (w, h) = preview_size(src_w.max(2), src_h.max(2), max_dim);
    Box::new(FfmpegDecoder {
        path: path.to_string(),
        w,
        h,
    })
}

/// Background scrub worker: owns a single persistent decoder and services the
/// most recent requested time (coalesced), so a fast drag never queues a
/// backlog and each frame reuses the warm decoder.
pub struct SeekWorker {
    target_tx: std::sync::mpsc::Sender<f64>,
    pub frame_rx: Receiver<Frame>,
}

impl SeekWorker {
    pub fn new(path: String, max_dim: u32, src_w: u32, src_h: u32, tolerance_ms: u32) -> Self {
        let (target_tx, target_rx) = std::sync::mpsc::channel::<f64>();
        let (frame_tx, frame_rx) = sync_channel::<Frame>(2);
        thread::spawn(move || {
            let mut dec = open_decoder(&path, max_dim, src_w, src_h, tolerance_ms);
            while let Ok(mut t) = target_rx.recv() {
                // Coalesce: only decode the most recent requested target.
                while let Ok(nt) = target_rx.try_recv() {
                    t = nt;
                }
                match dec.frame_at(t) {
                    Ok(frame) => {
                        let _ = frame_tx.send(frame);
                    }
                    Err(e) => log::debug!("scrub decode failed at {t:.3}: {e}"),
                }
            }
        });
        Self {
            target_tx,
            frame_rx,
        }
    }

    pub fn request(&self, t: f64) {
        let _ = self.target_tx.send(t);
    }
}

/// Playback-like scrubbing: follows the cursor with the right decoder for the
/// current scrub speed.
///
/// Slow drag streams frames sequentially (a few ms each — like variable-speed
/// playback); a fast fling or a backward move jumps straight to the cursor with
/// a warm random-access decoder and decodes only that frame, so the work stays
/// bounded no matter how fast you drag. On non-macOS it stays empty and the
/// caller falls back to the frame cache.
pub struct ScrubStream {
    #[allow(dead_code)]
    tx: std::sync::mpsc::Sender<(String, f64, u32)>,
    #[allow(dead_code)]
    rx: Receiver<(String, Frame)>,
    last: Option<(String, Arc<Vec<u8>>, u32, u32)>,
}

impl Default for ScrubStream {
    fn default() -> Self {
        Self::new()
    }
}

impl ScrubStream {
    pub fn new() -> Self {
        let (tx, _target_rx) = std::sync::mpsc::channel::<(String, f64, u32)>();
        let (_frame_tx, rx) = sync_channel::<(String, Frame)>(2);

        #[cfg(target_os = "macos")]
        {
            let target_rx = _target_rx;
            let frame_tx = _frame_tx;
            thread::spawn(move || {
                use crate::avdecode::{AvDecoder, AvReader};
                // Two decoders, each used where it's fastest — the split real
                // editors use:
                //   * slow drag  -> sequential reader (~5 ms/frame): stream every
                //     frame, playback-smooth.
                //   * fast fling / backward -> warm image generator (~40 ms, stays
                //     warm so no recreate cost): jump straight to the cursor and
                //     decode ONLY that frame, skipping the frames flown past.
                // The decode work then tracks how many frames the user can see,
                // not how far the cursor jumped — so fast scrubbing stops lagging.
                const SEEK_GAP: f64 = 0.25; // forward gap beyond which we jump, not stream
                const STREAM_BUDGET: u32 = 16; // max sequential decodes per tick
                let eps = 1.0 / 60.0;
                let mut reader: Option<AvReader> = None; // sequential (slow drag)
                let mut gen: Option<AvDecoder> = None; // warm random-access (jumps)
                let mut cur_path = String::new();
                let mut last_t = f64::NEG_INFINITY; // reader's current position
                while let Ok(mut msg) = target_rx.recv() {
                    while let Ok(m) = target_rx.try_recv() {
                        msg = m; // coalesce to the newest cursor position
                    }
                    let (path, target, max_dim) = msg;
                    if path != cur_path {
                        reader = None;
                        gen = None;
                        cur_path = path.clone();
                        last_t = f64::NEG_INFINITY;
                    }
                    if gen.is_none() {
                        gen = AvDecoder::open(&path, max_dim, 0).ok();
                    }

                    let gap = target - last_t;
                    let stream_ok = gap >= -eps && gap <= SEEK_GAP;

                    if stream_ok && reader.is_some() {
                        // Slow forward: stream sequentially to the cursor.
                        let r = reader.as_mut().unwrap();
                        let mut emitted: Option<Frame> = None;
                        let mut budget = STREAM_BUDGET;
                        while last_t < target - eps && budget > 0 {
                            budget -= 1;
                            match r.next() {
                                Some(f) => {
                                    last_t = f.time;
                                    emitted = Some(f);
                                }
                                None => {
                                    reader = None;
                                    break;
                                }
                            }
                        }
                        if let Some(f) = emitted {
                            let _ = frame_tx.send((cur_path.clone(), f));
                        }
                    } else if stream_ok {
                        // Slow forward but no reader yet (just settled out of a
                        // fling / first frame): open the reader here so subsequent
                        // small steps stream. One-time ~open cost at this transition.
                        reader = AvReader::open(&path, (target - 0.001).max(0.0), max_dim).ok();
                        last_t = f64::NEG_INFINITY;
                        if let Some(r) = reader.as_mut() {
                            let mut emitted: Option<Frame> = None;
                            let mut budget = STREAM_BUDGET;
                            while last_t < target - eps && budget > 0 {
                                budget -= 1;
                                match r.next() {
                                    Some(f) => {
                                        last_t = f.time;
                                        emitted = Some(f);
                                    }
                                    None => {
                                        reader = None;
                                        break;
                                    }
                                }
                            }
                            if let Some(f) = emitted {
                                let _ = frame_tx.send((cur_path.clone(), f));
                            }
                        }
                    } else {
                        // Fast fling or backward: jump to the cursor with the warm
                        // generator and decode just that frame. Drop the sequential
                        // reader (it's now behind); it reopens when the drag slows.
                        reader = None;
                        if let Some(g) = gen.as_mut() {
                            if let Ok(f) = g.frame_at(target.max(0.0)) {
                                last_t = target;
                                let _ = frame_tx.send((cur_path.clone(), f));
                            }
                        }
                    }
                }
            });
        }

        Self { tx, rx, last: None }
    }

    /// Request the frame at `target` for `path`; returns the most recent frame
    /// the sequential reader has produced (refines toward the cursor).
    pub fn frame_for(
        &mut self,
        path: &str,
        target: f64,
        max_dim: u32,
    ) -> Option<(Arc<Vec<u8>>, u32, u32)> {
        let _ = self.tx.send((path.to_string(), target, max_dim));
        while let Ok((p, f)) = self.rx.try_recv() {
            self.last = Some((p, Arc::new(f.rgba), f.width, f.height));
        }
        match &self.last {
            Some((p, rgba, w, h)) if p == path => Some((rgba.clone(), *w, *h)),
            _ => None,
        }
    }
}

/// Async decoded-frame cache for compositing non-primary / paused layers.
/// One coalescing decode worker per media file; results are cached by
/// (path, ~0.1s-quantized source time) so repeat scrubs/paints are instant.
pub struct FrameCache {
    max_dim: u32,
    tolerance_ms: u32,
    workers: std::collections::HashMap<String, SeekWorker>,
    cache: std::collections::HashMap<(String, i64), Arc<Frame>>,
    order: std::collections::VecDeque<(String, i64)>,
    cap: usize,
}

fn qkey(t: f64) -> i64 {
    (t * 10.0).round() as i64
}

impl FrameCache {
    /// `tolerance_ms` trades precision for speed while dragging (0 = exact).
    pub fn new(max_dim: u32, tolerance_ms: u32) -> Self {
        Self {
            max_dim,
            tolerance_ms,
            workers: std::collections::HashMap::new(),
            cache: std::collections::HashMap::new(),
            order: std::collections::VecDeque::new(),
            cap: 128,
        }
    }

    /// Return the cached frame at `t` if ready, else enqueue a decode (sized to
    /// the media's aspect) and return None. Drains completed decodes first.
    pub fn get(&mut self, path: &str, t: f64, src_w: u32, src_h: u32) -> Option<Arc<Frame>> {
        if let Some(w) = self.workers.get(path) {
            while let Ok(fr) = w.frame_rx.try_recv() {
                let k = (path.to_string(), qkey(fr.time));
                if !self.cache.contains_key(&k) {
                    self.order.push_back(k.clone());
                }
                self.cache.insert(k, Arc::new(fr));
            }
            self.evict();
        }
        let key = (path.to_string(), qkey(t));
        if let Some(f) = self.cache.get(&key) {
            return Some(f.clone());
        }
        let max_dim = self.max_dim;
        let tol = self.tolerance_ms;
        let worker = self.workers.entry(path.to_string()).or_insert_with(|| {
            SeekWorker::new(path.to_string(), max_dim, src_w.max(2), src_h.max(2), tol)
        });
        worker.request(t);

        // Not decoded yet: land on the nearest already-decoded frame for this
        // media (within ~0.5s) so a fast scrub shows a close frame that refines,
        // instead of a blank or a stale unrelated one.
        let tq = qkey(t);
        let mut best: Option<(i64, Arc<Frame>)> = None;
        for ((p, k), fr) in self.cache.iter() {
            if p != path {
                continue;
            }
            let d = (k - tq).abs();
            if d <= 5 && best.as_ref().map(|(bd, _)| d < *bd).unwrap_or(true) {
                best = Some((d, fr.clone()));
            }
        }
        best.map(|(_, fr)| fr)
    }

    fn evict(&mut self) {
        while self.cache.len() > self.cap {
            if let Some(k) = self.order.pop_front() {
                self.cache.remove(&k);
            } else {
                break;
            }
        }
    }
}
