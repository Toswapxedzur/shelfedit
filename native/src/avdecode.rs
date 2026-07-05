//! Safe Rust wrapper around the AVFoundation frame-decoder bridge (`av_decode.m`).
//! macOS only. A persistent, hardware-accelerated decoder that can return any
//! frame at any time — reused across seeks so scrubbing is near-instant.

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};

use anyhow::{anyhow, Result};

use crate::decode::{Frame, FrameDecoder};

extern "C" {
    fn se_av_open(path: *const c_char, max_dim: c_int) -> *mut c_void;
    fn se_av_frame(
        handle: *mut c_void,
        t: f64,
        out_rgba: *mut *mut u8,
        out_w: *mut c_int,
        out_h: *mut c_int,
    ) -> c_int;
    fn se_av_free(buf: *mut u8);
    fn se_av_close(handle: *mut c_void);
}

pub struct AvDecoder {
    handle: *mut c_void,
}

// The underlying AVAssetImageGenerator is safe to use from a single worker
// thread; we never share the handle across threads without ownership transfer.
unsafe impl Send for AvDecoder {}

impl AvDecoder {
    pub fn open(path: &str, max_dim: u32) -> Result<Self> {
        let c = CString::new(path)?;
        let handle = unsafe { se_av_open(c.as_ptr(), max_dim as c_int) };
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
