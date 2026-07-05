# ShelfEdit (Qt + MLT rebuild)

A ground-up rebuild of ShelfEdit on a **proven engine**. The video core is
[MLT](https://mltframework.org) — the same C++ framework under Shotcut and
Kdenlive — so playback, A/V sync, compositing and export are handled by code
that already works, instead of a hand-rolled pipeline.

## Architecture (north star)

```text
┌─ Qt main window ───────────────────────────────┐
│   Preview: native widget (MLT frame-show)       │  ← MLT paints frames here
│   Timeline + controls: QWebEngineView (HTML/JS) │  ← ported React editor UI
└─────────────────────────────────────────────────┘
        ▲ QWebChannel (JS ⇆ C++: commands + state only, never frames)
        │
   C++ controller  ──drives──►  MLT (tractor / playlists / filters / transitions)
                                     ├─ sdl2_audio consumer → master clock + frame-show
                                     └─ avformat consumer   → export (same graph)
```

Key invariants (mirroring the proven Shotcut design):

- **Audio consumer is the master clock.** The playhead is derived from it; we
  never seek to re-sync during playback.
- **Frames never cross the JS bridge.** MLT renders into the native preview
  widget via the `consumer-frame-show` event; the bridge carries only edit
  commands and lightweight state (playhead, durations).
- **Preview and export come from the same MLT graph**, so they match by
  construction.

## Slices (vertical)

1. **Playback proof** — native Qt window, one clip in an MLT graph, play with
   audio + scrub into the preview widget. (this slice)
2. **Bridge + timeline** — QWebEngineView hosts the ported React UI; QWebChannel
   wired; timeline JSON → MLT tractor; multitrack playback.
3. **Effects** — map the effect stack (transform / color / chroma / mask / text
   / audio) onto MLT filters + transitions.
4. **Export** — MLT `avformat` consumer from the same tractor.

## Build

Prerequisites (macOS, Homebrew):

```bash
brew install cmake ninja mlt qt
```

Configure + build:

```bash
cd app
cmake -B build -G Ninja -DCMAKE_PREFIX_PATH="$(brew --prefix qt)"
cmake --build build
./build/shelfedit [optional/path/to/video]
```

If no path is given, Slice 1 falls back to the newest source clip found in the
legacy database / project folders.
