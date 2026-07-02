# ShelfEdit

A local-first AI video editor. Its signature workflow: import a video,
transcribe the audio, let an AI propose which sections to keep vs. cut, review
the plan, and render the final video locally. Your original footage always stays
on your machine and is never modified.

> **Status: Phase 1 — backend skeleton.** Only project management and a health
> check exist so far. Media import, transcription, AI cutting, rendering, the
> desktop client, and any online server are future phases.

## Architecture (north star)

```text
Desktop client  →  local server (FastAPI)  →  SQLite database  →  local video files
                                   ↓
                    OpenAI transcription / cut-planning APIs
                                   ↓
                             FFmpeg render
```

The server runs locally today but is structured so it can be deployed online
later without rewriting application code (e.g. by pointing the database URL at a
networked database). See `docs/architecture.md`.

## Requirements

- Python 3.11+
- FFmpeg (used in later phases; already handy to have installed)

## Run the backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Optional: create your local env file (not needed for Phase 1)
cp .env.example .env

uvicorn app.main:app --reload
```

Then open:

- Health check: http://127.0.0.1:8000/health
- Interactive API docs: http://127.0.0.1:8000/docs

## Run the tests

```bash
cd backend
source .venv/bin/activate
pytest -q
```

## Phase 1 endpoints

| Method | Path                       | Purpose                                  |
| ------ | -------------------------- | ---------------------------------------- |
| GET    | `/health`                  | Liveness check                           |
| POST   | `/api/projects`            | Create a project                         |
| GET    | `/api/projects`            | List active projects                     |
| GET    | `/api/projects/{id}`       | Get one project                          |
| PATCH  | `/api/projects/{id}`       | Update a project                         |
| DELETE | `/api/projects/{id}`       | Soft-delete a project (never touches files) |

## Safety guarantees

- Original video files are never modified or deleted by the app.
- `DELETE` is a soft-delete: it marks the record, removes no files.
- Secrets live only in `backend/.env`, which is git-ignored.

See `docs/stop-points.md` for the checkpoints where the app pauses for your
confirmation before doing anything risky.
