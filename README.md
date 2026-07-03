# ShelfEdit

A local-first AI video editor. Its signature workflow: import a video,
transcribe the audio, let an AI propose which sections to keep vs. cut, review
the plan, and render the final video locally. Your original footage always stays
on your machine and is never modified.

> **Status: end-to-end MVP + a real multi-track timeline editor.**
> Project management, a desktop app (native window + React editor), video import
> (copy or reference), OpenAI transcription, an AI edit chat that proposes
> reviewable cut plans, and **local FFmpeg rendering to a versioned MP4 export**
> all work. The editor is now a **full-screen, 剪映/Movavi-style timeline**: typed
> video/audio/text tracks, draggable/trim/split/delete clips with undo/redo, and a
> **real-time canvas compositor** that computes the current frame from the tracks
> (video + live text overlays), instead of just playing a file. Advanced effects
> (color grading, transitions, keyframes, masking, green screen, advanced audio
> mixing, motion tracking) build on this compositor and are the next phase. An
> online server is deferred and out of scope.

## Architecture (north star)

```text
Desktop app  →  local backend engine (FastAPI)  →  SQLite database  →  local video files
                                   ↓
                    OpenAI transcription / cut-planning APIs
                                   ↓
                             FFmpeg render
```

ShelfEdit is a **local-first desktop app**: a native application that bundles the
UI and a local backend engine. Everything stays on your machine. An online server
is **deferred** and out of scope for now. See `docs/architecture.md`.

## Requirements

- Python 3.11+
- Node.js 18+ (for the UI)
- FFmpeg (used in later phases; already handy to have installed)

## Run as a desktop app

Build the UI once, then launch the native window (which starts the backend for
you):

```bash
# 1. Build the UI
cd frontend
npm install
npm run build

# 2. Launch the desktop app
cd ../backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m app.desktop
```

A native window titled "ShelfEdit" opens showing your projects. Nothing is
exposed to the network.

## Develop with hot-reload

Run the backend and the UI dev server in two terminals:

```bash
# Terminal 1 — backend engine
cd backend && source .venv/bin/activate
uvicorn app.main:app --reload

# Terminal 2 — UI with hot reload (proxies /api and /health to the backend)
cd frontend && npm run dev
```

Then open http://127.0.0.1:5173. Backend-only endpoints:

- Health check: http://127.0.0.1:8000/health
- Interactive API docs: http://127.0.0.1:8000/docs

## Run the tests

```bash
cd backend
source .venv/bin/activate
pytest -q
```

## Endpoints

| Method | Path                                       | Purpose                                     |
| ------ | ------------------------------------------ | ------------------------------------------- |
| GET    | `/health`                                  | Liveness check                              |
| POST   | `/api/projects`                            | Create a project                            |
| GET    | `/api/projects`                            | List active projects (with media summary)   |
| GET    | `/api/projects/{id}`                       | Get one project                             |
| PATCH  | `/api/projects/{id}`                       | Update a project                            |
| DELETE | `/api/projects/{id}`                       | Soft-delete a project (never touches files) |
| POST   | `/api/projects/{id}/media/import`          | Import a local video (copy or reference)    |
| GET    | `/api/projects/{id}/media`                 | List a project's media                      |
| GET    | `/api/projects/{id}/thumbnail`             | Project thumbnail image                     |
| GET    | `/api/media/{media_id}/thumbnail`          | Media thumbnail image                       |
| GET    | `/api/media/{media_id}/file`               | Stream the video for preview                |
| POST   | `/api/projects/{id}/transcribe`            | Start a transcription job                   |
| GET    | `/api/jobs/{job_id}`                       | Poll a background job's status              |
| GET    | `/api/projects/{id}/transcript`            | Get the transcript (with segments)          |
| GET    | `/api/projects/{id}/ai/messages`           | AI edit conversation history                |
| POST   | `/api/projects/{id}/ai/messages`           | Send a message; get the assistant's reply   |
| POST   | `/api/projects/{id}/ai/messages/{mid}/apply` | Apply a proposed change to the timeline   |
| GET    | `/api/projects/{id}/timeline`              | Get the working timeline (creates an empty default) |
| PUT    | `/api/projects/{id}/timeline`              | Save the working timeline (editor autosave) |
| GET    | `/api/media/{media_id}/filmstrip`          | Tiled frame strip for a clip background     |
| GET    | `/api/media/{media_id}/waveform`           | Normalized audio peaks for waveform drawing |
| POST   | `/api/projects/{id}/render`                | Render the applied timeline to an MP4        |
| GET    | `/api/projects/{id}/exports`               | List rendered export videos                 |
| GET    | `/api/media/{media_id}/file`               | Stream an export (or source) for playback   |

## Media import

- **Copy** into the project folder (self-contained) or **reference** the file in
  place (no duplicate) — chosen per import.
- The file is never uploaded over HTTP; the backend reads it from disk, so even
  huge videos import instantly in reference mode.
- On import the app probes duration/dimensions and generates a thumbnail.
- Files over `MAX_IMPORT_FILE_GB` (default 30) require explicit confirmation.

## Transcription

- Set `OPENAI_API_KEY` in `backend/.env`, then use the **Transcribe** action on a
  project's edit screen. The audio is extracted locally and sent to OpenAI; the
  key never leaves the backend.
- Runs as a background job with live progress; the transcript shows timestamped
  segments.
- Very long videos (over `TRANSCRIBE_WARN_MINUTES`, default 120) ask for
  confirmation first, since transcription takes time and costs money.
- Offline/dev mode: set `SHELFEDIT_FAKE_TRANSCRIBE=1` to exercise the whole
  workflow with a canned transcript and no API key or cost.

## Timeline editor

- Opening a project takes over the whole window (**full-screen, edge-to-edge**):
  a top action bar, the **real-time preview** center, the **AI edit chat** on the
  right, and the **timeline** across the bottom.
- **Typed tracks** — video, audio, and text. Each track holds one kind of clip;
  tracks can be combined freely (the default background is black when no video
  clip is under the playhead).
- **Real-time compositor** — instead of playing a single file, the preview is a
  canvas that computes the current frame from the timeline at the playhead: it
  seeks the active video clip's source, applies its color grade, and paints live
  text overlays on top. Play/pause/scrub all drive the same engine, and the
  render uses the same timeline data.
- **Clip operations** — select, move (drag), trim (edge-drag), split at the
  playhead, and delete, all with **undo/redo** and debounced autosave. A track
  toolbar exposes split / delete / undo / redo / zoom.
- **Clip visuals** — video clips show a **filmstrip** of frames and a label with
  filename + duration; audio clips show an amplitude **waveform**; text clips
  show their caption. Time ruler, a draggable playhead, horizontal scroll, and
  zoom round it out.
- Importing a video auto-populates the timeline (a video clip plus its audio),
  and transcription drops the captions onto the text track as subtitle blocks.

## Effects (compositor)

Each clip carries an effect stack applied live by the compositor (and reflected
in a per-clip **inspector**). Everything is undoable and autosaves.

- **Color grade** — brightness / contrast / saturation.
- **Transform** — scale, position (x/y), and rotation, e.g. picture-in-picture.
- **Opacity + transitions** — per-clip opacity plus fade in / fade out; placing a
  clip on a higher track with a fade gives a crossfade.
- **Keyframe animation** — keyframe opacity / scale / position / rotation over a
  clip's timeline and the compositor interpolates between them.
- **Green screen (chroma key)** — key out a color so the track beneath shows
  through, with adjustable similarity and edge smoothness.
- **Masking** — a rectangular reveal region.
- **Audio mixing** — per-clip volume and audio fades, on top of per-track mute.

Still to come: **motion tracking** (a computer-vision feature of its own) and
**baking effects into the exported MP4** — today effects are live in the preview,
while the render still exports the video-track cut (see roadmap).

## AI edit (cut planning)

- The **AI edit chat** is pinned to the right of the editor, next to the preview.
- **Transcription is an action on the selected video segment.** It attaches the
  transcript to that segment as **bonded text** shown on the tracks; clicking a
  caption seeks the preview.
- The AI edit chat is a **multi-turn conversation** (it remembers context). Ask
  it to tighten/trim the video and it proposes a **cut plan** (keep/remove
  ranges) as a change card. Nothing is applied until you click **Apply**, which
  writes a versioned timeline.
- The change format is extensible so future edit types (add text, reorder,
  overlays) can be added without reworking the chat. See
  [`docs/timeline-design.md`](docs/timeline-design.md).
- Offline/dev mode: set `SHELFEDIT_FAKE_AI=1` to get canned cut plans with no API
  key or cost.

## Render & export

- Use **Render** in the editor's top action bar. It runs a background FFmpeg job
  with live progress and renders the video track of the current timeline.
- Rendering trims the kept segments and concatenates them in one re-encode pass,
  keeping audio in sync. The source file is only read, never modified.
- Exports are written to versioned filenames (`export_v1.mp4`, `export_v2.mp4`,
  …) so a render never overwrites a previous one.
- Finished exports appear as download links in the top action bar. The project
  status becomes `rendered`.

## Roadmap (next)

1. **Bake effects into the render** — extend the FFmpeg pipeline so text
   overlays, color grades, transforms, keyframes, chroma key, and fades appear in
   the exported MP4, not just the live preview.
2. **Track management UI** — add / remove / reorder tracks and drop imported
   assets onto any track from the editor (today a video import auto-populates the
   main video + audio tracks).
3. **Motion tracking** — the remaining advanced effect; a computer-vision effort
   of its own.
4. **Asset descriptions** and, much later, an optional online sync layer.

## Safety guarantees

- Original video files are never modified or deleted by the app.
- `DELETE` is a soft-delete: it marks the record, removes no files.
- Secrets live only in `backend/.env`, which is git-ignored.
- Transcription and other long tasks run in the background; the UI polls status.

See `docs/stop-points.md` for the checkpoints where the app pauses for your
confirmation before doing anything risky.
