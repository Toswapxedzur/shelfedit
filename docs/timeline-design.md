# Design Note: Multi-Track Timeline Editor

**Status:** Planned (not yet implemented). Captured at the user's request.
**Goal:** Bring ShelfEdit up to the level of a normal, industry-standard
timeline editor (reference point: Movavi-class consumer editors), while staying
local-first.

This note is the source of truth for the future timeline feature. It should be
kept in sync with the `Timeline` data model already sketched in the main plan.

---

## 1. Vision

A conventional editing surface at the bottom of the edit screen: a horizontal
time ruler with a movable playhead, and stacked **tracks**. Users drag
**elements** onto tracks, move and trim them, split them, and layer them. The
preview above reflects the timeline at the playhead position. Rendering composes
the timeline exactly as shown.

The AI transcript-cutting workflow (the app's signature feature) feeds *into*
this: an accepted AI cut plan becomes a set of video elements laid onto a video
track, which the user can then refine by hand.

## 2. Element types (first version: three)

All elements share: a track, a start time on the timeline, a duration, and a
z/order for layering. Type-specific properties:

- **Video element**
  - Source media reference + in/out points into that source (trim).
  - Timeline position and duration.
  - Transform: scale, position (x/y), crop, opacity.
  - Optional: playback speed, volume of its embedded audio, mute.
- **Audio element**
  - Source media reference + in/out points.
  - Timeline position and duration.
  - Volume/gain, fade in/out, mute.
  - May be audio extracted from a video, or an imported audio file.
- **Text element**
  - Text content, font, size, color, weight, alignment.
  - Position (x/y) and anchor, optional background/box, opacity.
  - Timeline position and duration; optional simple fade in/out.

Deliberately out of scope for the first timeline version (add later): keyframe
animation, transitions between clips, color grading, masking, multi-band audio
mixing, effects/filters, speed ramps.

## 2b. Bonded elements

Some elements are **bonded** to a parent element rather than standing alone.
Bonding means they move/trim together with their parent and are conceptually
"attached" to it.

Examples:
- **Audio bonded to video:** a video's own audio track is bonded to the video
  element. Moving/trimming the video moves/trims its bonded audio. The user can
  optionally detach it to edit separately.
- **Transcript text bonded to a video segment:** transcribing a selected video
  segment produces text elements (caption-like) bonded to that segment and
  shown right next to it on the timeline.

Bonding rules (v1):
- A bonded element stores a reference to its parent element id.
- Trimming/moving the parent updates bonded children.
- Deleting the parent deletes (or detaches) its bonded children.
- Transcription is therefore an **action on a selected video segment** that
  attaches bonded transcript text to it — not a global project step.

## 2c. Editor layout (target)

A conventional editor arrangement:

```text
+------+-----------------------+-----------------------+
|      |                       |                       |
| tool |     video preview     |     AI edit chat      |
| bar  |      (center)         |   (history + changes) |
|(left |                       |                       |
| full +-----------------------+-----------------------+
|height|         tracks strip (bottom, full width)     |
+------+-----------------------------------------------+
```

- **Tools panel:** thin, full height, far left.
- **Preview:** center; **AI chat:** right; roughly equal width.
- **Tracks strip:** across the bottom, from the tools panel to the right wall.

The AI edit chat is a separate box (not attached to any element) showing the
conversation and the proposed/applied changes. Transcript is not a separate box;
it lives as bonded text on the tracks.

## 3. Track model

- Multiple stacked tracks. Each track has a **kind**: video, audio, or text.
- Vertical order determines layering for visual tracks (higher track = on top).
- Audio tracks mix together; visual tracks composite top-down.
- A track holds a time-ordered, non-overlapping list of elements (overlap within
  one track is disallowed; layering is achieved with multiple tracks).
- Users can add/remove/reorder tracks.

## 4. Data model

Extends the existing versioned `Timeline` JSON (stored per project, so it stays
local and diff-able). Conceptual shape:

```json
{
  "version": 3,
  "duration": 128.4,
  "tracks": [
    {
      "id": "trk_video_1",
      "kind": "video",
      "order": 0,
      "elements": [
        {
          "id": "el_1",
          "type": "video",
          "media_id": "med_abc",
          "source_start": 12.4,
          "source_end": 85.2,
          "timeline_start": 0.0,
          "transform": { "scale": 1.0, "x": 0.5, "y": 0.5, "opacity": 1.0 },
          "volume": 1.0
        }
      ]
    },
    {
      "id": "trk_text_1",
      "kind": "text",
      "order": 1,
      "elements": [
        {
          "id": "el_2",
          "type": "text",
          "text": "Intro title",
          "timeline_start": 1.0,
          "timeline_end": 4.0,
          "x": 0.5, "y": 0.85, "anchor": "center",
          "font_size": 42, "color": "#ffffff"
        }
      ]
    }
  ]
}
```

Notes:
- Video/audio elements reference source media by id and carry source in/out
  points, so the original file is never modified (consistent with the app's
  read-only-originals rule).
- Text elements carry their content inline.
- Timelines are versioned; each save is a new version for easy undo/history.

## 5. Editing interactions (industry standard)

- Drag element horizontally to move in time; drag between tracks to relayer.
- Drag element edges to trim (adjust source in/out or text duration).
- Split at playhead.
- Delete; ripple-delete (close the gap) as an option.
- Snapping to playhead, other element edges, and track start.
- Playhead scrubbing by clicking/dragging the ruler; spacebar play/pause.
- Zoom in/out on the time axis; horizontal scroll.
- Selection + basic keyboard shortcuts.

## 6. Rendering

The renderer turns the timeline JSON into a single FFmpeg composition:
- Visual tracks → an `overlay`/composite filter chain, bottom track first.
- Video element trims → input `-ss`/`-to` (or `trim`/`atrim` filters).
- Text elements → `drawtext` filters positioned/timed per element.
- Audio tracks → `amix` with per-element volume and fades.
- Output written to a new versioned export file; existing renders are never
  overwritten (consistent with the render safety rule).

This is why the timeline must come **after** a basic render engine exists: the
timeline is only as good as the renderer that realizes it.

## 6b. AI edit assistant (agentic, long-lived)

The AI edit chat is designed to grow into a long-lived, Cursor-like agent that
can perform increasingly complex editing tasks:

- **Conversation memory:** the chat is multi-turn and remembers prior messages,
  the transcript, and the current timeline, so the user can refine
  ("also cut the intro", "make it tighter").
- **Change envelope:** every proposal is a typed change. v1 supports
  `cut_plan` (keep/remove sections); future types include add-text,
  reorder, add-overlay, etc. The UI renders a change card per proposal.
- **Review-before-apply:** proposals never take effect until the user clicks
  Apply. Applying a change updates the timeline; the change is then marked
  applied in the chat history.
- **Toward agentic tool-use:** later the assistant can call editing "tools"
  (trim, split, insert text, place overlay) as structured actions against the
  timeline, enabling multi-step tasks. v1 keeps a single change per turn.

## 7. Relationship to the AI cut workflow

- The AI cut plan produces kept segments with source in/out points.
- "Apply cuts" lays those segments onto a video track as video elements in
  order — which *is* the initial timeline.
- From there the user hand-edits: trim, reorder, add text/audio, etc.

So the AI cut plan is a fast way to generate a first timeline; the timeline
editor is the manual refinement surface.

## 8. Suggested build order

Prerequisites (already planned before this feature):
1. AI cut plan (transcript → proposed keep/remove segments). *(next up)*
2. Apply cuts → create an initial `Timeline`.
3. Basic FFmpeg render of a timeline (cuts only) → exported video.

Then the timeline feature itself, incrementally:
4. Read-only timeline visualization (ruler, tracks, elements, playhead synced to
   the preview) — no editing yet.
5. Move + trim video elements on a single video track; re-render reflects edits.
6. Split, delete, ripple, snapping, zoom.
7. Add a text track + text elements (with `drawtext` rendering).
8. Add an audio track + audio elements (with mix/volume/fades).
9. Multiple video tracks with compositing (overlays), transforms.

Each step ends with a working render so the timeline and output never drift.

## 9. Open questions (to confirm before building)

- Preview fidelity: real-time WYSIWYG compositing in the browser vs. a
  render-on-demand preview? (Real-time overlay/text preview in the browser is
  feasible; exact-match audio mixing usually needs a render.)
- How close to "some video editors" in polish is the target for v1 of the
  timeline (which interactions are must-have vs. nice-to-have)?
- Do we need nested/compound clips or is a flat track model enough for now?
