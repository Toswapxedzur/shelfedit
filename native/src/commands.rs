//! Editor action layer — Rust port of `editor/commands.ts`. A single typed
//! vocabulary of edits; both the toolbar/inspector and (later) the AI agent go
//! through `apply_command`, so every button is one code path and trivially
//! undoable.

use crate::model::{ChromaKey, ColorGrade, Keyframe, MaskRect, TimelineData, Transform};
use crate::ops;

#[derive(Debug, Clone)]
pub enum Command {
    // structure
    Split { clip_id: String, at: f64 },
    Delete { clip_ids: Vec<String> },
    RippleDelete { clip_ids: Vec<String> },
    Duplicate { clip_ids: Vec<String> },
    MoveClip { clip_id: String, start: f64, track_id: Option<String> },
    TrimStart { clip_id: String, at: f64 },
    TrimEnd { clip_id: String, at: f64, source_max: Option<f64> },
    // layer / fades / audio
    SetOpacity { clip_ids: Vec<String>, opacity: f64 },
    SetFade { clip_ids: Vec<String>, fade_in: Option<f64>, fade_out: Option<f64> },
    SetVolume { clip_ids: Vec<String>, volume: f64 },
    SetAudioFade { clip_ids: Vec<String>, fade_in: Option<f64>, fade_out: Option<f64> },
    SetSpeed { clip_ids: Vec<String>, speed: f64 },
    // color
    SetColor { clip_ids: Vec<String>, brightness: Option<f64>, contrast: Option<f64>, saturation: Option<f64> },
    // transform
    SetScale { clip_ids: Vec<String>, scale: f64 },
    SetTransform { clip_ids: Vec<String>, transform: Transform },
    SetRotation { clip_ids: Vec<String>, degrees: f64 },
    RotateBy { clip_ids: Vec<String>, degrees: f64 },
    Nudge { clip_ids: Vec<String>, dx: f64, dy: f64 },
    ResetTransform { clip_ids: Vec<String> },
    FlipH { clip_ids: Vec<String> },
    FlipV { clip_ids: Vec<String> },
    SetFlip { clip_ids: Vec<String>, flip_h: Option<bool>, flip_v: Option<bool> },
    // crop / mask / chroma
    SetCrop { clip_ids: Vec<String>, crop: Option<MaskRect> },
    SetMask { clip_ids: Vec<String>, mask: Option<MaskRect> },
    SetChroma { clip_ids: Vec<String>, chroma: Option<ChromaKey> },
    // text
    SetText { clip_id: String, text: String },
    AddText { at: f64, track_id: Option<String>, text: Option<String>, x: Option<f64>, y: Option<f64> },
    // keyframes
    AddKeyframeAtPlayhead { clip_ids: Vec<String>, playhead: f64 },
    RemoveKeyframe { clip_id: String, t: f64 },
    // linking
    Link { clip_ids: Vec<String> },
    Unlink { clip_ids: Vec<String> },
    // tracks
    AddTrack { kind: String },
    RemoveTrack { track_id: String },
    MoveTrack { track_id: String, dir: i64 },
    SetTrackHidden { track_id: String, hidden: bool },
    SetTrackLocked { track_id: String, locked: bool },
}

fn merge_transform(el_transform: Option<Transform>, apply: impl FnOnce(&mut Transform)) -> Transform {
    let mut t = el_transform.unwrap_or_default();
    apply(&mut t);
    t
}

pub fn apply_command(data: &mut TimelineData, cmd: &Command) {
    match cmd {
        Command::Split { clip_id, at } => ops::split_clip(data, clip_id, *at),
        Command::Delete { clip_ids } => ops::delete_clips(data, clip_ids),
        Command::RippleDelete { clip_ids } => ops::ripple_delete(data, clip_ids),
        Command::Duplicate { clip_ids } => ops::duplicate_clips(data, clip_ids),
        Command::MoveClip { clip_id, start, track_id } => {
            ops::move_clip_group(data, clip_id, *start, track_id.as_deref())
        }
        Command::TrimStart { clip_id, at } => ops::trim_start(data, clip_id, *at),
        Command::TrimEnd { clip_id, at, source_max } => ops::trim_end(data, clip_id, *at, *source_max),

        Command::SetOpacity { clip_ids, opacity } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| e.opacity = Some(opacity.clamp(0.0, 1.0)));
            }
        }
        Command::SetFade { clip_ids, fade_in, fade_out } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| {
                    if let Some(v) = fade_in { e.fade_in = Some(v.max(0.0)); }
                    if let Some(v) = fade_out { e.fade_out = Some(v.max(0.0)); }
                });
            }
        }
        Command::SetVolume { clip_ids, volume } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| e.volume = Some(volume.clamp(0.0, 1.0)));
            }
        }
        Command::SetAudioFade { clip_ids, fade_in, fade_out } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| {
                    if let Some(v) = fade_in { e.audio_fade_in = Some(v.max(0.0)); }
                    if let Some(v) = fade_out { e.audio_fade_out = Some(v.max(0.0)); }
                });
            }
        }
        Command::SetSpeed { clip_ids, speed } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| e.speed = Some(speed.max(0.1)));
            }
        }
        Command::SetColor { clip_ids, brightness, contrast, saturation } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| {
                    let cur = e.color.unwrap_or_default();
                    e.color = Some(ColorGrade {
                        brightness: brightness.unwrap_or(cur.brightness),
                        contrast: contrast.unwrap_or(cur.contrast),
                        saturation: saturation.unwrap_or(cur.saturation),
                    });
                });
            }
        }
        Command::SetScale { clip_ids, scale } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| {
                    e.transform = Some(merge_transform(e.transform, |t| t.scale = scale.max(0.05)));
                });
            }
        }
        Command::SetTransform { clip_ids, transform } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| e.transform = Some(*transform));
            }
        }
        Command::SetRotation { clip_ids, degrees } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| {
                    e.transform = Some(merge_transform(e.transform, |t| t.rotation = *degrees));
                });
            }
        }
        Command::RotateBy { clip_ids, degrees } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| {
                    let cur = e.transform.unwrap_or_default().rotation;
                    e.transform = Some(merge_transform(e.transform, |t| t.rotation = cur + *degrees));
                });
            }
        }
        Command::Nudge { clip_ids, dx, dy } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| {
                    let cur = e.transform.unwrap_or_default();
                    e.transform = Some(merge_transform(e.transform, |t| {
                        t.x = cur.x + *dx;
                        t.y = cur.y + *dy;
                    }));
                });
            }
        }
        Command::ResetTransform { clip_ids } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| e.transform = Some(Transform::default()));
            }
        }
        Command::FlipH { clip_ids } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| e.flip_h = Some(!e.flip_h.unwrap_or(false)));
            }
        }
        Command::FlipV { clip_ids } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| e.flip_v = Some(!e.flip_v.unwrap_or(false)));
            }
        }
        Command::SetFlip { clip_ids, flip_h, flip_v } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| {
                    if let Some(v) = flip_h { e.flip_h = Some(*v); }
                    if let Some(v) = flip_v { e.flip_v = Some(*v); }
                });
            }
        }
        Command::SetCrop { clip_ids, crop } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| e.crop = *crop);
            }
        }
        Command::SetMask { clip_ids, mask } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| e.mask = *mask);
            }
        }
        Command::SetChroma { clip_ids, chroma } => {
            for id in clip_ids {
                ops::update_clip(data, id, |e| e.chroma = chroma.clone());
            }
        }
        Command::SetText { clip_id, text } => {
            ops::update_clip(data, clip_id, |e| e.text = Some(text.clone()));
        }
        Command::AddText { at, track_id, text, x, y } => {
            let tid = track_id
                .clone()
                .or_else(|| data.tracks.iter().find(|t| t.kind == "text").map(|t| t.id.clone()));
            if let Some(tid) = tid {
                let mut clip = ops::make_text_clip(text.as_deref().unwrap_or("New text"), *at);
                if x.is_some() || y.is_some() {
                    clip.transform = Some(Transform {
                        x: x.unwrap_or(0.0),
                        y: y.unwrap_or(0.0),
                        ..Transform::default()
                    });
                }
                ops::add_clip(data, &tid, clip);
            }
        }
        Command::AddKeyframeAtPlayhead { clip_ids, playhead } => {
            let ids = clip_ids.clone();
            for id in ids {
                let Some(el) = data.get(&id).cloned() else { continue };
                if el.is_audio() {
                    continue;
                }
                let dur = el.duration();
                let clt = (playhead - el.timeline_start).clamp(0.0, dur);
                let p = ops::resolve_props(&el, clt, dur);
                ops::add_keyframe(
                    data,
                    &id,
                    Keyframe {
                        t: clt,
                        opacity: Some(p.opacity),
                        scale: Some(p.scale),
                        x: Some(p.x),
                        y: Some(p.y),
                        rotation: Some(p.rotation),
                    },
                );
            }
        }
        Command::RemoveKeyframe { clip_id, t } => ops::remove_keyframe(data, clip_id, *t),
        Command::Link { clip_ids } => ops::link_clips(data, clip_ids),
        Command::Unlink { clip_ids } => ops::unlink_clips(data, clip_ids),
        Command::AddTrack { kind } => ops::add_track(data, kind, 0),
        Command::RemoveTrack { track_id } => ops::remove_track(data, track_id),
        Command::MoveTrack { track_id, dir } => ops::move_track(data, track_id, *dir),
        Command::SetTrackHidden { track_id, hidden } => {
            ops::set_track_flags(data, track_id, Some(*hidden), None)
        }
        Command::SetTrackLocked { track_id, locked } => {
            ops::set_track_flags(data, track_id, None, Some(*locked))
        }
    }
}
