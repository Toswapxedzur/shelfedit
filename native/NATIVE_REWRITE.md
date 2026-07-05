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

## Slice 3 — GPU compositor (DONE)

Real preview compositing via a custom `wgpu` render pass run *inside* the egui
frame (an `egui_wgpu` paint callback). The inspector controls now visibly do
what they say.

- WGSL shader (`preview.wgsl`) per layer: quad transform (scale/pos/rotation),
  crop (uv sub-rect), flip, **color grade** (brightness/contrast/saturation),
  **green-screen / chroma key**, **rectangular mask**, opacity/fades —
  premultiplied-alpha output to match egui's blend.
- `compositor.rs`: pipeline + per-layer texture/uniform slots stored in egui's
  callback resources; one draw call per layer, composited in track order (top
  track on top).
- `decode.rs` `FrameCache`: per-media coalescing async decode + LRU cache so
  non-primary / paused layers get frames without stalling the UI. The clip the
  monitor is actively decoding uses its live frame; the rest come from the cache.
- Multi-layer live compositing (PiP / overlays) now works; the monitor still
  drives audio + the top clip's stream.
- glow fallback path keeps a basic textured preview (no shader effects) if wgpu
  is unavailable.

## Slice 4 — scrub fix, thumbnails, export (DONE)

Responsiveness + the first authoritative render out of the editor.

- **Scrub latency 493 ms → 145 ms avg** (worst 848 → 183 ms), verified by the
  self-test. Root cause: `-hwaccel videotoolbox` pays a ~300–600 ms VideoToolbox
  *session init* on every single-frame process spawn. Single-frame scrub now
  decodes in **software** (`decode.rs::decode_one`); streaming playback keeps
  hwaccel. On top of that the scrub flow changed structurally: dragging the
  ruler / transport only moves the playhead and the preview is served from the
  (now fast, cached) `FrameCache`; the streaming player is only re-pointed once,
  on release — so we no longer spawn a decode process per drag tick, and
  revisiting a time is instant from cache.
- **Timeline thumbnails**: each video clip shows a poster frame, decoded on a
  dedicated small `FrameCache` (256 px) so thumbnails never contend with scrub
  frames; uploaded once to an egui texture and cached.
- **Export** (`render.rs`): the timeline is rendered to H.264/AAC by building an
  FFmpeg `filter_complex` — per-clip trim + placement (`setpts`/`overlay` with
  `enable`), transform (scale/position), crop, flip, colour grade (`eq`),
  green-screen (`chromakey`), opacity + fades (alpha), text overlays
  (`drawtext`), and an audio mix that honours per-clip volume + fades across
  tracks (`atrim`/`adelay`/`afade`/`amix`). Runs on a background thread with
  live progress parsed from FFmpeg; button + progress live in the top bar.
  Verified end-to-end (`--exporttest`) producing a valid composited file.

The preview is the fast approximation; **export is the authoritative render**.

## Next

- Real-time multi-track audio *mixing* in the preview (playback still monitors
  the top clip's source audio at unity; the export already mixes correctly).
- Export parity for **rotation** and the **reveal-mask** (both render in the GPU
  preview; skipped in the export filtergraph for now). Colour-grade uses FFmpeg
  `eq`, a close but not pixel-identical match to the shader.
- The AI command bridge (the Rust `Command` enum is already the catalogue; needs
  wiring to a model/endpoint).
