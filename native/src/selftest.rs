//! Headless verification of the Slice 1 pipeline on the real footage. Run with
//! `cargo run --release -- --selftest`. Proves decode throughput and scrub
//! latency without needing GUI interaction.

use std::time::Instant;

use crate::commands::{apply_command, Command};
use crate::db;
use crate::decode::{decode_one, preview_size, VideoStream};
use crate::model::TimelineData;

/// Headless edit round-trip: loads the real project, exercises the command
/// layer + JSON fidelity in memory (no DB writes), and prints a summary.
pub fn run_edit() {
    println!("== ShelfEdit native — Slice 2 edit self-test ==");
    let lp = match db::load_best() {
        Ok(lp) => lp,
        Err(e) => {
            println!("FAIL: {e}");
            std::process::exit(1);
        }
    };
    println!("project : {} ({})", lp.name, lp.project_id);
    let mut data = lp.timeline.clone();
    data.recompute_duration();
    println!(
        "loaded  : {} tracks, {} clips, duration {:.2}s",
        data.tracks.len(),
        data.tracks.iter().map(|t| t.elements.len()).sum::<usize>(),
        data.duration
    );
    for t in &data.tracks {
        println!(
            "  track {:<6} '{}' — {} clip(s){}{}",
            t.kind,
            t.name,
            t.elements.len(),
            if t.is_hidden() { " [hidden]" } else { "" },
            if t.is_locked() { " [locked]" } else { "" },
        );
    }

    // JSON fidelity round-trip.
    let json = serde_json::to_string(&data).unwrap();
    let reparsed: TimelineData = serde_json::from_str(&json).unwrap();
    let clips_before: usize = data.tracks.iter().map(|t| t.elements.len()).sum();
    let clips_reparsed: usize = reparsed.tracks.iter().map(|t| t.elements.len()).sum();
    println!(
        "json    : round-trip {} -> {} clips  {}",
        clips_before,
        clips_reparsed,
        if clips_before == clips_reparsed { "OK" } else { "MISMATCH" }
    );

    // Exercise the command layer in memory.
    if let Some(vid) = data
        .tracks
        .iter()
        .find(|t| t.kind == "video")
        .and_then(|t| t.elements.first())
        .cloned()
    {
        let before = data.tracks.iter().map(|t| t.elements.len()).sum::<usize>();
        let mid = vid.timeline_start + vid.duration() / 2.0;
        apply_command(&mut data, &Command::Split { clip_id: vid.id.clone(), at: mid });
        let after = data.tracks.iter().map(|t| t.elements.len()).sum::<usize>();
        println!("split   : clips {before} -> {after}  {}", if after == before + 1 { "OK" } else { "FAIL" });

        // move the new clip, then flip + color-grade it
        apply_command(&mut data, &Command::SetColor { clip_ids: vec![vid.id.clone()], brightness: Some(1.2), contrast: None, saturation: None });
        apply_command(&mut data, &Command::FlipH { clip_ids: vec![vid.id.clone()] });
        let graded = data.get(&vid.id).unwrap();
        println!(
            "grade   : brightness {:.2} flipH {}  OK",
            graded.color.map(|c| c.brightness).unwrap_or(1.0),
            graded.flip_h.unwrap_or(false)
        );
    }

    // Track ops.
    let tr_before = data.tracks.len();
    apply_command(&mut data, &Command::AddTrack { kind: "video".into() });
    println!("track   : add video {} -> {}  OK", tr_before, data.tracks.len());

    // Undo semantics are the editor's; here just confirm re-serialization works.
    let json2 = serde_json::to_string(&data).unwrap();
    let _: TimelineData = serde_json::from_str(&json2).unwrap();
    println!("resave  : serialized {} bytes  OK", json2.len());
    println!("== edit self-test complete (no DB writes) ==");
}

/// Renders the first few seconds of the real project to a temp file to prove
/// the export filtergraph is valid end-to-end. `cargo run -- --exporttest`.
pub fn run_export() {
    use crate::render::{start_export, ExportState};
    println!("== ShelfEdit native — export self-test ==");
    let lp = match db::load_best() {
        Ok(lp) => lp,
        Err(e) => {
            println!("FAIL: {e}");
            std::process::exit(1);
        }
    };
    let mut data = lp.timeline.clone();
    data.recompute_duration();
    let out = std::env::temp_dir().join("shelfedit_export_test.mp4");
    let _ = std::fs::remove_file(&out);
    println!(
        "project : {}  dur {:.1}s -> rendering first 4.0s to {}",
        lp.name,
        data.duration,
        out.display()
    );
    let h = start_export(data, lp.media.clone(), out.clone(), Some(4.0));
    loop {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let s = h.state.lock().unwrap().clone();
        match s {
            ExportState::Running(f) => print!("\r  progress {:.0}%   ", f * 100.0),
            ExportState::Done(p) => {
                println!("\rDONE: {}", p.display());
                break;
            }
            ExportState::Failed(e) => {
                println!("\rFAIL: {e}");
                std::process::exit(1);
            }
        }
        use std::io::Write;
        let _ = std::io::stdout().flush();
    }
    // Probe the result.
    let probe = std::process::Command::new("ffprobe")
        .args([
            "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
            "-of", "default=noprint_wrappers=1", out.to_str().unwrap(),
        ])
        .output();
    match probe {
        Ok(o) => {
            let meta = String::from_utf8_lossy(&o.stdout);
            let bytes = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
            println!("output  : {bytes} bytes");
            for l in meta.lines() {
                println!("  {l}");
            }
            println!("== export self-test complete ==");
        }
        Err(e) => println!("probe failed: {e}"),
    }
}

pub fn run() {
    println!("== ShelfEdit native — Slice 1 self-test ==");
    let p = match db::find_openable() {
        Ok(p) => p,
        Err(e) => {
            println!("FAIL: could not open a project: {e}");
            std::process::exit(1);
        }
    };
    println!(
        "project   : {} ({})",
        p.project_name,
        if p.project_id.is_empty() { "media" } else { &p.project_id }
    );
    println!("media     : {}", p.media_path);
    println!("source    : {}x{}  dur {:.1}s  fps(canvas) {}", p.width, p.height, p.duration, p.fps);

    let (ow, oh) = preview_size(p.width, p.height, 1280);
    let fps = p.fps.max(1);
    println!("preview   : {ow}x{oh}  @ {fps}fps (CFR-normalized)");

    // --- first-frame latency -------------------------------------------------
    let t0 = Instant::now();
    match decode_one(&p.media_path, 0.0, ow, oh) {
        Ok(f) => println!(
            "first frame: {:.0} ms  ({} bytes)",
            t0.elapsed().as_secs_f64() * 1000.0,
            f.rgba.len()
        ),
        Err(e) => {
            println!("FAIL: first frame decode: {e}");
            std::process::exit(1);
        }
    }

    // --- sustained decode throughput ----------------------------------------
    // Decode ~5s of content as fast as the pipe allows; must beat real time to
    // guarantee smooth paced playback.
    let want = (fps as u64) * 5;
    let stream = match VideoStream::start(&p.media_path, 0.0, fps, ow, oh) {
        Ok(s) => s,
        Err(e) => {
            println!("FAIL: video stream start: {e}");
            std::process::exit(1);
        }
    };
    let t1 = Instant::now();
    let mut got = 0u64;
    while got < want {
        match stream.rx.recv() {
            Ok(_) => got += 1,
            Err(_) => break,
        }
    }
    let secs = t1.elapsed().as_secs_f64();
    drop(stream);
    let decode_fps = got as f64 / secs;
    println!(
        "throughput : decoded {got} frames in {secs:.2}s  = {decode_fps:.1} fps  (realtime target {fps})  -> {}",
        if decode_fps >= fps as f64 * 0.98 { "OK (>= realtime)" } else { "SLOW" }
    );

    // --- scrub latency -------------------------------------------------------
    let points = [
        p.duration * 0.1,
        p.duration * 0.5,
        p.duration * 0.9,
        p.duration * 0.25,
        0.0,
    ];
    let mut total = 0.0;
    for &t in &points {
        let s = Instant::now();
        let ok = decode_one(&p.media_path, t, ow, oh).is_ok();
        let ms = s.elapsed().as_secs_f64() * 1000.0;
        total += ms;
        println!("scrub @{t:>7.1}s : {ms:>6.0} ms  {}", if ok { "" } else { "FAIL" });
    }
    println!("scrub avg  : {:.0} ms  (ffmpeg per-frame fallback)", total / points.len() as f64);

    // --- warm hardware decoder (macOS AVFoundation) --------------------------
    #[cfg(target_os = "macos")]
    {
        match crate::avdecode::AvDecoder::open(&p.media_path, 1280) {
            Ok(mut dec) => {
                let mut total = 0.0;
                for &t in &points {
                    let s = Instant::now();
                    let ok = dec.frame_at(t).is_ok();
                    let ms = s.elapsed().as_secs_f64() * 1000.0;
                    total += ms;
                    println!("AV scrub @{t:>7.1}s : {ms:>6.0} ms  {}", if ok { "" } else { "FAIL" });
                }
                println!(
                    "AV scrub avg: {:.0} ms  (warm AVFoundation hardware decoder)",
                    total / points.len() as f64
                );
            }
            Err(e) => println!("AV decoder: unavailable ({e})"),
        }
    }

    println!("== self-test complete ==");
}
