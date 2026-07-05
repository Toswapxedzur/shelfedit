//! Timeline data model — full-fidelity port of the legacy `timelines.data_json`
//! shape (see frontend `api/client.ts`). Round-trips exactly (unknown fields are
//! preserved via `extra`) so the frozen legacy app can still read what we save.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MIN_CLIP: f64 = 0.1;
pub const DEFAULT_TEXT_DUR: f64 = 3.0;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TimelineData {
    #[serde(default)]
    pub duration: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas: Option<Canvas>,
    #[serde(default)]
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Canvas {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

impl Default for Canvas {
    fn default() -> Self {
        Canvas {
            width: 1920,
            height: 1080,
            fps: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    pub kind: String, // "video" | "audio" | "text"
    pub name: String,
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub elements: Vec<Element>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Element {
    pub id: String,
    #[serde(rename = "type")]
    pub ty: String, // "video" | "audio" | "text"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_start: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_end: Option<f64>,
    pub timeline_start: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline_end: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<ColorGrade>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<Transform>,
    #[serde(rename = "fadeIn", default, skip_serializing_if = "Option::is_none")]
    pub fade_in: Option<f64>,
    #[serde(rename = "fadeOut", default, skip_serializing_if = "Option::is_none")]
    pub fade_out: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chroma: Option<ChromaKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask: Option<MaskRect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<MaskRect>,
    #[serde(rename = "flipH", default, skip_serializing_if = "Option::is_none")]
    pub flip_h: Option<bool>,
    #[serde(rename = "flipV", default, skip_serializing_if = "Option::is_none")]
    pub flip_v: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyframes: Option<Vec<Keyframe>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(rename = "audioFadeIn", default, skip_serializing_if = "Option::is_none")]
    pub audio_fade_in: Option<f64>,
    #[serde(rename = "audioFadeOut", default, skip_serializing_if = "Option::is_none")]
    pub audio_fade_out: Option<f64>,
    #[serde(rename = "groupId", default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,

    /// Any fields we don't model are preserved verbatim on save.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ColorGrade {
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
}
impl Default for ColorGrade {
    fn default() -> Self {
        ColorGrade {
            brightness: 1.0,
            contrast: 1.0,
            saturation: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Transform {
    pub scale: f64,
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
}
impl Default for Transform {
    fn default() -> Self {
        Transform {
            scale: 1.0,
            x: 0.0,
            y: 0.0,
            rotation: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChromaKey {
    pub enabled: bool,
    pub color: String,
    pub similarity: f64,
    pub smoothness: f64,
}
impl Default for ChromaKey {
    fn default() -> Self {
        ChromaKey {
            enabled: true,
            color: "#00ff00".to_string(),
            similarity: 0.4,
            smoothness: 0.12,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct MaskRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Keyframe {
    pub t: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
}

// ---- helpers ---------------------------------------------------------------

impl Element {
    pub fn is_video(&self) -> bool {
        self.ty == "video"
    }
    pub fn is_audio(&self) -> bool {
        self.ty == "audio"
    }
    pub fn is_text(&self) -> bool {
        self.ty == "text"
    }

    pub fn duration(&self) -> f64 {
        if self.is_text() {
            let end = self
                .timeline_end
                .unwrap_or(self.timeline_start + DEFAULT_TEXT_DUR);
            (end - self.timeline_start).max(MIN_CLIP)
        } else {
            ((self.source_end.unwrap_or(0.0)) - (self.source_start.unwrap_or(0.0))).max(MIN_CLIP)
        }
    }

    pub fn end(&self) -> f64 {
        self.timeline_start + self.duration()
    }

    pub fn transform_or_default(&self) -> Transform {
        self.transform.unwrap_or_default()
    }
}

impl Track {
    pub fn is_hidden(&self) -> bool {
        self.hidden.unwrap_or(false)
    }
    pub fn is_locked(&self) -> bool {
        self.locked.unwrap_or(false)
    }
}

impl TimelineData {
    pub fn compute_duration(&self) -> f64 {
        let mut max = 0.0_f64;
        for t in &self.tracks {
            for e in &t.elements {
                max = max.max(e.end());
            }
        }
        max
    }

    pub fn recompute_duration(&mut self) {
        self.duration = self.compute_duration();
    }

    pub fn canvas_or_default(&self) -> Canvas {
        self.canvas.clone().unwrap_or_default()
    }

    /// Locate a clip by id, returning (track index, element index).
    pub fn find(&self, clip_id: &str) -> Option<(usize, usize)> {
        for (ti, t) in self.tracks.iter().enumerate() {
            for (ei, e) in t.elements.iter().enumerate() {
                if e.id == clip_id {
                    return Some((ti, ei));
                }
            }
        }
        None
    }

    pub fn get(&self, clip_id: &str) -> Option<&Element> {
        self.find(clip_id).map(|(t, e)| &self.tracks[t].elements[e])
    }

    /// All clip ids that share a magnet group with `clip_id` (including itself).
    pub fn linked_ids(&self, clip_id: &str) -> Vec<String> {
        let Some(el) = self.get(clip_id) else {
            return vec![];
        };
        match &el.group_id {
            None => vec![clip_id.to_string()],
            Some(gid) => {
                let mut ids = vec![];
                for t in &self.tracks {
                    for e in &t.elements {
                        if e.group_id.as_deref() == Some(gid.as_str()) {
                            ids.push(e.id.clone());
                        }
                    }
                }
                ids
            }
        }
    }

    /// First video clip's media id (used by the Slice-1 monitor path).
    pub fn first_video_media_id(&self) -> Option<String> {
        for t in &self.tracks {
            if t.kind == "video" {
                for e in &t.elements {
                    if let Some(m) = &e.media_id {
                        return Some(m.clone());
                    }
                }
            }
        }
        None
    }
}
