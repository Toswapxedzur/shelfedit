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

- Soft-precision home/dashboard page with a thin left settings rail and broad
  project grid.
- Existing project picker from `~/.local_ai_video_editor/shelfedit.db`.
- AVFoundation composition playback across timeline clips.
- Custom ShelfEdit UI chrome using grey canvas, white floating boxes, semantic
  color accents, compact spacing, and shadow-only separation.
- Editor workspace shell with left tools/assets, center preview, right inspector
  plus AI assist, and full-width timeline.
- Metal-backed preview surface fed by CoreVideo pixel buffers.
- Zoomable custom timeline and scrubber.
- Select, move, trim, split, delete, duplicate, ripple delete.
- Undo/redo and autosave back to latest timeline JSON.
- Global playback speed control.

Next slices expand the Metal surface from single-composition presentation into a
full multi-track compositor with transforms, opacity, text overlays, masks,
chroma/color effects, native export, and AI integration.

See `LAYOUT_PLAN.md` for the planned dark editor workspace layout, including the
left library/tools panel, center Metal preview, blue selected-element inspector,
red AI assist panel, and bottom timeline.
