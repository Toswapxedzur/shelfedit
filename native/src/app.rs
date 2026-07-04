//! egui front-end for Slice 1: preview + transport (play/pause/scrub) + HUD.

use std::time::Duration;

use eframe::egui;

use crate::db;
use crate::player::Player;

pub struct EditorApp {
    player: Option<Player>,
    project_name: String,
    media_path: String,
    load_error: Option<String>,

    texture: Option<egui::TextureHandle>,
    uploaded_version: u64,
}

impl EditorApp {
    pub fn new() -> Self {
        match db::find_openable() {
            Ok(p) => {
                let player = Player::new(p.media_path.clone(), p.width, p.height, p.duration, p.fps);
                Self {
                    player: Some(player),
                    project_name: p.project_name,
                    media_path: p.media_path,
                    load_error: None,
                    texture: None,
                    uploaded_version: u64::MAX,
                }
            }
            Err(e) => Self {
                player: None,
                project_name: String::new(),
                media_path: String::new(),
                load_error: Some(e.to_string()),
                texture: None,
                uploaded_version: u64::MAX,
            },
        }
    }

    fn upload_if_needed(&mut self, ctx: &egui::Context) {
        let Some(player) = &self.player else { return };
        if player.cur_version == self.uploaded_version {
            return;
        }
        let Some(frame) = &player.cur else { return };
        let image = egui::ColorImage::from_rgba_unmultiplied(
            [frame.width as usize, frame.height as usize],
            &frame.rgba,
        );
        match &mut self.texture {
            Some(t) => t.set(image, egui::TextureOptions::LINEAR),
            None => {
                self.texture =
                    Some(ctx.load_texture("preview", image, egui::TextureOptions::LINEAR))
            }
        }
        self.uploaded_version = player.cur_version;
    }
}

impl eframe::App for EditorApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let playing = if let Some(player) = &mut self.player {
            player.update()
        } else {
            false
        };
        self.upload_if_needed(ctx);

        egui::TopBottomPanel::top("top").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.heading("ShelfEdit");
                ui.label(egui::RichText::new("native").weak());
                ui.separator();
                if self.player.is_some() {
                    ui.label(format!("Project: {}", self.project_name));
                }
            });
        });

        egui::TopBottomPanel::bottom("transport").show(ctx, |ui| {
            if let Some(player) = &mut self.player {
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    let label = if player.is_playing() { "Pause" } else { "Play" };
                    if ui.button(label).clicked() {
                        player.toggle();
                    }
                    if ui.button("|<").clicked() {
                        player.seek(0.0);
                    }

                    let dur = player.duration.max(0.001);
                    let mut t = player.clock();
                    let resp = ui.add(
                        egui::Slider::new(&mut t, 0.0..=dur)
                            .text("s")
                            .clamping(egui::SliderClamping::Always),
                    );
                    if resp.changed() {
                        player.seek(t);
                    }
                });

                // HUD
                let t = player.clock();
                ui.horizontal(|ui| {
                    ui.monospace(format!(
                        "clock {:>7.2}s / {:>7.2}s   fps {}   preview {}x{}   {}",
                        t,
                        player.duration,
                        player.fps,
                        player.out_w,
                        player.out_h,
                        if player.is_playing() { "PLAYING" } else { "PAUSED" }
                    ));
                });
                if let Some(cur) = &player.cur {
                    ui.monospace(format!("frame @ {:>7.2}s   drift {:+.3}s", cur.time, cur.time - t));
                }
                if let Some(err) = &player.last_error {
                    ui.colored_label(egui::Color32::YELLOW, err);
                }
                ui.add_space(4.0);
            } else if let Some(err) = &self.load_error {
                ui.colored_label(egui::Color32::LIGHT_RED, format!("Could not open a project: {err}"));
            }
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            if self.player.is_none() {
                ui.centered_and_justified(|ui| {
                    ui.label("No playable project found in the legacy database.");
                });
                return;
            }
            let avail = ui.available_size();
            if let Some(tex) = &self.texture {
                let img = tex.size_vec2();
                let scale = (avail.x / img.x).min(avail.y / img.y).max(0.0);
                let fitted = egui::vec2(img.x * scale, img.y * scale);
                ui.centered_and_justified(|ui| {
                    ui.add(egui::Image::new(tex).fit_to_exact_size(fitted));
                });
            } else {
                ui.centered_and_justified(|ui| {
                    ui.label(format!("Decoding first frame…\n{}", self.media_path));
                });
            }
        });

        // Keep animating: fast while playing, slower poll while paused (to pick
        // up async scrub frames).
        ctx.request_repaint_after(Duration::from_millis(if playing { 8 } else { 33 }));
    }
}
