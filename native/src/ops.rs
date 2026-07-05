//! Pure timeline operations — Rust port of the legacy `editor/timeline.ts`.
//! All mutate the document in place; the editor clones before applying so undo
//! is just "restore the previous document".

use std::time::{SystemTime, UNIX_EPOCH};

use crate::model::{
    ColorGrade, Element, Keyframe, MaskRect, TimelineData, Track, Transform, DEFAULT_TEXT_DUR,
    MIN_CLIP,
};

pub fn new_id(prefix: &str) -> String {
    use std::cell::Cell;
    thread_local!(static COUNTER: Cell<u64> = const { Cell::new(0) });
    let n = COUNTER.with(|c| {
        let v = c.get().wrapping_add(1);
        c.set(v);
        v
    });
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    format!("{prefix}_{:x}{:x}", nanos, n)
}

pub fn make_group_id() -> String {
    new_id("grp")
}

fn base_element(ty: &str) -> Element {
    Element {
        id: new_id("clip"),
        ty: ty.to_string(),
        media_id: None,
        source_start: None,
        source_end: None,
        timeline_start: 0.0,
        timeline_end: None,
        text: None,
        color: None,
        opacity: None,
        transform: None,
        fade_in: None,
        fade_out: None,
        chroma: None,
        mask: None,
        crop: None,
        flip_h: None,
        flip_v: None,
        speed: None,
        keyframes: None,
        volume: None,
        audio_fade_in: None,
        audio_fade_out: None,
        group_id: None,
        extra: Default::default(),
    }
}

pub fn make_video_clip(media_id: &str, duration: f64, timeline_start: f64) -> Element {
    let mut e = base_element("video");
    e.media_id = Some(media_id.to_string());
    e.source_start = Some(0.0);
    e.source_end = Some(duration);
    e.timeline_start = timeline_start;
    e.color = Some(ColorGrade::default());
    e
}

pub fn make_audio_clip(media_id: &str, duration: f64, timeline_start: f64) -> Element {
    let mut e = base_element("audio");
    e.media_id = Some(media_id.to_string());
    e.source_start = Some(0.0);
    e.source_end = Some(duration);
    e.timeline_start = timeline_start;
    e
}

pub fn make_text_clip(text: &str, timeline_start: f64) -> Element {
    let mut e = base_element("text");
    e.text = Some(text.to_string());
    e.timeline_start = timeline_start;
    e.timeline_end = Some(timeline_start + DEFAULT_TEXT_DUR);
    e
}

pub fn kind_compatible(el_type: &str, track_kind: &str) -> bool {
    el_type == track_kind
}

fn el_index(data: &TimelineData, clip_id: &str) -> Option<(usize, usize)> {
    data.find(clip_id)
}

pub fn move_clip_group(
    data: &mut TimelineData,
    clip_id: &str,
    new_start: f64,
    target_track_id: Option<&str>,
) {
    let Some((ti, ei)) = el_index(data, clip_id) else {
        return;
    };
    let cur_start = data.tracks[ti].elements[ei].timeline_start;
    let gid = data.tracks[ti].elements[ei].group_id.clone();

    // Collect group member (track,elem) indices.
    let mut members: Vec<(usize, usize)> = Vec::new();
    if let Some(g) = &gid {
        for (t, tr) in data.tracks.iter().enumerate() {
            for (e, el) in tr.elements.iter().enumerate() {
                if el.group_id.as_deref() == Some(g.as_str()) {
                    members.push((t, e));
                }
            }
        }
    } else {
        members.push((ti, ei));
    }

    let raw_delta = new_start.max(0.0) - cur_start;
    let min_start = members
        .iter()
        .map(|&(t, e)| data.tracks[t].elements[e].timeline_start)
        .fold(f64::INFINITY, f64::min);
    let delta = raw_delta.max(-min_start);

    for &(t, e) in &members {
        let el = &mut data.tracks[t].elements[e];
        el.timeline_start = (el.timeline_start + delta).max(0.0);
        if el.is_text() {
            if let Some(te) = el.timeline_end {
                el.timeline_end = Some(te + delta);
            }
        }
    }

    // Re-home the primary clip onto another compatible track.
    if let Some(target_id) = target_track_id {
        if target_id != data.tracks[ti].id {
            let el_type = data.tracks[ti].elements[ei].ty.clone();
            if let Some(tj) = data.tracks.iter().position(|t| t.id == target_id) {
                if kind_compatible(&el_type, &data.tracks[tj].kind) {
                    let el = data.tracks[ti].elements.remove(ei);
                    data.tracks[tj].elements.push(el);
                    sort_track(&mut data.tracks[tj]);
                }
            }
        }
    }
    data.recompute_duration();
}

fn sort_track(track: &mut Track) {
    track
        .elements
        .sort_by(|a, b| a.timeline_start.partial_cmp(&b.timeline_start).unwrap());
}

pub fn trim_start(data: &mut TimelineData, clip_id: &str, new_start: f64) {
    let Some((ti, ei)) = el_index(data, clip_id) else {
        return;
    };
    let el = &mut data.tracks[ti].elements[ei];
    let start = new_start.max(0.0);
    if el.is_text() {
        let end = el.timeline_end.unwrap_or(el.timeline_start + DEFAULT_TEXT_DUR);
        el.timeline_start = start.min(end - MIN_CLIP);
        data.recompute_duration();
        return;
    }
    let delta = start - el.timeline_start;
    let src_start = el.source_start.unwrap_or(0.0) + delta;
    let clamped = src_start
        .max(0.0)
        .min(el.source_end.unwrap_or(0.0) - MIN_CLIP);
    let actual_delta = clamped - el.source_start.unwrap_or(0.0);
    el.source_start = Some(clamped);
    el.timeline_start += actual_delta;
    data.recompute_duration();
}

pub fn trim_end(data: &mut TimelineData, clip_id: &str, new_end: f64, source_max: Option<f64>) {
    let Some((ti, ei)) = el_index(data, clip_id) else {
        return;
    };
    let el = &mut data.tracks[ti].elements[ei];
    if el.is_text() {
        el.timeline_end = Some((el.timeline_start + MIN_CLIP).max(new_end));
        data.recompute_duration();
        return;
    }
    let desired = (new_end - el.timeline_start).max(MIN_CLIP);
    let mut src_end = el.source_start.unwrap_or(0.0) + desired;
    if let Some(m) = source_max {
        src_end = src_end.min(m);
    }
    el.source_end = Some((el.source_start.unwrap_or(0.0) + MIN_CLIP).max(src_end));
    data.recompute_duration();
}

pub fn split_clip(data: &mut TimelineData, clip_id: &str, at: f64) {
    let Some((ti, ei)) = el_index(data, clip_id) else {
        return;
    };
    let (dur, ts) = {
        let el = &data.tracks[ti].elements[ei];
        (el.duration(), el.timeline_start)
    };
    let offset = at - ts;
    if offset <= MIN_CLIP || offset >= dur - MIN_CLIP {
        return;
    }
    let mut right = data.tracks[ti].elements[ei].clone();
    right.id = new_id("clip");
    right.timeline_start = at;
    if right.is_text() {
        data.tracks[ti].elements[ei].timeline_end = Some(at);
    } else {
        let split_src = data.tracks[ti].elements[ei].source_start.unwrap_or(0.0) + offset;
        right.source_start = Some(split_src);
        data.tracks[ti].elements[ei].source_end = Some(split_src);
    }
    data.tracks[ti].elements.insert(ei + 1, right);
    data.recompute_duration();
}

pub fn delete_clips(data: &mut TimelineData, clip_ids: &[String]) {
    let set: std::collections::HashSet<&str> = clip_ids.iter().map(|s| s.as_str()).collect();
    for t in &mut data.tracks {
        t.elements.retain(|e| !set.contains(e.id.as_str()));
    }
    data.recompute_duration();
}

pub fn ripple_delete(data: &mut TimelineData, clip_ids: &[String]) {
    let set: std::collections::HashSet<&str> = clip_ids.iter().map(|s| s.as_str()).collect();
    if set.is_empty() {
        return;
    }
    for track in &mut data.tracks {
        let removed: Vec<Element> = track
            .elements
            .iter()
            .filter(|e| set.contains(e.id.as_str()))
            .cloned()
            .collect();
        if removed.is_empty() {
            continue;
        }
        let mut remaining: Vec<Element> = track
            .elements
            .iter()
            .filter(|e| !set.contains(e.id.as_str()))
            .cloned()
            .collect();
        for el in &mut remaining {
            let mut shift = 0.0;
            for r in &removed {
                if r.end() <= el.timeline_start + 1e-6 {
                    shift += r.duration();
                }
            }
            if shift > 0.0 {
                el.timeline_start = (el.timeline_start - shift).max(0.0);
                if el.is_text() {
                    if let Some(te) = el.timeline_end {
                        el.timeline_end = Some(te - shift);
                    }
                }
            }
        }
        remaining.sort_by(|a, b| a.timeline_start.partial_cmp(&b.timeline_start).unwrap());
        track.elements = remaining;
    }
    data.recompute_duration();
}

pub fn duplicate_clips(data: &mut TimelineData, clip_ids: &[String]) {
    let set: std::collections::HashSet<&str> = clip_ids.iter().map(|s| s.as_str()).collect();
    if set.is_empty() {
        return;
    }
    for track in &mut data.tracks {
        let originals: Vec<Element> = track
            .elements
            .iter()
            .filter(|e| set.contains(e.id.as_str()))
            .cloned()
            .collect();
        for el in originals {
            let mut copy = el.clone();
            copy.id = new_id("clip");
            let dur = el.duration();
            copy.timeline_start = el.end();
            if copy.is_text() && copy.timeline_end.is_some() {
                copy.timeline_end = Some(copy.timeline_start + dur);
            }
            track.elements.push(copy);
        }
        sort_track(track);
    }
    data.recompute_duration();
}

pub fn add_clip(data: &mut TimelineData, track_id: &str, el: Element) {
    if let Some(t) = data.tracks.iter_mut().find(|t| t.id == track_id) {
        t.elements.push(el);
        sort_track(t);
    }
    data.recompute_duration();
}

pub fn update_clip(data: &mut TimelineData, clip_id: &str, f: impl FnOnce(&mut Element)) {
    if let Some((ti, ei)) = el_index(data, clip_id) {
        f(&mut data.tracks[ti].elements[ei]);
    }
}

pub fn add_keyframe(data: &mut TimelineData, clip_id: &str, kf: Keyframe) {
    update_clip(data, clip_id, |el| {
        let mut keys = el.keyframes.take().unwrap_or_default();
        if let Some(idx) = keys.iter().position(|k| (k.t - kf.t).abs() < 0.01) {
            keys[idx] = kf;
        } else {
            keys.push(kf);
        }
        keys.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
        el.keyframes = Some(keys);
    });
}

pub fn remove_keyframe(data: &mut TimelineData, clip_id: &str, t: f64) {
    update_clip(data, clip_id, |el| {
        if let Some(mut keys) = el.keyframes.take() {
            keys.retain(|k| (k.t - t).abs() >= 0.01);
            el.keyframes = if keys.is_empty() { None } else { Some(keys) };
        }
    });
}

pub fn link_clips(data: &mut TimelineData, clip_ids: &[String]) {
    if clip_ids.len() < 2 {
        return;
    }
    let gid = new_id("grp");
    let set: std::collections::HashSet<&str> = clip_ids.iter().map(|s| s.as_str()).collect();
    for t in &mut data.tracks {
        for e in &mut t.elements {
            if set.contains(e.id.as_str()) {
                e.group_id = Some(gid.clone());
            }
        }
    }
}

pub fn unlink_clips(data: &mut TimelineData, clip_ids: &[String]) {
    let set: std::collections::HashSet<&str> = clip_ids.iter().map(|s| s.as_str()).collect();
    let mut groups: std::collections::HashSet<String> = std::collections::HashSet::new();
    for t in &data.tracks {
        for e in &t.elements {
            if set.contains(e.id.as_str()) {
                if let Some(g) = &e.group_id {
                    groups.insert(g.clone());
                }
            }
        }
    }
    for t in &mut data.tracks {
        for e in &mut t.elements {
            if let Some(g) = &e.group_id {
                if groups.contains(g) {
                    e.group_id = None;
                }
            }
        }
    }
}

pub fn add_track(data: &mut TimelineData, kind: &str, at_index: usize) {
    let count = data.tracks.iter().filter(|t| t.kind == kind).count() + 1;
    let name = match kind {
        "video" => format!("Video {count}"),
        "audio" => format!("Audio {count}"),
        _ => format!("Text {count}"),
    };
    let track = Track {
        id: new_id("trk"),
        kind: kind.to_string(),
        name,
        order: 0,
        elements: vec![],
        muted: None,
        volume: None,
        hidden: None,
        locked: None,
    };
    let i = at_index.min(data.tracks.len());
    data.tracks.insert(i, track);
    renumber(data);
}

pub fn remove_track(data: &mut TimelineData, track_id: &str) {
    data.tracks.retain(|t| t.id != track_id);
    renumber(data);
    data.recompute_duration();
}

pub fn move_track(data: &mut TimelineData, track_id: &str, dir: i64) {
    let Some(i) = data.tracks.iter().position(|t| t.id == track_id) else {
        return;
    };
    let j = i as i64 + dir;
    if j < 0 || j as usize >= data.tracks.len() {
        return;
    }
    data.tracks.swap(i, j as usize);
    renumber(data);
}

pub fn set_track_flags(
    data: &mut TimelineData,
    track_id: &str,
    hidden: Option<bool>,
    locked: Option<bool>,
) {
    if let Some(t) = data.tracks.iter_mut().find(|t| t.id == track_id) {
        if let Some(h) = hidden {
            t.hidden = Some(h);
        }
        if let Some(l) = locked {
            t.locked = Some(l);
        }
    }
}

fn renumber(data: &mut TimelineData) {
    for (i, t) in data.tracks.iter_mut().enumerate() {
        t.order = i as i64;
    }
}

// ---- effect resolution (port of effects.ts) --------------------------------

pub struct ResolvedProps {
    pub opacity: f64,
    pub scale: f64,
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

fn sample_keyframed(
    keys: &[Keyframe],
    get: impl Fn(&Keyframe) -> Option<f64>,
    lt: f64,
    fallback: f64,
) -> f64 {
    let mut defined: Vec<(f64, f64)> = keys.iter().filter_map(|k| get(k).map(|v| (k.t, v))).collect();
    if defined.is_empty() {
        return fallback;
    }
    defined.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    if lt <= defined[0].0 {
        return defined[0].1;
    }
    let last = *defined.last().unwrap();
    if lt >= last.0 {
        return last.1;
    }
    for w in defined.windows(2) {
        let (at, av) = w[0];
        let (bt, bv) = w[1];
        if lt >= at && lt <= bt {
            let span = (bt - at).max(1e-9);
            let f = (lt - at) / span;
            return av + (bv - av) * f;
        }
    }
    fallback
}

fn fade_multiplier(lt: f64, duration: f64, fade_in: Option<f64>, fade_out: Option<f64>) -> f64 {
    let mut m = 1.0;
    if let Some(fi) = fade_in {
        if fi > 0.0 && lt < fi {
            m *= lt / fi;
        }
    }
    if let Some(fo) = fade_out {
        if fo > 0.0 && lt > duration - fo {
            m *= ((duration - lt) / fo).max(0.0);
        }
    }
    clamp01(m)
}

pub fn resolve_props(el: &Element, local_time: f64, duration: f64) -> ResolvedProps {
    let t = el.transform_or_default();
    let base_opacity = el.opacity.unwrap_or(1.0);
    let empty = vec![];
    let keys = el.keyframes.as_ref().unwrap_or(&empty);
    let opacity = sample_keyframed(keys, |k| k.opacity, local_time, base_opacity);
    let scale = sample_keyframed(keys, |k| k.scale, local_time, t.scale);
    let x = sample_keyframed(keys, |k| k.x, local_time, t.x);
    let y = sample_keyframed(keys, |k| k.y, local_time, t.y);
    let rotation = sample_keyframed(keys, |k| k.rotation, local_time, t.rotation);
    let fade = fade_multiplier(local_time, duration, el.fade_in, el.fade_out);
    ResolvedProps {
        opacity: clamp01(opacity * fade),
        scale,
        x,
        y,
        rotation,
    }
}

pub fn resolve_audio_gain(el: &Element, local_time: f64, duration: f64) -> f64 {
    let base = el.volume.unwrap_or(1.0);
    let fade = fade_multiplier(local_time, duration, el.audio_fade_in, el.audio_fade_out);
    clamp01(base * fade)
}

// Used by the crop inspector default and mask default.
pub fn default_crop() -> MaskRect {
    MaskRect {
        x: 0.1,
        y: 0.1,
        w: 0.8,
        h: 0.8,
    }
}

pub fn default_mask() -> MaskRect {
    MaskRect {
        x: 0.2,
        y: 0.2,
        w: 0.6,
        h: 0.6,
    }
}

pub fn neutral_transform() -> Transform {
    Transform::default()
}
