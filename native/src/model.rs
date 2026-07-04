//! Timeline data model — mirrors the legacy JSON stored in `timelines.data_json`.
//! Only the fields Slice 1 needs are typed; the rest are ignored on parse.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct TimelineData {
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub canvas: Option<Canvas>,
    #[serde(default)]
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Canvas {
    #[serde(default = "default_w")]
    pub width: u32,
    #[serde(default = "default_h")]
    pub height: u32,
    #[serde(default = "default_fps")]
    pub fps: u32,
}

fn default_w() -> u32 {
    1920
}
fn default_h() -> u32 {
    1080
}
fn default_fps() -> u32 {
    30
}

#[derive(Debug, Clone, Deserialize)]
pub struct Track {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub elements: Vec<Element>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Element {
    #[serde(default)]
    pub media_id: Option<String>,
    #[serde(default)]
    pub source_start: f64,
    #[serde(default)]
    pub source_end: Option<f64>,
    #[serde(default)]
    pub timeline_start: f64,
}

impl TimelineData {
    /// The first video clip's media id, if any.
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
