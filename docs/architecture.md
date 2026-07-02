# Architecture

## Overview

ShelfEdit is a local-first AI video editor delivered as a **desktop client** talking
to a **local server**. The server holds all real logic; the client is a thin UI.
The server is designed to be deployable online later without changing application
code.

```text
Desktop client  →  local server (FastAPI)  →  database  →  local video files
                                   ↓
                    OpenAI transcription / cut-planning APIs
                                   ↓
                             FFmpeg render
```

## Layers

- **Client layer (future phase):** a desktop application that opens like a normal
  app (not just a browser tab). It only renders UI and calls the server's HTTP API.
- **Server layer:** an HTTP API service. Local today (run on `127.0.0.1`), but the
  same code can run on a remote host later.
- **Data layer:** a relational database. SQLite for the local install; the database
  URL is configurable so a networked database can be swapped in for a deployed server.
- **File layer:** original videos, extracted audio, thumbnails, transcripts, timelines,
  and renders, organized per project on disk. Originals are read-only to the app.
- **External AI layer:** the server (never the client) calls OpenAI for transcription
  and cut-planning. Secrets stay server-side.
- **Render layer:** FFmpeg, invoked by the server, produces final video files.

## Local vs. deployable

The only thing standing between "local server" and "deployed server" is
configuration, not code:

- Database location is set by a URL (SQLite file locally, networked DB when deployed).
- File storage is a configurable base directory (local disk now, larger disk or object
  storage later).
- Client talks to the server over HTTP regardless of where the server runs.

## Phase 1 scope

Only the server and data layers exist, and only for the **Project** entity:

- FastAPI application with a health endpoint.
- SQLite database created on startup.
- Project model + create/list/get/update/soft-delete endpoints.

Everything else (media, transcripts, timelines, render jobs, the client, and any
online deployment) arrives in later phases.
