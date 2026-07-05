//! Playback engine: owns the clock, the decode-ahead video stream, the audio
//! output, and the currently displayed frame. Presents the video frame that
//! matches the master clock (audio when available, else a monotonic wall clock).

use std::time::Instant;

use crate::audio::AudioPlayer;
use crate::decode::{decode_one, preview_size, Frame, SeekWorker, VideoStream};

pub struct Player {
    path: String,
    pub duration: f64,
    pub fps: u32,
    pub out_w: u32,
    pub out_h: u32,

    playing: bool,
    paused_at: f64,

    // Master clock sources.
    audio: Option<AudioPlayer>,
    wall_start: Instant,
    wall_base: f64,

    video: Option<VideoStream>,
    pending: Option<Frame>, // a decoded frame whose time is still ahead of clock

    seeker: SeekWorker,

    pub cur: Option<Frame>,
    pub cur_version: u64, // bumped whenever `cur` changes (for texture upload)
    pub last_error: Option<String>,
}

impl Player {
    pub fn new(path: String, src_w: u32, src_h: u32, duration: f64, fps: u32) -> Self {
        let (out_w, out_h) = preview_size(src_w, src_h, 1280);
        // The player parks on release, so it wants a frame-accurate seek (tol 0).
        let seeker = SeekWorker::new(path.clone(), 1280, src_w, src_h, 0);
        let mut p = Self {
            path,
            duration,
            fps: fps.max(1),
            out_w,
            out_h,
            playing: false,
            paused_at: 0.0,
            audio: None,
            wall_start: Instant::now(),
            wall_base: 0.0,
            video: None,
            pending: None,
            seeker,
            cur: None,
            cur_version: 0,
            last_error: None,
        };
        // Show the first frame immediately.
        p.seek(0.0);
        p
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    pub fn clock(&self) -> f64 {
        let t = if !self.playing {
            self.paused_at
        } else if let Some(a) = &self.audio {
            a.clock()
        } else {
            self.wall_base + self.wall_start.elapsed().as_secs_f64()
        };
        t.clamp(0.0, self.duration.max(0.0))
    }

    /// Start playback from a specific source time (used by the timeline monitor
    /// when it points the decoder at a clip).
    pub fn play_from(&mut self, from: f64) {
        self.paused_at = from.clamp(0.0, self.duration.max(0.0));
        self.play();
    }

    pub fn play(&mut self) {
        if self.playing {
            return;
        }
        let from = self.paused_at.clamp(0.0, self.duration.max(0.0));
        // Audio is best-effort: on any failure we fall back to the wall clock.
        self.audio = match AudioPlayer::start(&self.path, from) {
            Ok(a) => Some(a),
            Err(e) => {
                self.last_error = Some(format!("audio: {e}"));
                None
            }
        };
        self.wall_base = from;
        self.wall_start = Instant::now();
        self.pending = None;
        match VideoStream::start(&self.path, from, self.fps, self.out_w, self.out_h) {
            Ok(v) => self.video = Some(v),
            Err(e) => {
                self.last_error = Some(format!("video: {e}"));
                self.video = None;
            }
        }
        self.playing = true;
    }

    pub fn pause(&mut self) {
        if !self.playing {
            return;
        }
        self.paused_at = self.clock();
        self.playing = false;
        self.audio = None; // Drop stops the stream + ffmpeg
        self.video = None; // Drop kills ffmpeg
        self.pending = None;
    }

    pub fn toggle(&mut self) {
        if self.playing {
            self.pause();
        } else {
            self.play();
        }
    }

    /// Scrub to `t` while paused: request a single decoded frame (coalesced).
    pub fn seek(&mut self, t: f64) {
        let t = t.clamp(0.0, self.duration.max(0.0));
        self.paused_at = t;
        if self.playing {
            // Re-anchor and restart the running stream at the new position.
            self.wall_base = t;
            self.wall_start = Instant::now();
            self.pending = None;
            self.audio = AudioPlayer::start(&self.path, t).ok();
            self.video = VideoStream::start(&self.path, t, self.fps, self.out_w, self.out_h).ok();
        } else {
            self.seeker.request(t);
        }
    }

    fn set_cur(&mut self, f: Frame) {
        self.cur = Some(f);
        self.cur_version = self.cur_version.wrapping_add(1);
    }

    /// Advance state to match the clock. Returns true while actively playing
    /// (so the UI keeps repainting). Also drains scrub results while paused.
    pub fn update(&mut self) -> bool {
        // Paused: pick up any scrub frame that finished decoding (keep newest).
        if !self.playing {
            let mut latest = None;
            while let Ok(f) = self.seeker.frame_rx.try_recv() {
                latest = Some(f);
            }
            if let Some(f) = latest {
                self.set_cur(f);
            }
            return false;
        }

        let t = self.clock();

        // End of media.
        if t >= self.duration - 1e-3 {
            self.pause();
            self.paused_at = self.duration;
            return false;
        }

        // Present the newest frame at/behind the clock; hold a future frame.
        let eps = 0.5 / self.fps as f64;
        loop {
            let next = if self.pending.is_some() {
                self.pending.take()
            } else if let Some(v) = &self.video {
                v.rx.try_recv().ok()
            } else {
                None
            };
            match next {
                Some(f) => {
                    if f.time <= t + eps {
                        self.set_cur(f);
                    } else {
                        self.pending = Some(f);
                        break;
                    }
                }
                None => break,
            }
        }
        true
    }
}

/// Synchronous single-frame decode used before the engine exists (unused by the
/// UI but handy for tests / warmups).
#[allow(dead_code)]
pub fn first_frame(path: &str, w: u32, h: u32) -> Option<Frame> {
    let (ow, oh) = preview_size(w, h, 1280);
    decode_one(path, 0.0, ow, oh).ok()
}
