# ShelfEdit Swift

Native macOS rewrite slice using Swift/AppKit + AVFoundation.

This app reads the existing ShelfEdit SQLite database and timeline JSON, builds
an `AVMutableComposition` from timeline clips, and uses an `AVPlayerLayer` for
smooth Apple-native playback and scrub.

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
- Zoomable native timeline and scrubber.
- Select, move, trim, split, delete, duplicate, ripple delete.
- Undo/redo and autosave back to latest timeline JSON.
- Global playback speed control.

Next slices add a Metal compositor, richer inspector/effects, native import,
export, and AI integration.
