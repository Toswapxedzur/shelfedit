//! ShelfEdit native (Rust) — Slice 1 entry point.
//! Opens an existing project from the legacy DB and proves the native playback
//! pipeline: hardware decode (FFmpeg/VideoToolbox) → GPU preview → audio-synced
//! playback → scrubbing, on the real 3.4K VFR footage.

mod app;
mod audio;
mod commands;
mod compositor;
mod db;
mod decode;
mod editor;
mod model;
mod monitor;
mod ops;
mod player;
mod selftest;

use app::EditorApp;

fn main() -> eframe::Result<()> {
    env_logger::Builder::from_env(
        env_logger::Env::default()
            .default_filter_or("info,wgpu_core=warn,wgpu_hal=warn,naga=warn"),
    )
    .init();

    if std::env::args().any(|a| a == "--selftest") {
        selftest::run();
        return Ok(());
    }
    if std::env::args().any(|a| a == "--edittest") {
        selftest::run_edit();
        return Ok(());
    }

    let make_options = |renderer| eframe::NativeOptions {
        renderer,
        viewport: eframe::egui::ViewportBuilder::default()
            .with_inner_size([1200.0, 820.0])
            .with_position([80.0, 80.0])
            .with_title("ShelfEdit (native)"),
        ..Default::default()
    };

    // Prefer wgpu (Metal). If GPU/surface init fails on this machine/session,
    // fall back to glow (OpenGL) so we still get a window.
    log::info!("starting shelfedit (wgpu renderer)");
    let res = eframe::run_native(
        "ShelfEdit (native)",
        make_options(eframe::Renderer::Wgpu),
        Box::new(|cc| Ok(Box::new(EditorApp::new(cc)))),
    );
    if let Err(e) = &res {
        log::error!("wgpu renderer failed ({e}); retrying with glow");
        return eframe::run_native(
            "ShelfEdit (native)",
            make_options(eframe::Renderer::Glow),
            Box::new(|cc| Ok(Box::new(EditorApp::new(cc)))),
        );
    }
    res
}
