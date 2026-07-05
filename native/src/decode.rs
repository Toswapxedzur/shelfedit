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
pub struct SeekWorker {
    target_tx: std::sync::mpsc::Sender<f64>,
    pub frame_rx: Receiver<Frame>,
}

impl SeekWorker {
    pub fn new(path: String, out_w: u32, out_h: u32) -> Self {
        let (target_tx, target_rx) = std::sync::mpsc::channel::<f64>();
        let (frame_tx, frame_rx) = sync_channel::<Frame>(2);
        thread::spawn(move || {
            while let Ok(mut t) = target_rx.recv() {
                // Coalesce: only decode the most recent requested target.
                while let Ok(nt) = target_rx.try_recv() {
                    t = nt;
                }
                if let Ok(frame) = decode_one(&path, t, out_w, out_h) {
                    let _ = frame_tx.send(frame);
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

/// Async decoded-frame cache for compositing non-primary / paused layers.
/// One coalescing decode worker per media file; results are cached by
/// (path, ~0.1s-quantized source time) so repeat scrubs/paints are instant.
pub struct FrameCache {
    max_dim: u32,
    workers: std::collections::HashMap<String, SeekWorker>,
    cache: std::collections::HashMap<(String, i64), Arc<Frame>>,
    order: std::collections::VecDeque<(String, i64)>,
    cap: usize,
}

fn qkey(t: f64) -> i64 {
    (t * 10.0).round() as i64
}

impl FrameCache {
    pub fn new(max_dim: u32) -> Self {
        Self {
            max_dim,
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
        let (ow, oh) = preview_size(src_w.max(2), src_h.max(2), self.max_dim);
        let worker = self
            .workers
            .entry(path.to_string())
            .or_insert_with(|| SeekWorker::new(path.to_string(), ow, oh));
        worker.request(t);
        None
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
