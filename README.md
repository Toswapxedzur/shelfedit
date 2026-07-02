# ShelfEdit

A local-first AI video editor. Its signature workflow: import a video,
transcribe the audio, let an AI propose which sections to keep vs. cut, review
the plan, and render the final video locally. Your original footage always stays
on your machine and is never modified.

> **Status: desktop app + import + transcription + AI edit (cut planning).**
> Project management, a desktop app (native window + React editor), video import
> (copy or reference), in-app playback, OpenAI transcription, and an AI edit chat
> that proposes reviewable cut plans all work. Rendering the approved timeline is
> the next phase. An online server is deferred and out of scope.

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
| GET    | `/api/projects/{id}/timeline`              | Get the current (versioned) timeline        |

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

## AI edit (cut planning)

- The editor screen is arranged like a real editor: a thin tools panel on the
  left, the video preview in the center, the **AI edit chat** on the right, and a
  **tracks strip** across the bottom (video, bonded audio, and transcript text).
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

## Roadmap (next)

1. **Render** — turn the applied timeline into a final video with FFmpeg.
2. **Multi-track timeline editing** — full drag/trim/split editing on the tracks
   strip, plus the bonded-element model. Designed in
   [`docs/timeline-design.md`](docs/timeline-design.md); scheduled alongside the
   render engine so the timeline maps exactly to the rendered output.

## Safety guarantees

- Original video files are never modified or deleted by the app.
- `DELETE` is a soft-delete: it marks the record, removes no files.
- Secrets live only in `backend/.env`, which is git-ignored.
- Transcription and other long tasks run in the background; the UI polls status.

See `docs/stop-points.md` for the checkpoints where the app pauses for your
confirmation before doing anything risky.
