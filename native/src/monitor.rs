//! Timeline playback monitor. Wraps the Slice-1 hardware `Player` and maps the
//! timeline clock to the underlying source clips: it plays the top-most active
//! video clip, re-pointing the decoder (and audio) when the playhead crosses
//! into a different clip/source. The preview panel then draws that frame with
//! the clip's transform/opacity/crop, plus any active text overlays on top.
//!
//! Full multi-layer live compositing (simultaneous PiP video tracks) is a later
//! slice; single video track and sequential cuts — the common case — play here.

use std::collections::HashMap;

use crate::db::MediaInfo;
use crate::decode::Frame;
use crate::model::{Element, TimelineData};
use crate::player::Player;

pub struct Monitor {
    media: HashMap<String, MediaInfo>,
    fps: u32,
    duration: f64,

    player: Option<Player>,
    clip_id: Option<String>,
    clip_timeline_start: f64,
    clip_source_start: f64,
    cur_media_path: String,

    playing: bool,
    paused_timeline: f64,
}

/// The top-most active video clip covering timeline time `t` on a visible track.
pub fn active_video_clip<'a>(data: &'a TimelineData, t: f64) -> Option<&'a Element> {
    let mut chosen: Option<&Element> = None;
    for track in &data.tracks {
        if track.kind != "video" || track.is_hidden() {
            continue;
        }
        for el in &track.elements {
            if el.media_id.is_some() && t >= el.timeline_start && t < el.end() {
                chosen = Some(el); // last in array order = top-most
            }
        }
    }
    chosen
}

/// Active text clips at time `t` on visible text tracks.
pub fn active_text_clips<'a>(data: &'a TimelineData, t: f64) -> Vec<&'a Element> {
    let mut out = vec![];
    for track in &data.tracks {
        if track.kind != "text" || track.is_hidden() {
            continue;
        }
        for el in &track.elements {
            if t >= el.timeline_start && t < el.end() {
                out.push(el);
            }
        }
    }
    out
}

impl Monitor {
    pub fn new(media: HashMap<String, MediaInfo>, fps: u32, duration: f64) -> Self {
        Monitor {
            media,
            fps: fps.max(1),
            duration,
            player: None,
            clip_id: None,
            clip_timeline_start: 0.0,
            clip_source_start: 0.0,
            cur_media_path: String::new(),
            playing: false,
            paused_timeline: 0.0,
        }
    }

    pub fn set_duration(&mut self, d: f64) {
        self.duration = d;
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    pub fn timeline_clock(&self) -> f64 {
        if !self.playing {
            return self.paused_timeline;
        }
        if let Some(p) = &self.player {
            let tl = self.clip_timeline_start + (p.clock() - self.clip_source_start);
            return tl.clamp(0.0, self.duration.max(0.0));
        }
        self.paused_timeline
    }

    pub fn current_frame(&self) -> Option<&Frame> {
        self.player.as_ref().and_then(|p| p.cur.as_ref())
    }

    pub fn cur_version(&self) -> u64 {
        self.player.as_ref().map(|p| p.cur_version).unwrap_or(0)
    }

    /// (Re)point the decoder at the clip covering `timeline_t`, if any.
    fn point_to(&mut self, data: &TimelineData, timeline_t: f64, play: bool) {
        let clip = active_video_clip(data, timeline_t).cloned();
        match clip {
            Some(el) => {
                let mid = el.media_id.clone().unwrap_or_default();
                let Some(mi) = self.media.get(&mid).cloned() else {
                    self.player = None;
                    self.clip_id = None;
                    return;
                };
                let source_start = el.source_start.unwrap_or(0.0);
                let source_t = source_start + (timeline_t - el.timeline_start);
                // Rebuild the player only when the underlying file changes.
                if self.player.is_none() || self.cur_media_path != mi.path {
                    let dur = if mi.duration > 0.0 { mi.duration } else { self.duration };
                    self.player = Some(Player::new(mi.path.clone(), mi.width, mi.height, dur, self.fps));
                    self.cur_media_path = mi.path.clone();
                }
                self.clip_id = Some(el.id.clone());
                self.clip_timeline_start = el.timeline_start;
                self.clip_source_start = source_start;
                if let Some(p) = &mut self.player {
                    if play {
                        p.play_from(source_t);
                    } else {
                        p.seek(source_t);
                    }
                }
            }
            None => {
                // Gap: keep the last frame, stop decoding.
                if let Some(p) = &mut self.player {
                    p.pause();
                }
                self.clip_id = None;
            }
        }
    }

    pub fn seek(&mut self, data: &TimelineData, timeline_t: f64) {
        let t = timeline_t.clamp(0.0, self.duration.max(0.0));
        self.paused_timeline = t;
        self.playing = false;
        self.point_to(data, t, false);
    }

    pub fn play(&mut self, data: &TimelineData) {
        if self.playing {
            return;
        }
        self.playing = true;
        self.point_to(data, self.paused_timeline, true);
    }

    pub fn pause(&mut self) {
        if !self.playing {
            return;
        }
        self.paused_timeline = self.timeline_clock();
        self.playing = false;
        if let Some(p) = &mut self.player {
            p.pause();
        }
    }

    pub fn toggle(&mut self, data: &TimelineData) {
        if self.playing {
            self.pause();
        } else {
            self.play(data);
        }
    }

    /// Drive the current active clip; returns true while actively playing.
    pub fn update(&mut self, data: &TimelineData) -> bool {
        if let Some(p) = &mut self.player {
            p.update();
        }
        if !self.playing {
            return false;
        }
        let t = self.timeline_clock();
        if t >= self.duration - 1e-3 {
            self.pause();
            self.paused_timeline = self.duration;
            return false;
        }
        // Did we cross out of the current clip? Re-point.
        let still = self
            .clip_id
            .as_ref()
            .and_then(|id| data.get(id))
            .map(|el| t >= el.timeline_start && t < el.end())
            .unwrap_or(false);
        if !still {
            self.point_to(data, t, true);
        }
        true
    }

    pub fn stats(&self) -> String {
        format!(
            "clip={} tl_start={:.2} src_start={:.2}",
            self.clip_id.as_deref().unwrap_or("—"),
            self.clip_timeline_start,
            self.clip_source_start
        )
    }
}
