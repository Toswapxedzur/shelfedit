# AVPlayer Scrub Test

A tiny separate macOS app to test the native Apple playback path:

```text
AVFoundation / AVPlayer
  -> VideoToolbox hardware decode
  -> CoreVideo pixel buffers
  -> AVPlayerLayer / Core Animation
  -> screen
```

Run it with the local test video:

```bash
./avplayer-scrub/run.sh "Raw 23.mov"
```

Or run without an argument to open `Raw 23.mov` by default:

```bash
./avplayer-scrub/run.sh
```

Drag the custom timeline at the bottom to scrub. During drag, seeks are coalesced and use a small tolerance for smoothness; on release, the app parks exactly on the chosen frame.

The scrubber defaults to a 30-second viewport instead of squeezing the full
video into the bar. Use:

- `Zoom +` / `Zoom -` for finer or wider scrubbing.
- `Fit` to show the whole video.
- `Center` to center the viewport on the current playhead.
- Mouse wheel or trackpad scroll over the scrubber to move the viewport.

The status line shows the current seconds-per-pixel scale and seek latency.
