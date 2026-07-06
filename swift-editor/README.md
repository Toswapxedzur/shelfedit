# ShelfEdit Swift

Native macOS rewrite slice using Swift/AppKit + AVFoundation.

This app reads the existing ShelfEdit SQLite database and timeline JSON, builds
an `AVMutableComposition` from timeline clips, and uses
`AVPlayerItemVideoOutput` + `MTKView` for Metal-backed playback and scrub.

Run:

```bash
./swift-editor/run.sh
```

Headless project/composition check:

```bash
cd swift-editor
swift build -c release
.build/release/ShelfEditSwift --self-test "Raw 23 x10"
```

Current slice:

- Existing project picker from `~/.local_ai_video_editor/shelfedit.db`.
- AVFoundation composition playback across timeline clips.
- Custom ShelfEdit UI chrome using the shared soft glass/navy/pastel style.
- Metal-backed preview surface fed by CoreVideo pixel buffers.
- Zoomable custom timeline and scrubber.
- Select, move, trim, split, delete, duplicate, ripple delete.
- Undo/redo and autosave back to latest timeline JSON.
- Global playback speed control.

Next slices expand the Metal surface from single-composition presentation into a
full multi-track compositor with transforms, opacity, text overlays, masks,
chroma/color effects, native export, and AI integration.
