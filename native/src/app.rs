//! egui editor UI — Slice 2. Mirrors the legacy layout: top bar, mode/tool
//! strip, left inspector, center GPU preview, bottom timeline, transport.

use eframe::egui;
use egui::{
    epaint::Vertex, Align2, Color32, FontId, Mesh, Pos2, Rect, Sense, Shape, Stroke, TextureId,
    Vec2,
};

use crate::commands::Command;
use crate::db;
use crate::editor::{Editor, Mode};
use crate::model::{ChromaKey, MaskRect, TimelineData, Transform};
use crate::monitor::{active_text_clips, active_video_clip, Monitor};
use crate::ops;

const HEADER_W: f32 = 150.0;
const RULER_H: f32 = 22.0;
const TRACK_H: f32 = 56.0;

#[derive(Clone)]
enum DragKind {
    Move,
    TrimStart,
    TrimEnd,
}

struct ClipDrag {
    clip_id: String,
    kind: DragKind,
    before: TimelineData,
    grab_dt: f64, // pointer_time - clip.timeline_start at grab
}

pub struct EditorApp {
    editor: Option<Editor>,
    monitor: Option<Monitor>,
    load_error: Option<String>,

    video_tex: Option<egui::TextureHandle>,
    tex_version: u64,

    drag: Option<ClipDrag>,
    scrubbing: bool,
}

impl EditorApp {
    pub fn new() -> Self {
        match db::load_best() {
            Ok(lp) => {
                let fps = lp.timeline.canvas_or_default().fps;
                let dur = lp.timeline.duration;
                let media = lp.media.clone();
                let editor = Editor::from_loaded(lp);
                let mut monitor = Monitor::new(media, fps, dur);
                monitor.seek(&editor.data, 0.0);
                Self {
                    editor: Some(editor),
                    monitor: Some(monitor),
                    load_error: None,
                    video_tex: None,
                    tex_version: u64::MAX,
                    drag: None,
                    scrubbing: false,
                }
            }
            Err(e) => Self {
                editor: None,
                monitor: None,
                load_error: Some(e.to_string()),
                video_tex: None,
                tex_version: u64::MAX,
                drag: None,
                scrubbing: false,
            },
        }
    }

    fn upload_texture(&mut self, ctx: &egui::Context) {
        let Some(monitor) = &self.monitor else { return };
        if monitor.cur_version() == self.tex_version {
            return;
        }
        let Some(frame) = monitor.current_frame() else { return };
        let image = egui::ColorImage::from_rgba_unmultiplied(
            [frame.width as usize, frame.height as usize],
            &frame.rgba,
        );
        match &mut self.video_tex {
            Some(t) => t.set(image, egui::TextureOptions::LINEAR),
            None => {
                self.video_tex =
                    Some(ctx.load_texture("preview", image, egui::TextureOptions::LINEAR))
            }
        }
        self.tex_version = monitor.cur_version();
    }
}

impl eframe::App for EditorApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let (Some(editor), Some(monitor)) = (self.editor.as_mut(), self.monitor.as_mut()) else {
            egui::CentralPanel::default().show(ctx, |ui| {
                ui.centered_and_justified(|ui| {
                    ui.label(
                        self.load_error
                            .clone()
                            .unwrap_or_else(|| "No project".into()),
                    );
                });
            });
            return;
        };

        editor.maybe_autosave();
        let playing = monitor.update(&editor.data);
        if playing {
            editor.playhead = monitor.timeline_clock();
        }
        // (immutable borrows end) — upload texture next.
        self.upload_texture(ctx);
        Self::handle_keyboard(ctx, self.editor.as_mut().unwrap(), self.monitor.as_mut().unwrap());

        let tex_id = self.video_tex.as_ref().map(|t| t.id());

        // Panels (re-borrow through options).
        let editor = self.editor.as_mut().unwrap();
        let monitor = self.monitor.as_mut().unwrap();

        egui::TopBottomPanel::top("topbar").show(ctx, |ui| {
            Self::topbar_ui(ui, editor, monitor);
        });
        egui::TopBottomPanel::top("tools").show(ctx, |ui| {
            Self::tools_ui(ui, editor);
        });
        egui::SidePanel::left("inspector")
            .resizable(true)
            .default_width(280.0)
            .width_range(220.0..=460.0)
            .show(ctx, |ui| {
                Self::inspector_ui(ui, editor);
            });
        egui::TopBottomPanel::bottom("timeline")
            .resizable(true)
            .default_height(320.0)
            .height_range(180.0..=680.0)
            .show(ctx, |ui| {
                Self::timeline_ui(ui, editor, monitor, &mut self.drag, &mut self.scrubbing);
            });
        egui::CentralPanel::default().show(ctx, |ui| {
            Self::preview_ui(ui, editor, monitor, tex_id);
        });

        ctx.request_repaint_after(std::time::Duration::from_millis(if playing { 8 } else { 33 }));
    }
}

impl EditorApp {
    // ---- keyboard ----------------------------------------------------------
    fn handle_keyboard(ctx: &egui::Context, editor: &mut Editor, monitor: &mut Monitor) {
        if ctx.wants_keyboard_input() {
            return; // a text field has focus
        }
        ctx.input(|i| {
            let cmd = i.modifiers.command || i.modifiers.ctrl;
            use egui::Key;
            if i.key_pressed(Key::Space) {
                monitor.toggle(&editor.data);
            }
            if (i.key_pressed(Key::Delete) || i.key_pressed(Key::Backspace)) && !editor.selected.is_empty() {
                let ids = editor.selected.clone();
                if i.modifiers.shift {
                    editor.run(Command::RippleDelete { clip_ids: ids });
                } else {
                    editor.run(Command::Delete { clip_ids: ids });
                }
                editor.select_one(None);
            }
            if cmd && i.key_pressed(Key::Z) {
                if i.modifiers.shift {
                    editor.redo();
                } else {
                    editor.undo();
                }
            }
            if cmd && i.key_pressed(Key::D) && !editor.selected.is_empty() {
                let ids = editor.selected.clone();
                editor.run(Command::Duplicate { clip_ids: ids });
            }
            if !cmd {
                if i.key_pressed(Key::V) {
                    editor.mode = Mode::Select;
                }
                if i.key_pressed(Key::W) {
                    editor.mode = Mode::Transform;
                }
                if i.key_pressed(Key::C) {
                    editor.mode = Mode::Crop;
                }
                if i.key_pressed(Key::B) {
                    editor.mode = Mode::Blade;
                }
                if i.key_pressed(Key::X) {
                    editor.mode = Mode::Text;
                }
                if i.key_pressed(Key::S) {
                    if let Some(id) = editor.selected_id().map(|s| s.to_string()) {
                        let ph = editor.playhead;
                        editor.run(Command::Split { clip_id: id, at: ph });
                    }
                }
            }
        });
    }

    // ---- top bar -----------------------------------------------------------
    fn topbar_ui(ui: &mut egui::Ui, editor: &mut Editor, _monitor: &mut Monitor) {
        ui.horizontal(|ui| {
            ui.heading("ShelfEdit");
            ui.label(egui::RichText::new("native").weak());
            ui.separator();
            ui.strong(&editor.project_name);
            ui.label(
                egui::RichText::new(format!(
                    "{}×{} · {}fps · {:.1}s",
                    editor.canvas.width,
                    editor.canvas.height,
                    editor.canvas.fps,
                    editor.duration()
                ))
                .weak(),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("Save").clicked() {
                    editor.save_now();
                }
                ui.add_enabled(editor.can_redo(), egui::Button::new("↷"))
                    .clicked()
                    .then(|| editor.redo());
                ui.add_enabled(editor.can_undo(), egui::Button::new("↶"))
                    .clicked()
                    .then(|| editor.undo());
            });
        });
    }

    // ---- mode / tool strip -------------------------------------------------
    fn tools_ui(ui: &mut egui::Ui, editor: &mut Editor) {
        ui.horizontal_wrapped(|ui| {
            let mode = editor.mode;
            let mode_btn = |ui: &mut egui::Ui, m: Mode, label: &str| -> bool {
                ui.selectable_label(mode == m, label).clicked()
            };
            if mode_btn(ui, Mode::Select, "⤢ Select") {
                editor.mode = Mode::Select;
            }
            if mode_btn(ui, Mode::Transform, "✥ Transform") {
                editor.mode = Mode::Transform;
            }
            if mode_btn(ui, Mode::Crop, "⛶ Crop") {
                editor.mode = Mode::Crop;
            }
            if mode_btn(ui, Mode::Blade, "🔪 Blade") {
                editor.mode = Mode::Blade;
            }
            if mode_btn(ui, Mode::Text, "T Text") {
                editor.mode = Mode::Text;
            }
            ui.separator();

            let sel = editor.selected.clone();
            let has_sel = !sel.is_empty();
            let primary = editor.selected_id().map(|s| s.to_string());
            let ph = editor.playhead;

            if ui.add_enabled(primary.is_some(), egui::Button::new("✂ Split")).clicked() {
                if let Some(id) = primary.clone() {
                    editor.run(Command::Split { clip_id: id, at: ph });
                }
            }
            if ui.add_enabled(has_sel, egui::Button::new("⧉ Duplicate")).clicked() {
                editor.run(Command::Duplicate { clip_ids: sel.clone() });
            }
            if ui.add_enabled(has_sel, egui::Button::new("🗑 Delete")).clicked() {
                editor.run(Command::Delete { clip_ids: sel.clone() });
                editor.select_one(None);
            }
            if ui.add_enabled(has_sel, egui::Button::new("⟠ Ripple")).clicked() {
                editor.run(Command::RippleDelete { clip_ids: sel.clone() });
                editor.select_one(None);
            }
            ui.separator();
            if ui.add_enabled(has_sel, egui::Button::new("⇋ Flip H")).clicked() {
                editor.run(Command::FlipH { clip_ids: sel.clone() });
            }
            if ui.add_enabled(has_sel, egui::Button::new("⤯ Flip V")).clicked() {
                editor.run(Command::FlipV { clip_ids: sel.clone() });
            }
            if ui.add_enabled(has_sel, egui::Button::new("⟳ 90°")).clicked() {
                editor.run(Command::RotateBy { clip_ids: sel.clone(), degrees: 90.0 });
            }
            if ui.add_enabled(has_sel, egui::Button::new("⊘ Reset")).clicked() {
                editor.run(Command::ResetTransform { clip_ids: sel.clone() });
            }
            ui.separator();
            if ui.add_enabled(sel.len() >= 2, egui::Button::new("🔗 Link")).clicked() {
                editor.run(Command::Link { clip_ids: sel.clone() });
            }
            if ui.add_enabled(has_sel, egui::Button::new("⛓ Unlink")).clicked() {
                editor.run(Command::Unlink { clip_ids: sel.clone() });
            }
            if ui.selectable_label(editor.snapping, "🧲 Snap").clicked() {
                editor.snapping = !editor.snapping;
            }
        });
    }

    // ---- inspector ---------------------------------------------------------
    fn inspector_ui(ui: &mut egui::Ui, editor: &mut Editor) {
        ui.heading("Properties");
        ui.separator();
        let clips = editor.selected_clips();
        if clips.is_empty() {
            ui.label(egui::RichText::new("Select clip(s) to edit properties").weak());
            return;
        }
        let clip = clips[0].clone();
        let ids_visual: Vec<String> = clips.iter().filter(|c| !c.is_audio()).map(|c| c.id.clone()).collect();
        let ids_video: Vec<String> = clips.iter().filter(|c| c.is_video()).map(|c| c.id.clone()).collect();
        let ids_audio: Vec<String> = clips.iter().filter(|c| c.is_video() || c.is_audio()).map(|c| c.id.clone()).collect();

        ui.label(format!(
            "{}{}",
            if clips.len() > 1 { format!("{} clips · ", clips.len()) } else { String::new() },
            clip.ty
        ));

        egui::ScrollArea::vertical().show(ui, |ui| {
            // Text content
            if clip.is_text() {
                ui.separator();
                ui.label("Text");
                let mut text = clip.text.clone().unwrap_or_default();
                if ui.text_edit_multiline(&mut text).changed() {
                    editor.run(Command::SetText { clip_id: clip.id.clone(), text });
                }
            }

            // Layer / transform
            ui.separator();
            ui.strong("Layer");
            let tf = clip.transform_or_default();
            let mut opacity = clip.opacity.unwrap_or(1.0);
            if slider(ui, "Opacity", &mut opacity, 0.0, 1.0) {
                editor.run(Command::SetOpacity { clip_ids: ids_visual.clone(), opacity });
            }
            let mut scale = tf.scale;
            if slider(ui, "Scale", &mut scale, 0.1, 3.0) {
                editor.run(Command::SetScale { clip_ids: ids_visual.clone(), scale });
            }
            let mut x = tf.x;
            let mut y = tf.y;
            let mut rot = tf.rotation;
            let cx = slider(ui, "X", &mut x, -1.0, 1.0);
            let cy = slider(ui, "Y", &mut y, -1.0, 1.0);
            let cr = slider(ui, "Rotate", &mut rot, -180.0, 180.0);
            if cx || cy || cr {
                editor.run(Command::SetTransform {
                    clip_ids: ids_visual.clone(),
                    transform: Transform { scale, x, y, rotation: rot },
                });
            }
            ui.horizontal(|ui| {
                let mut fh = clip.flip_h.unwrap_or(false);
                let mut fv = clip.flip_v.unwrap_or(false);
                if ui.checkbox(&mut fh, "Flip H").changed() {
                    editor.run(Command::SetFlip { clip_ids: ids_visual.clone(), flip_h: Some(fh), flip_v: None });
                }
                if ui.checkbox(&mut fv, "Flip V").changed() {
                    editor.run(Command::SetFlip { clip_ids: ids_visual.clone(), flip_h: None, flip_v: Some(fv) });
                }
            });

            // Transitions (fades)
            ui.separator();
            ui.strong("Transitions");
            let mut fi = clip.fade_in.unwrap_or(0.0);
            if drag_secs(ui, "Fade in (s)", &mut fi) {
                editor.run(Command::SetFade { clip_ids: ids_visual.clone(), fade_in: Some(fi), fade_out: None });
            }
            let mut fo = clip.fade_out.unwrap_or(0.0);
            if drag_secs(ui, "Fade out (s)", &mut fo) {
                editor.run(Command::SetFade { clip_ids: ids_visual.clone(), fade_in: None, fade_out: Some(fo) });
            }

            // Keyframes
            ui.separator();
            ui.horizontal(|ui| {
                ui.strong("Keyframes");
                let lt = (editor.playhead - clip.timeline_start).clamp(0.0, clip.duration());
                if ui.button(format!("+ @ {:.1}s", lt)).clicked() {
                    let ph = editor.playhead;
                    editor.run(Command::AddKeyframeAtPlayhead { clip_ids: ids_visual.clone(), playhead: ph });
                }
            });
            if let Some(keys) = &clip.keyframes {
                for k in keys.clone() {
                    ui.horizontal(|ui| {
                        ui.label(format!("{:.2}s", k.t));
                        if ui.small_button("✕").clicked() {
                            editor.run(Command::RemoveKeyframe { clip_id: clip.id.clone(), t: k.t });
                        }
                    });
                }
            } else {
                ui.label(egui::RichText::new("No keyframes.").weak());
            }

            // Color (video)
            if clip.is_video() {
                ui.separator();
                ui.strong("Color");
                let col = clip.color.unwrap_or_default();
                let mut b = col.brightness;
                let mut c = col.contrast;
                let mut s = col.saturation;
                let cb = slider(ui, "Brightness", &mut b, 0.2, 2.0);
                let cc = slider(ui, "Contrast", &mut c, 0.2, 2.0);
                let cs = slider(ui, "Saturation", &mut s, 0.0, 2.0);
                if cb || cc || cs {
                    editor.run(Command::SetColor {
                        clip_ids: ids_video.clone(),
                        brightness: Some(b),
                        contrast: Some(c),
                        saturation: Some(s),
                    });
                }
            }

            // Crop (video)
            if clip.is_video() {
                ui.separator();
                ui.horizontal(|ui| {
                    ui.strong("Crop");
                    let mut on = clip.crop.is_some();
                    if ui.checkbox(&mut on, "on").changed() {
                        editor.run(Command::SetCrop {
                            clip_ids: ids_video.clone(),
                            crop: if on { Some(ops::default_crop()) } else { None },
                        });
                    }
                });
                if let Some(cr) = clip.crop {
                    let mut r = cr;
                    let mut changed = false;
                    changed |= slider(ui, "X", &mut r.x, 0.0, 0.95);
                    changed |= slider(ui, "Y", &mut r.y, 0.0, 0.95);
                    changed |= slider(ui, "W", &mut r.w, 0.05, 1.0);
                    changed |= slider(ui, "H", &mut r.h, 0.05, 1.0);
                    if changed {
                        editor.run(Command::SetCrop { clip_ids: ids_video.clone(), crop: Some(r) });
                    }
                }
            }

            // Green screen (chroma) (video)
            if clip.is_video() {
                ui.separator();
                ui.horizontal(|ui| {
                    ui.strong("Green screen");
                    let mut on = clip.chroma.as_ref().map(|c| c.enabled).unwrap_or(false);
                    if ui.checkbox(&mut on, "on").changed() {
                        let mut ch = clip.chroma.clone().unwrap_or_default();
                        ch.enabled = on;
                        editor.run(Command::SetChroma { clip_ids: ids_video.clone(), chroma: Some(ch) });
                    }
                });
                if let Some(ch) = &clip.chroma {
                    if ch.enabled {
                        let mut sim = ch.similarity;
                        let mut smo = ch.smoothness;
                        let cs = slider(ui, "Similarity", &mut sim, 0.0, 1.0);
                        let cm = slider(ui, "Smoothness", &mut smo, 0.0, 0.5);
                        if cs || cm {
                            editor.run(Command::SetChroma {
                                clip_ids: ids_video.clone(),
                                chroma: Some(ChromaKey { similarity: sim, smoothness: smo, ..ch.clone() }),
                            });
                        }
                    }
                }
            }

            // Mask (video)
            if clip.is_video() {
                ui.separator();
                ui.horizontal(|ui| {
                    ui.strong("Mask");
                    let mut on = clip.mask.is_some();
                    if ui.checkbox(&mut on, "on").changed() {
                        editor.run(Command::SetMask {
                            clip_ids: ids_video.clone(),
                            mask: if on { Some(ops::default_mask()) } else { None },
                        });
                    }
                });
                if let Some(m) = clip.mask {
                    let mut r = m;
                    let mut changed = false;
                    changed |= slider(ui, "X", &mut r.x, 0.0, 1.0);
                    changed |= slider(ui, "Y", &mut r.y, 0.0, 1.0);
                    changed |= slider(ui, "W", &mut r.w, 0.05, 1.0);
                    changed |= slider(ui, "H", &mut r.h, 0.05, 1.0);
                    if changed {
                        editor.run(Command::SetMask { clip_ids: ids_video.clone(), mask: Some(r) });
                    }
                }
            }

            // Audio (video/audio)
            if clip.is_video() || clip.is_audio() {
                ui.separator();
                ui.strong("Audio");
                let mut vol = clip.volume.unwrap_or(1.0);
                if slider(ui, "Volume", &mut vol, 0.0, 1.0) {
                    editor.run(Command::SetVolume { clip_ids: ids_audio.clone(), volume: vol });
                }
                let mut afi = clip.audio_fade_in.unwrap_or(0.0);
                if drag_secs(ui, "A. fade in (s)", &mut afi) {
                    editor.run(Command::SetAudioFade { clip_ids: ids_audio.clone(), fade_in: Some(afi), fade_out: None });
                }
                let mut afo = clip.audio_fade_out.unwrap_or(0.0);
                if drag_secs(ui, "A. fade out (s)", &mut afo) {
                    editor.run(Command::SetAudioFade { clip_ids: ids_audio.clone(), fade_in: None, fade_out: Some(afo) });
                }
            }
        });
    }

    // ---- preview -----------------------------------------------------------
    fn preview_ui(ui: &mut egui::Ui, editor: &mut Editor, monitor: &mut Monitor, tex: Option<TextureId>) {
        // transport
        ui.horizontal(|ui| {
            let label = if monitor.is_playing() { "⏸ Pause" } else { "▶ Play" };
            if ui.button(label).clicked() {
                monitor.toggle(&editor.data);
            }
            if ui.button("|◁").clicked() {
                editor.playhead = 0.0;
                monitor.seek(&editor.data, 0.0);
            }
            let dur = editor.duration().max(0.001);
            let mut t = editor.playhead;
            if ui.add(egui::Slider::new(&mut t, 0.0..=dur).text("s")).changed() {
                editor.playhead = t;
                monitor.seek(&editor.data, t);
            }
            ui.label(format!("{:.2} / {:.2}s", editor.playhead, editor.duration()));
        });

        let avail = ui.available_size();
        let (rect, resp) = ui.allocate_exact_size(avail, Sense::click_and_drag());
        let painter = ui.painter_at(rect);
        painter.rect_filled(rect, 0.0, Color32::from_gray(16));

        // Canvas rect (letterboxed to project aspect).
        let cw = editor.canvas.width.max(1) as f32;
        let ch = editor.canvas.height.max(1) as f32;
        let s = (rect.width() / cw).min(rect.height() / ch);
        let canvas_size = Vec2::new(cw * s, ch * s);
        let canvas_rect = Rect::from_center_size(rect.center(), canvas_size);
        painter.rect_filled(canvas_rect, 0.0, Color32::BLACK);

        let t = editor.playhead;

        // Primary video clip → textured, transformed quad.
        if let (Some(tex), Some(frame)) = (tex, monitor.current_frame()) {
            if let Some(clip) = active_video_clip(&editor.data, t).cloned() {
                let dur = clip.duration();
                let lt = (t - clip.timeline_start).clamp(0.0, dur);
                let p = ops::resolve_props(&clip, lt, dur);
                draw_clip_quad(
                    &painter,
                    tex,
                    canvas_rect,
                    Vec2::new(frame.width as f32, frame.height as f32),
                    p.scale as f32,
                    p.x as f32,
                    p.y as f32,
                    p.rotation as f32,
                    p.opacity as f32,
                    clip.crop,
                    clip.flip_h.unwrap_or(false),
                    clip.flip_v.unwrap_or(false),
                );
            }
        }

        // Text overlays.
        for clip in active_text_clips(&editor.data, t) {
            let tf = clip.transform_or_default();
            let dur = clip.duration();
            let lt = (t - clip.timeline_start).clamp(0.0, dur);
            let p = ops::resolve_props(clip, lt, dur);
            let pos = canvas_rect.center()
                + Vec2::new(tf.x as f32 * canvas_rect.width(), tf.y as f32 * canvas_rect.height());
            let size = (canvas_rect.height() * 0.06 * tf.scale as f32).max(8.0);
            painter.text(
                pos,
                Align2::CENTER_CENTER,
                clip.text.clone().unwrap_or_default(),
                FontId::proportional(size),
                Color32::WHITE.gamma_multiply(p.opacity as f32),
            );
        }

        // Interactions per mode.
        match editor.mode {
            Mode::Text => {
                if resp.clicked() {
                    if let Some(pos) = resp.interact_pointer_pos() {
                        let x = ((pos.x - canvas_rect.center().x) / canvas_rect.width()) as f64;
                        let y = ((pos.y - canvas_rect.center().y) / canvas_rect.height()) as f64;
                        let ph = editor.playhead;
                        editor.run(Command::AddText { at: ph, track_id: None, text: None, x: Some(x), y: Some(y) });
                    }
                }
            }
            Mode::Transform => {
                if resp.dragged() {
                    let d = resp.drag_delta();
                    let ids = editor.selected.clone();
                    if !ids.is_empty() {
                        editor.preview_mut(|data| {
                            for id in &ids {
                                ops::update_clip(data, id, |e| {
                                    let mut tf = e.transform.unwrap_or_default();
                                    tf.x += (d.x / canvas_rect.width()) as f64;
                                    tf.y += (d.y / canvas_rect.height()) as f64;
                                    e.transform = Some(tf);
                                });
                            }
                        });
                    }
                }
            }
            _ => {}
        }

        // HUD
        ui.allocate_ui_at_rect(
            Rect::from_min_size(rect.min + Vec2::new(8.0, 8.0), Vec2::new(rect.width() - 16.0, 18.0)),
            |ui| {
                ui.label(
                    egui::RichText::new(format!(
                        "{}  {}",
                        if monitor.is_playing() { "PLAYING" } else { "PAUSED" },
                        monitor.stats()
                    ))
                    .monospace()
                    .color(Color32::from_white_alpha(160)),
                );
            },
        );
    }

    // ---- timeline ----------------------------------------------------------
    fn timeline_ui(
        ui: &mut egui::Ui,
        editor: &mut Editor,
        monitor: &mut Monitor,
        drag: &mut Option<ClipDrag>,
        scrubbing: &mut bool,
    ) {
        // Timeline toolbar (zoom, add track / text).
        ui.horizontal(|ui| {
            ui.label("Zoom");
            if ui.button("−").clicked() {
                editor.px_per_sec = (editor.px_per_sec / 1.4).max(8.0);
            }
            if ui.button("+").clicked() {
                editor.px_per_sec = (editor.px_per_sec * 1.4).min(600.0);
            }
            ui.separator();
            if ui.button("+ Text").clicked() {
                let ph = editor.playhead;
                editor.run(Command::AddText { at: ph, track_id: None, text: Some("New text".into()), x: None, y: None });
            }
            if ui.button("+ Video track").clicked() {
                editor.run(Command::AddTrack { kind: "video".into() });
            }
            if ui.button("+ Audio track").clicked() {
                editor.run(Command::AddTrack { kind: "audio".into() });
            }
            if ui.button("+ Text track").clicked() {
                editor.run(Command::AddTrack { kind: "text".into() });
            }
            ui.separator();
            ui.label(egui::RichText::new(format!("{:.0}px/s", editor.px_per_sec)).weak());
        });
        ui.separator();

        let pps = editor.px_per_sec;
        let dur = editor.duration().max(1.0);
        let n_tracks = editor.data.tracks.len();
        let body_h = RULER_H + n_tracks as f32 * TRACK_H;

        ui.horizontal_top(|ui| {
            // Left: fixed track headers.
            ui.vertical(|ui| {
                ui.allocate_space(Vec2::new(HEADER_W, RULER_H));
                let track_ids: Vec<String> = editor.data.tracks.iter().map(|t| t.id.clone()).collect();
                for tid in track_ids {
                    Self::track_header(ui, editor, &tid);
                }
            });

            // Right: scrollable lanes + ruler, painted.
            egui::ScrollArea::horizontal().show(ui, |ui| {
                let content_w = (dur as f32 * pps + 40.0).max(ui.available_width());
                let (rect, resp) =
                    ui.allocate_exact_size(Vec2::new(content_w, body_h), Sense::click_and_drag());
                let painter = ui.painter_at(rect);
                painter.rect_filled(rect, 0.0, Color32::from_gray(24));

                let x_of = |time: f64| rect.min.x + (time as f32) * pps;
                let time_of = |x: f32| ((x - rect.min.x) / pps) as f64;

                // Ruler ticks.
                let ruler_rect = Rect::from_min_size(rect.min, Vec2::new(rect.width(), RULER_H));
                painter.rect_filled(ruler_rect, 0.0, Color32::from_gray(32));
                let step = nice_step(pps);
                let mut tt = 0.0;
                while tt <= dur {
                    let x = x_of(tt);
                    painter.line_segment(
                        [Pos2::new(x, rect.min.y), Pos2::new(x, rect.min.y + RULER_H)],
                        Stroke::new(1.0, Color32::from_gray(90)),
                    );
                    painter.text(
                        Pos2::new(x + 3.0, rect.min.y + 2.0),
                        Align2::LEFT_TOP,
                        format!("{:.0}s", tt),
                        FontId::monospace(10.0),
                        Color32::from_gray(160),
                    );
                    tt += step;
                }

                // Lanes + clips.
                let highlight = editor.linked_highlight();
                let mut click_select: Option<String> = None;
                let mut clear_select = false;
                for (ti, track) in editor.data.tracks.iter().enumerate() {
                    let lane_y = rect.min.y + RULER_H + ti as f32 * TRACK_H;
                    let lane_rect = Rect::from_min_size(Pos2::new(rect.min.x, lane_y), Vec2::new(rect.width(), TRACK_H));
                    if ti % 2 == 0 {
                        painter.rect_filled(lane_rect, 0.0, Color32::from_gray(28));
                    }
                    for el in &track.elements {
                        let x0 = x_of(el.timeline_start);
                        let x1 = x_of(el.end());
                        let cr = Rect::from_min_max(
                            Pos2::new(x0 + 1.0, lane_y + 4.0),
                            Pos2::new((x1 - 1.0).max(x0 + 3.0), lane_y + TRACK_H - 4.0),
                        );
                        let base = clip_color(&track.kind);
                        let selected = editor.is_selected(&el.id);
                        let linked = highlight.contains(&el.id);
                        painter.rect_filled(cr, 4.0, base);
                        if linked {
                            painter.rect_stroke(cr, 4.0, Stroke::new(2.0, Color32::from_rgb(240, 210, 60)));
                        }
                        if selected {
                            painter.rect_stroke(cr, 4.0, Stroke::new(2.0, Color32::from_rgb(90, 170, 255)));
                        }
                        let label = clip_label(el);
                        painter.text(
                            cr.min + Vec2::new(5.0, 3.0),
                            Align2::LEFT_TOP,
                            label,
                            FontId::proportional(11.0),
                            Color32::from_gray(230),
                        );
                    }
                }

                // Playhead.
                let px = x_of(editor.playhead);
                painter.line_segment(
                    [Pos2::new(px, rect.min.y), Pos2::new(px, rect.max.y)],
                    Stroke::new(1.5, Color32::from_rgb(255, 80, 80)),
                );

                // Interaction.
                let pointer = resp.interact_pointer_pos();
                let in_ruler = pointer.map(|p| p.y < rect.min.y + RULER_H).unwrap_or(false);
                let modifiers = ui.input(|i| i.modifiers);

                // Which clip / edge is under the pointer (in lane area)?
                let hit = pointer.and_then(|p| {
                    if p.y < rect.min.y + RULER_H {
                        return None;
                    }
                    let ti = (((p.y - rect.min.y - RULER_H) / TRACK_H) as usize).min(n_tracks.saturating_sub(1));
                    let track = editor.data.tracks.get(ti)?;
                    for el in &track.elements {
                        let x0 = x_of(el.timeline_start);
                        let x1 = x_of(el.end());
                        if p.x >= x0 && p.x <= x1 {
                            let edge = if (p.x - x0).abs() < 6.0 {
                                Some(DragKind::TrimStart)
                            } else if (x1 - p.x).abs() < 6.0 {
                                Some(DragKind::TrimEnd)
                            } else {
                                None
                            };
                            return Some((el.id.clone(), el.timeline_start, edge, track.locked.unwrap_or(false)));
                        }
                    }
                    None
                });

                if resp.drag_started() {
                    if in_ruler {
                        *scrubbing = true;
                        if let Some(p) = pointer {
                            let t = time_of(p.x).clamp(0.0, dur);
                            editor.playhead = t;
                            monitor.seek(&editor.data, t);
                        }
                    } else if let Some((id, ts, edge, locked)) = &hit {
                        if !locked {
                            let kind = edge.clone().unwrap_or(DragKind::Move);
                            let grab_dt = pointer.map(|p| time_of(p.x) - *ts).unwrap_or(0.0);
                            *drag = Some(ClipDrag {
                                clip_id: id.clone(),
                                kind,
                                before: editor.begin_interaction(),
                                grab_dt,
                            });
                            editor.select_one(Some(id.clone()));
                        }
                    }
                } else if resp.dragged() {
                    if *scrubbing {
                        if let Some(p) = pointer {
                            let t = time_of(p.x).clamp(0.0, dur);
                            editor.playhead = t;
                            monitor.seek(&editor.data, t);
                        }
                    } else if let Some(d) = drag.as_ref() {
                        if let Some(p) = pointer {
                            let raw = time_of(p.x);
                            let id = d.clip_id.clone();
                            let kind = d.kind.clone();
                            let grab_dt = d.grab_dt;
                            let snap = editor.snapping;
                            match kind {
                                DragKind::Move => {
                                    let mut start = (raw - grab_dt).max(0.0);
                                    if snap {
                                        start = snap_time(&editor.data, editor.playhead, start, &id);
                                    }
                                    // choose target track by pointer row
                                    let tgt = {
                                        let ti = (((p.y - rect.min.y - RULER_H) / TRACK_H) as i64)
                                            .clamp(0, n_tracks as i64 - 1) as usize;
                                        editor.data.tracks.get(ti).map(|t| t.id.clone())
                                    };
                                    editor.preview_mut(|data| ops::move_clip_group(data, &id, start, tgt.as_deref()));
                                }
                                DragKind::TrimStart => {
                                    editor.preview_mut(|data| ops::trim_start(data, &id, raw.max(0.0)));
                                }
                                DragKind::TrimEnd => {
                                    let smax = editor
                                        .data
                                        .get(&id)
                                        .and_then(|e| e.media_id.clone())
                                        .and_then(|m| editor.media.get(&m))
                                        .map(|mi| mi.duration);
                                    editor.preview_mut(|data| ops::trim_end(data, &id, raw, smax));
                                }
                            }
                        }
                    }
                } else if resp.drag_stopped() {
                    if let Some(d) = drag.take() {
                        editor.end_interaction(d.before);
                    }
                    *scrubbing = false;
                } else if resp.clicked() {
                    if in_ruler {
                        if let Some(p) = pointer {
                            let t = time_of(p.x).clamp(0.0, dur);
                            editor.playhead = t;
                            monitor.seek(&editor.data, t);
                        }
                    } else if let Some((id, _, _, _)) = &hit {
                        match editor.mode {
                            Mode::Blade => {
                                if let Some(p) = pointer {
                                    let at = time_of(p.x);
                                    editor.run(Command::Split { clip_id: id.clone(), at });
                                }
                            }
                            _ => {
                                if modifiers.shift || modifiers.command || modifiers.ctrl {
                                    click_select = Some(id.clone());
                                } else {
                                    editor.select_one(Some(id.clone()));
                                }
                            }
                        }
                    } else {
                        clear_select = true;
                    }
                }
                if let Some(id) = click_select {
                    editor.toggle_select(&id);
                }
                if clear_select {
                    editor.select_one(None);
                }
            });
        });
    }

    fn track_header(ui: &mut egui::Ui, editor: &mut Editor, track_id: &str) {
        let (name, kind, hidden, locked, selected) = {
            let Some(t) = editor.data.tracks.iter().find(|t| t.id == track_id) else { return };
            (
                t.name.clone(),
                t.kind.clone(),
                t.is_hidden(),
                t.is_locked(),
                editor.selected_track.as_deref() == Some(track_id),
            )
        };
        let (rect, _) = ui.allocate_exact_size(Vec2::new(HEADER_W, TRACK_H), Sense::hover());
        ui.allocate_ui_at_rect(rect.shrink(4.0), |ui| {
            ui.horizontal(|ui| {
                if ui.selectable_label(selected, egui::RichText::new(&name).small()).clicked() {
                    editor.selected_track = Some(track_id.to_string());
                }
            });
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new(&kind).weak().small());
                if ui.small_button(if hidden { "🚫" } else { "👁" }).clicked() {
                    editor.run(Command::SetTrackHidden { track_id: track_id.to_string(), hidden: !hidden });
                }
                if ui.small_button(if locked { "🔒" } else { "🔓" }).clicked() {
                    editor.run(Command::SetTrackLocked { track_id: track_id.to_string(), locked: !locked });
                }
                if ui.small_button("↑").clicked() {
                    editor.run(Command::MoveTrack { track_id: track_id.to_string(), dir: -1 });
                }
                if ui.small_button("↓").clicked() {
                    editor.run(Command::MoveTrack { track_id: track_id.to_string(), dir: 1 });
                }
                if ui.small_button("⌫").clicked() {
                    editor.run(Command::RemoveTrack { track_id: track_id.to_string() });
                }
            });
        });
    }
}

// ---- small UI helpers ------------------------------------------------------

fn slider(ui: &mut egui::Ui, label: &str, value: &mut f64, min: f64, max: f64) -> bool {
    ui.add(egui::Slider::new(value, min..=max).text(label)).changed()
}

fn drag_secs(ui: &mut egui::Ui, label: &str, value: &mut f64) -> bool {
    ui.horizontal(|ui| {
        let r = ui.add(egui::DragValue::new(value).speed(0.1).range(0.0..=60.0));
        ui.label(label);
        r.changed()
    })
    .inner
}

fn nice_step(pps: f32) -> f64 {
    // aim ~80px between labels
    let target = 80.0 / pps as f64;
    let steps = [0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0];
    for s in steps {
        if s >= target {
            return s;
        }
    }
    600.0
}

fn clip_color(kind: &str) -> Color32 {
    match kind {
        "video" => Color32::from_rgb(52, 84, 140),
        "audio" => Color32::from_rgb(52, 120, 90),
        _ => Color32::from_rgb(120, 80, 140),
    }
}

fn clip_label(el: &crate::model::Element) -> String {
    if el.is_text() {
        el.text.clone().unwrap_or_else(|| "Text".into())
    } else {
        format!("{} {:.1}s", el.ty, el.duration())
    }
}

// Snap a proposed start time to nearby clip edges / the playhead.
fn snap_time(data: &TimelineData, playhead: f64, start: f64, moving_id: &str) -> f64 {
    let thresh = 0.15;
    let mut best = start;
    let mut bestd = thresh;
    let mut consider = |edge: f64, val: f64, best: &mut f64, bestd: &mut f64| {
        let d = (edge - start).abs();
        if d < *bestd {
            *bestd = d;
            *best = val;
        }
    };
    consider(playhead, playhead, &mut best, &mut bestd);
    for t in &data.tracks {
        for e in &t.elements {
            if e.id == moving_id {
                continue;
            }
            consider(e.timeline_start, e.timeline_start, &mut best, &mut bestd);
            consider(e.end(), e.end(), &mut best, &mut bestd);
        }
    }
    best
}

// Draw a textured, transformed quad for a video clip into `canvas_rect`.
#[allow(clippy::too_many_arguments)]
fn draw_clip_quad(
    painter: &egui::Painter,
    tex: TextureId,
    canvas_rect: Rect,
    frame_wh: Vec2,
    scale: f32,
    x: f32,
    y: f32,
    rotation_deg: f32,
    opacity: f32,
    crop: Option<MaskRect>,
    flip_h: bool,
    flip_v: bool,
) {
    let cw = canvas_rect.width();
    let ch = canvas_rect.height();
    let fit = (cw / frame_wh.x).min(ch / frame_wh.y);
    let w = frame_wh.x * fit * scale;
    let h = frame_wh.y * fit * scale;
    let center = canvas_rect.center() + Vec2::new(x * cw, y * ch);
    let ang = rotation_deg.to_radians();
    let (sin, cos) = ang.sin_cos();
    let rot = |dx: f32, dy: f32| -> Pos2 {
        Pos2::new(center.x + dx * cos - dy * sin, center.y + dx * sin + dy * cos)
    };
    let hw = w / 2.0;
    let hh = h / 2.0;
    let (u0, v0, u1, v1) = match crop {
        Some(c) => (c.x as f32, c.y as f32, (c.x + c.w) as f32, (c.y + c.h) as f32),
        None => (0.0, 0.0, 1.0, 1.0),
    };
    let (u0, u1) = if flip_h { (u1, u0) } else { (u0, u1) };
    let (v0, v1) = if flip_v { (v1, v0) } else { (v0, v1) };
    let color = Color32::from_white_alpha((opacity.clamp(0.0, 1.0) * 255.0) as u8);
    let mut mesh = Mesh::with_texture(tex);
    let verts = [
        (rot(-hw, -hh), Pos2::new(u0, v0)),
        (rot(hw, -hh), Pos2::new(u1, v0)),
        (rot(hw, hh), Pos2::new(u1, v1)),
        (rot(-hw, hh), Pos2::new(u0, v1)),
    ];
    for (p, uv) in verts {
        mesh.vertices.push(Vertex { pos: p, uv, color });
    }
    mesh.indices.extend_from_slice(&[0, 1, 2, 0, 2, 3]);
    painter.add(Shape::mesh(mesh));
}
