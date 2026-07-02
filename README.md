# ShelfEdit

A local-first AI video editor. Its signature workflow: import a video,
transcribe the audio, let an AI propose which sections to keep vs. cut, review
the plan, and render the final video locally. Your original footage always stays
on your machine and is never modified.

> **Status: desktop app + media import.** Project management, a desktop app
> (native window + React home screen), and video import (copy or reference,
> with thumbnails and duration/size probing) all work. Transcription, AI
> cutting, and rendering are future phases. An online server is deferred and
> out of scope.

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

## Media import

- **Copy** into the project folder (self-contained) or **reference** the file in
  place (no duplicate) — chosen per import.
- The file is never uploaded over HTTP; the backend reads it from disk, so even
  huge videos import instantly in reference mode.
- On import the app probes duration/dimensions and generates a thumbnail.
- Files over `MAX_IMPORT_FILE_GB` (default 30) require explicit confirmation.

## Safety guarantees

- Original video files are never modified or deleted by the app.
- `DELETE` is a soft-delete: it marks the record, removes no files.
- Secrets live only in `backend/.env`, which is git-ignored.

See `docs/stop-points.md` for the checkpoints where the app pauses for your
confirmation before doing anything risky.
