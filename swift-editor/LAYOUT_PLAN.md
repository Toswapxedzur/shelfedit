# ShelfEdit Swift Layout Plan

This extends the native Swift rewrite plan with the target editor layout and
visual hierarchy. The reference style is the user's darker Adamancia Vault UI:
rounded panels, compact Arial typography, soft shadows, muted dark-gray
backgrounds, and colored accent sections. The editor reference gives the
functional layout: asset/tools panel on the left, preview in the middle,
properties on the right, and timeline across the bottom.

## Design Principles

- Dark mode is the only mode for now.
- Background is dark gray/near-black, not pure black: use layered dark surfaces
  such as `#202020`, `#242424`, `#2b2b2b`, and `#111827`.
- UI should feel custom, not stock AppKit or SwiftUI.
- Keep the Apple-native video path untouched: `AVFoundation` ->
  `AVPlayerItemVideoOutput` / CoreVideo -> Metal preview.
- Prefer rounded cards/panels, soft borders, low-contrast separators, and compact
  typography.
- Use colored accent stripes/panels to communicate area purpose:
  - blue/cyan = selected/current element data and timeline selection context
  - red/rose = AI assist, warnings, proposals, destructive suggestions
  - slate/neutral = library/tools/navigation
  - green/teal = timeline/audio/playback state where useful

## Main App Structure

```text
Home / Dashboard
  -> recent projects
  -> project health/status cards
  -> open project

Editor Workspace
  Top app bar
  Left library/tools panel
  Center preview/player panel
  Right inspector + AI assist panel
  Bottom timeline panel
```

## Home Page

The Home page should be a real app entry point, not just a project picker.

- Top-left brand: `ShelfEdit`.
- Main card: recent projects, sorted by updated time.
- Secondary cards:
  - "Last opened" project shortcut
  - media/import status
  - native playback status
  - AI/transcript availability
- Project card contents:
  - project name
  - media count
  - updated timestamp
  - duration if available
  - badges for transcript/AI/proxy/native-ready state
- Primary action: Open.
- Future actions: New Project, Import Media, Open Database, Settings.

## Editor Workspace Layout

### Top Bar

Fixed-height dark frosted bar.

- Left: Home, project name, save status.
- Center: timecode/date/title area.
- Right: native pipeline status, share/export, settings.
- Keep controls compact and pill-like.

### Left Panel: Library And Tools

This is the editor's asset/tool drawer, inspired by the editor screenshot's left
rail and the Adamancia group list.

Recommended width: 300-360px.

Sections:

- Media
  - video assets
  - audio assets
  - generated assets
  - transcripts/captions
- Tools
  - select
  - trim
  - split
  - text
  - captions
  - effects
  - templates
- Insert cards
  - Add Text
  - Add Caption Track
  - Import Media
  - AI Generated Clip/Text

Visual style:

- Dark slate panel.
- Tool tabs across the top or left edge.
- Rounded item cards with subtle hover lift.
- Active tool uses cyan/navy highlight.

### Center Panel: Preview / Player

This remains the performance-critical area.

Recommended behavior:

- Use the existing Metal-backed preview.
- Preserve aspect fit/letterboxing.
- Overlay selection handles, guides, safe areas, masks, text boxes, and transform
  gizmos in a separate custom overlay layer.
- Keep preview controls minimal: play/pause, timecode, fit/fill, snapshot, view
  quality.

Visual style:

- Preview sits in a rounded dark panel.
- Inner video area can be pure black/dark.
- Header label: `Player` or current sequence name.
- Bottom controls can be a compact strip inside the preview panel.

### Right Panel: Inspector And AI Assist

Recommended width: 300-380px.

This panel has two major zones:

1. Blue/cyan current-element data
2. Red/rose AI assist section

#### Blue: Current Element Inspector

The blue area represents data and controls for the selected timeline element.

Tabs:

- Basic
- Transform
- Video
- Audio
- Text
- Mask
- Color
- Keyframes

Controls:

- selected element name/type
- source file
- timeline start/end/duration
- source in/out
- speed
- opacity
- transform: x/y, scale, rotation
- crop/mask/chroma
- volume/fades for audio
- lock/hide/mute state

Visual style:

- Cyan/blue accent stripe on section cards.
- Dark card background.
- Compact fields and sliders.
- Use disabled states when no element is selected.

#### Red: AI Assist

The red area is an AI command/proposal panel, not a general chat box first.

Sections:

- Prompt/command input
- Context chips:
  - selected clip
  - visible timeline range
  - transcript selection
  - whole project
- Proposed edit cards:
  - split/trim/ripple delete
  - add captions
  - silence removal
  - jump-cut proposal
  - text overlay proposal
  - volume/fade proposal
- Apply / Reject / Preview buttons
- Command log/history

Rules:

- AI never mutates media files directly.
- AI proposes typed timeline commands.
- Applying AI edits uses the same undoable command path as manual edits.
- Red accent means "assistant/proposal/needs review", not necessarily danger.

Visual style:

- Rose/red accent stripe.
- Proposal cards are dark with red-tinted headers.
- Apply is primary blue; reject/dismiss is secondary slate; destructive proposals
  use red.

### Bottom Panel: Timeline

Full-width bottom panel, with left track headers and a large scrollable timeline.

Recommended height: 260-360px.

Structure:

- Top toolbar:
  - select/split/delete/duplicate/ripple
  - snapping
  - zoom controls
  - link/unlink
  - magnet/snap
  - voiceover/transcript toggle later
- Ruler:
  - frame-accurate tick marks at high zoom
  - time labels
- Tracks:
  - video tracks
  - audio tracks
  - text/caption tracks
  - AI proposal ghost tracks later
- Clip rendering:
  - selected clip outline uses cyan/blue
  - audio clips can show waveform later
  - video clips can show thumbnails later
  - text clips use distinct purple/rose tint
- Playhead:
  - bright vertical line
  - top handle
  - exact frame/time display on drag

## Layout Ratios

For desktop width around 1400px:

- Left panel: 18-24%
- Center preview: flexible, roughly 48-56%
- Right panel: 20-26%
- Timeline: full width bottom, 30-40% of height

At narrower widths:

- Collapse left panel into icon rail + drawer.
- Right inspector can become tabbed overlay/drawer.
- Timeline keeps priority over inspector height.

## Implementation Phases

### Phase L1: Static Layout Shell

- Status: implemented as the current editor shell.
- Add a persistent editor workspace container.
- Split editor into top bar, left panel, center preview, right panel, bottom
  timeline.
- Keep current playback/edit behavior working.
- Add placeholder inspector and AI sections with correct colors and labels.
- Use white/light buttons and chips inside the dark workspace for contrast.

### Phase L2: Inspector Data Binding

- Blue current-element inspector reads selected clip data.
- Show source/timeline ranges, speed, opacity, transform, audio volume.
- Editing inspector fields updates the same timeline command path as timeline
  gestures.

### Phase L3: AI Assist Surface

- Add red AI assist section.
- Show prompt input and proposal card placeholders.
- Wire proposal cards to typed timeline commands.
- Use existing backend/OpenAI flow only after manual edit command path is stable.

### Phase L4: Rich Timeline

- Add better track headers.
- Add thumbnails/waveform placeholders, then real cached thumbnails/waveforms.
- Add zoom/scroll mini-map.
- Add ghost previews for pending AI proposals.

### Phase L5: Overlay Editing

- Add selection overlays on the Metal preview.
- Add transform handles, crop/mask handles, text box handles.
- Route overlay edits through timeline commands and inspector updates.

## Acceptance Criteria

- App launches to Home.
- Opening a project enters the editor workspace with left/center/right/bottom
  regions visible.
- The preview remains Metal-backed and scrub performance remains smooth.
- The right panel clearly separates blue selected-element data from red AI assist.
- Selecting a timeline clip updates the blue inspector.
- AI proposal UI is visibly separate and cannot directly mutate media.
- Existing project timeline JSON still loads and saves without migration.
