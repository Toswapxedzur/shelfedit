# ShelfEdit — Native Rewrite (Rust)

Living design + progress doc for the ground-up native rewrite. Read this first
when resuming; it is the source of truth for decisions and status.

## Why this exists

The previous app is a Python (FastAPI) backend + React/TS UI shown in a
**WKWebView** (pywebview). Playback was reworked to native `<video>` elements
and is now smooth, but a webview has structural efficiency limits vs a native
editor:

- No zero-copy random file access (media reached over HTTP-over-localhost).
- Only a policy-limited slice of the hardware decoder (WKWebView WebCodecs/WebGPU lag Chromium).
- Bounded memory/threads, no first-class frame index / decode cache.

Decision (user, explicit): go **fully native for maximum efficiency**, disregard
effort, willing to switch language and drop the webview.

## Frozen legacy app

The old app is preserved untouched:

- git tag: `pre-native-rewrite`
- git branch: `legacy-webview`
- Do **not** modify `backend/` or `frontend/` during the native build.

## Target architecture (native, max efficiency)

- **Language:** Rust.
- **UI:** `egui` via `eframe` (immediate-mode; ideal for dynamic timelines +
  live GPU preview). GPU surface managed by eframe's `wgpu` backend.
- **Decode:** FFmpeg. See "Decode backend decision" below.
- **GPU compositing:** wgpu (Metal on macOS). Preview frames as GPU textures;
  transforms / color / chroma / text as shader passes (later slices).
- **Audio:** `cpal` output; audio-clock master (ffplay model).
- **Storage:** reuse the existing on-disk layout + SQLite DB (read-only for now).
- **Transcription/AI (later):** whisper.cpp native + LLM over HTTPS. No Python.

### Decode backend decision (important)

Local FFmpeg is **8.1.1 (libavcodec 62)** — too new for the Rust FFmpeg binding
crates (`ffmpeg-next` / `ffmpeg-the-third`) to compile reliably. To guarantee a
working build in one session we drive decoding through the **FFmpeg CLI**:

- Spawn `ffmpeg` with `-hwaccel videotoolbox`, normalize to **constant frame
  rate** (`-r <fps>`) — this also fixes the VFR root cause of the old lag — and
  scale to a preview size, output raw `rgba` frames on stdout.
- A reader thread parses fixed-size frames and feeds a bounded decode-ahead
  channel.
- Seeking = restart `ffmpeg` with input `-ss <t>` (fast keyframe seek).
- Audio: a second `ffmpeg` piping `f32le` PCM into `cpal`.

This is decoupled behind a decoder interface so the **in-process libav +
zero-copy VideoToolbox→Metal** path (the ultimate optimization) can replace it
later without touching the UI/player.

## Data model (from the legacy DB, reused)

- DB: `~/.local_ai_video_editor/shelfedit.db` (SQLite, WAL).
- Tables used: `projects`, `media_assets`, `timelines` (latest `version` per
  project holds `data_json`).
- Media files: real sources are 3456×2234 H.264, **VFR** (~59.7fps avg), AAC
  48k. Some copied into `projects/<id>/media/original/`, some referenced on the
  Desktop.
- Timeline JSON shape:
  ```json
  {"duration": 455.5,
   "canvas": {"width":1920,"height":1080,"fps":30},
   "tracks": [{"id","kind":"video|audio|text","name","order",
     "elements":[{"id","type","media_id","source_start","source_end",
       "timeline_start","transform":{"scale","x","y","rotation"},"groupId",...}]}]}
  ```

## Delivery plan (vertical slices)

- **Slice 1 — efficiency proof (THIS SESSION):** open an existing project,
  hardware-decode its clip (CFR-normalized), show it on the GPU, play with audio,
  and scrub — validated on the real 3.4K VFR footage.
- Slice 2 — editing: multi-track timeline, clip ops, transform/crop/effects.
- Slice 3 — export via GPU compositor + FFmpeg encode.
- Slice 4 — assets, AI command layer, transcription.

## Build / run

```
cd native
cargo run --release
```

Requires: Rust toolchain, `ffmpeg`/`ffprobe` on PATH (Homebrew), macOS with
VideoToolbox.

## Status log

- [x] Recon (toolchains present: Rust 1.96, FFmpeg 8.1.1 + VideoToolbox).
- [x] Freeze legacy app (tag + branch).
- [x] Scaffold Rust project (eframe/egui, wgpu/Metal window).
- [x] DB read + timeline model (`db.rs`, `model.rs`).
- [x] FFmpeg CLI video decode + preview texture (`decode.rs`, `app.rs`).
- [x] cpal audio + audio-clock master (`audio.rs`).
- [x] Playback engine + scrub (`player.rs`, `decode::SeekWorker`).
- [x] Verify Slice 1 on real footage (self-test, see below).

## Slice 1 results (measured on the real 3.4K VFR source)

Source: `Raw 1.mov` — 3456×2234, ~59.7fps VFR, 455.5s, AAC 48k.
Preview: 1280×826 @ 30fps CFR-normalized. GPU: Metal (Apple M1 Pro), wgpu.

- First frame latency: **~390 ms**
- Sustained decode throughput: **~55 fps** (target 30) → ~1.8× real time, so
  paced playback cannot underrun. This is the fix for the old lag: hardware
  decode + CFR normalization removes the VFR bottleneck entirely.
- Scrub latency (cold seek+decode across the timeline): **~440 ms avg**
  (a decoded-frame/thumbnail cache in a later slice makes repeat scrubs instant).

Reproduce: `cd native && cargo run --release -- --selftest`.

### Note on GUI screenshots from a sandboxed shell

The wgpu/Metal window is created and actively rendering (confirmed via logs and
the WindowServer window list at the requested bounds), but a GUI binary launched
from the automation shell is not composited onto the active desktop Space, so
pixel screenshots can't be captured from here. Launch it yourself with
`native/run.sh` (or `cargo run --release`) from a normal Terminal to see it.

## Files (native/src)

- `main.rs`   — entry; env_logger, wgpu→glow fallback, `--selftest`.
- `db.rs`     — read-only SQLite: pick a project whose first video clip exists.
- `model.rs`  — serde structs for the legacy timeline JSON.
- `decode.rs` — FFmpeg-CLI decoder: `VideoStream` (decode-ahead) + `decode_one`
  + `SeekWorker` (coalesced scrub).
- `audio.rs`  — cpal output + audio-clock master.
- `player.rs` — clock, present-to-clock frame selection, play/pause/seek.
- `app.rs`    — egui UI: preview + transport + HUD.
- `selftest.rs` — headless benchmark.

## Slice 2 — editor UI + editing brain (DONE)

Ported the whole editor from the legacy React app: layout, every button, and
the editing logic behind them. Verified headlessly on the real `testre`
project (`cargo run --release -- --edittest`).

- Full-fidelity data model (`model.rs`): transform, color, chroma, crop, mask,
  keyframes, fades, volume, speed, groupId, track hidden/locked — exact JSON
  round-trip, unknown fields preserved.
- Pure timeline ops (`ops.rs`): split, trim start/end, move-group (magnet),
  ripple delete, duplicate, link/unlink, add/remove/move track, keyframes,
  effect resolution (keyframe + fade interpolation).
- Command layer (`commands.rs`): one typed vocabulary; the toolbar/inspector and
  (future) AI go through `apply_command`.
- Editor state (`editor.rs`): selection, mode, snapping, zoom, undo/redo history,
  debounced autosave → **new timeline version** in SQLite (legacy stays readable).
- Timeline monitor (`monitor.rs`): maps the timeline clock to source clips and
  drives the Slice-1 hardware player, re-pointing across cuts. Plays the
  top-most active video clip + audio; text overlays drawn on top.
- UI (`app.rs`): top bar, mode/tool strip (Select/Transform/Crop/Blade/Text +
  Split/Duplicate/Delete/Ripple/Flip/Rotate/Reset/Link/Unlink/Snap/Undo/Redo),
  left inspector (Layer/Transitions/Keyframes/Color/Crop/Chroma/Mask/Audio/Text),
  bottom timeline (ruler + scrub, track headers with show/lock/move/remove,
  clips with select/drag-move/trim/blade, zoom), center GPU preview compositing
  the active clip with transform/opacity/crop/flip + text, transport, and
  keyboard shortcuts (space, del/ripple, ⌘Z/⇧⌘Z, ⌘D, V/W/C/B/X, S).

Known limits (next slices): color grade / chroma / mask are stored + editable
but not yet rendered in the preview (need the wgpu shader pass); live compositing
of simultaneous video layers (PiP) isn't done — playback shows the top clip.

## Next

- wgpu shader compositor pass: YUV upload + color grade + chroma + mask, and
  multi-layer live compositing.
- Decoded-frame/thumbnail LRU cache in `decode.rs` for instant scrub + PiP.
- Import / Export (FFmpeg encode from the timeline) and the AI command bridge
  (the Rust `Command` enum is the catalogue).
