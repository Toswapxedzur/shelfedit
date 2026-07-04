//! Headless verification of the Slice 1 pipeline on the real footage. Run with
//! `cargo run --release -- --selftest`. Proves decode throughput and scrub
//! latency without needing GUI interaction.

use std::time::Instant;

use crate::db;
use crate::decode::{decode_one, preview_size, VideoStream};

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
    println!("scrub avg  : {:.0} ms", total / points.len() as f64);

    println!("== self-test complete ==");
}
