//! Audio output via cpal, providing the master playback clock (ffplay model:
//! audio hardware advances at real time, video is presented to match it).
//!
//! Audio is decoded by a dedicated FFmpeg CLI pipe (f32le at the device's rate),
//! buffered, and drained by the cpal output callback, which counts frames it has
//! emitted. The clock is `start + frames_played / sample_rate`.

use std::collections::VecDeque;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

pub struct AudioPlayer {
    _stream: cpal::Stream,
    child: Child,
    stop: Arc<AtomicBool>,
    played: Arc<AtomicU64>, // per-channel frames emitted by the device
    sample_rate: u32,
    start: f64,
}

impl AudioPlayer {
    pub fn start(path: &str, start: f64) -> Result<Self> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| anyhow!("no default output device"))?;
        let default_cfg = device.default_output_config()?;
        let sample_rate = default_cfg.sample_rate().0;
        let channels = default_cfg.channels() as usize;

        // Decode audio to interleaved f32 at the device rate/channels.
        let mut child = Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                &format!("{start}"),
                "-i",
                path,
                "-vn",
                "-ac",
                &format!("{channels}"),
                "-ar",
                &format!("{sample_rate}"),
                "-f",
                "f32le",
                "-",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("ffmpeg audio stdout unavailable"))?;

        let buf: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let played = Arc::new(AtomicU64::new(0));

        // Reader thread: fill the ring buffer, with simple backpressure.
        let cap = (sample_rate as usize) * channels * 2; // ~2s
        let buf_reader = buf.clone();
        let stop_reader = stop.clone();
        thread::spawn(move || {
            let mut raw = vec![0u8; 16384];
            loop {
                if stop_reader.load(Ordering::Relaxed) {
                    break;
                }
                // Backpressure: don't read far ahead.
                loop {
                    if stop_reader.load(Ordering::Relaxed) {
                        return;
                    }
                    if buf_reader.lock().unwrap().len() < cap {
                        break;
                    }
                    thread::sleep(Duration::from_millis(3));
                }
                match stdout.read(&mut raw) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut guard = buf_reader.lock().unwrap();
                        for c in raw[..n].chunks_exact(4) {
                            guard.push_back(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Output callback: drain the buffer, count emitted frames.
        let buf_cb = buf.clone();
        let played_cb = played.clone();
        let cfg = cpal::StreamConfig {
            channels: channels as u16,
            sample_rate: cpal::SampleRate(sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };
        let err_fn = |e| eprintln!("audio stream error: {e}");
        let stream = device.build_output_stream(
            &cfg,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let mut guard = buf_cb.lock().unwrap();
                for frame in data.chunks_mut(channels) {
                    for s in frame.iter_mut() {
                        *s = guard.pop_front().unwrap_or(0.0);
                    }
                    played_cb.fetch_add(1, Ordering::Relaxed);
                }
            },
            err_fn,
            None,
        )?;
        stream.play()?;

        Ok(Self {
            _stream: stream,
            child,
            stop,
            played,
            sample_rate,
            start,
        })
    }

    /// Current audio clock in seconds (source time).
    pub fn clock(&self) -> f64 {
        self.start + self.played.load(Ordering::Relaxed) as f64 / self.sample_rate as f64
    }
}

impl Drop for AudioPlayer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
