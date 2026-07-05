//! Safe Rust wrapper around the AVFoundation frame-decoder bridge (`av_decode.m`).
//! macOS only. A persistent, hardware-accelerated decoder that can return any
//! frame at any time — reused across seeks so scrubbing is near-instant.

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};

use anyhow::{anyhow, Result};

use crate::decode::{Frame, FrameDecoder};

extern "C" {
    fn se_av_open(path: *const c_char, max_dim: c_int, tolerance_ms: c_int) -> *mut c_void;
    fn se_av_frame(
        handle: *mut c_void,
        t: f64,
        out_rgba: *mut *mut u8,
        out_w: *mut c_int,
        out_h: *mut c_int,
    ) -> c_int;
    fn se_av_free(buf: *mut u8);
    fn se_av_close(handle: *mut c_void);

    fn se_av_reader_open(path: *const c_char, start: f64, max_dim: c_int) -> *mut c_void;
    fn se_av_reader_next(
        handle: *mut c_void,
        out_rgba: *mut *mut u8,
        out_w: *mut c_int,
        out_h: *mut c_int,
        out_time: *mut f64,
    ) -> c_int;
    fn se_av_reader_close(handle: *mut c_void);
}

pub struct AvDecoder {
    handle: *mut c_void,
}

// The underlying AVAssetImageGenerator is safe to use from a single worker
// thread; we never share the handle across threads without ownership transfer.
unsafe impl Send for AvDecoder {}

impl AvDecoder {
    /// `tolerance_ms`: 0 = frame-accurate (park on release); >0 = fast nearby
    /// frame (smooth dragging).
    pub fn open(path: &str, max_dim: u32, tolerance_ms: u32) -> Result<Self> {
        let c = CString::new(path)?;
        let handle = unsafe { se_av_open(c.as_ptr(), max_dim as c_int, tolerance_ms as c_int) };
        if handle.is_null() {
            return Err(anyhow!("AVFoundation could not open {path}"));
        }
        Ok(Self { handle })
    }

    pub fn frame_at(&mut self, t: f64) -> Result<Frame> {
        let mut buf: *mut u8 = std::ptr::null_mut();
        let mut w: c_int = 0;
        let mut h: c_int = 0;
        let ok = unsafe { se_av_frame(self.handle, t.max(0.0), &mut buf, &mut w, &mut h) };
        if ok == 0 || buf.is_null() || w <= 0 || h <= 0 {
            return Err(anyhow!("AVFoundation frame decode failed at {t:.3}s"));
        }
        let size = (w as usize) * (h as usize) * 4;
        let rgba = unsafe { std::slice::from_raw_parts(buf, size) }.to_vec();
        unsafe { se_av_free(buf) };
        Ok(Frame {
            time: t,
            width: w as u32,
            height: h as u32,
            rgba,
        })
    }
}

impl Drop for AvDecoder {
    fn drop(&mut self) {
        unsafe { se_av_close(self.handle) };
    }
}

impl FrameDecoder for AvDecoder {
    fn frame_at(&mut self, t: f64) -> Result<Frame> {
        AvDecoder::frame_at(self, t)
    }
}

/// Sequential frame reader (AVAssetReader). Streams frames forward from a start
/// time at a few ms each — used for playback-like scrubbing.
pub struct AvReader {
    handle: *mut c_void,
}

unsafe impl Send for AvReader {}

impl AvReader {
    pub fn open(path: &str, start: f64, max_dim: u32) -> Result<Self> {
        let c = CString::new(path)?;
        let handle = unsafe { se_av_reader_open(c.as_ptr(), start.max(0.0), max_dim as c_int) };
        if handle.is_null() {
            return Err(anyhow!("AVAssetReader could not open {path}"));
        }
        Ok(Self { handle })
    }

    /// Next decoded frame in sequence (its `time` is the true presentation time),
    /// or None at end-of-stream / error.
    pub fn next(&mut self) -> Option<Frame> {
        let mut buf: *mut u8 = std::ptr::null_mut();
        let mut w: c_int = 0;
        let mut h: c_int = 0;
        let mut time: f64 = 0.0;
        let ok = unsafe { se_av_reader_next(self.handle, &mut buf, &mut w, &mut h, &mut time) };
        if ok == 0 || buf.is_null() || w <= 0 || h <= 0 {
            return None;
        }
        let size = (w as usize) * (h as usize) * 4;
        let rgba = unsafe { std::slice::from_raw_parts(buf, size) }.to_vec();
        unsafe { se_av_free(buf) };
        Some(Frame {
            time,
            width: w as u32,
            height: h as u32,
            rgba,
        })
    }
}

impl Drop for AvReader {
    fn drop(&mut self) {
        unsafe { se_av_reader_close(self.handle) };
    }
}
