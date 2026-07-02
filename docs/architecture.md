# Architecture

## Overview

ShelfEdit is a **local-first desktop app**. It ships as a native desktop
application that a user opens like any other program. Inside that app runs a
**local backend engine** (FastAPI) that holds all the real logic, backed by a
local database and local video files. Nothing is online.

```text
Desktop app  →  local backend engine (FastAPI)  →  local database  →  local video files
                                   ↓
                    OpenAI transcription / cut-planning APIs
                                   ↓
                             FFmpeg render
```

> **Online server is deferred.** There is no remote server, no cloud, no
> deployment target in scope. The backend is a local process only. If we ever
> revisit an online service, that is a separate future decision — we are not
> designing for it now.

## Layers

- **Desktop app layer:** a packaged native application (opens like a normal app,
  not a browser tab) that renders the UI and talks to the local backend on the
  same machine.
- **Backend engine layer:** a local process that does the work (project data,
  media handling, transcription, cut-planning, rendering). Runs on `127.0.0.1`
  only; not exposed to any network.
- **Data layer:** a local SQLite database file.
- **File layer:** original videos, extracted audio, thumbnails, transcripts,
  timelines, and renders, organized per project on disk. Originals are read-only
  to the app.
- **External AI layer:** the backend (never the UI) calls OpenAI for
  transcription and cut-planning. The secret key stays on the local machine.
- **Render layer:** FFmpeg, invoked by the backend, produces final video files.

## What "desktop from the start" means

We build the desktop shell early rather than shipping a browser-only UI first.
The desktop app bundles the UI and launches/embeds the local backend so the user
experiences it as one program, not a server they have to start manually.

## Phase 1 scope (done)

Only the backend engine and data layers exist, and only for the **Project**
entity:

- FastAPI application with a health endpoint.
- SQLite database created on startup.
- Project model + create/list/get/update/soft-delete endpoints.

Media, transcripts, timelines, render jobs, and the desktop UI arrive in later
phases.
