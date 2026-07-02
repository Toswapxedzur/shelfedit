# Local-First AI Video Editor — Cursor Implementation Plan

**Version:** 0.1  
**Date:** 2026-07-02  
**Goal:** Build a personal AI video editing tool that stores original videos locally while editing, uses OpenAI Whisper for transcription, uses a GPT API call to produce cut decisions from transcript text, supports simple text/image/video overlays, and later can grow into a multi-user online service.

---

## 0. Instruction to Cursor

Cursor should implement this project in small, testable milestones. Do not try to build the full online product at once.

The app should begin as a **local-first web app**:

```text
Local browser UI  →  local FastAPI backend  →  local SQLite database  →  local video files
                                      ↓
                         OpenAI transcription/GPT APIs
                                      ↓
                                  FFmpeg render
```

Cursor must follow these rules:

1. Build one phase at a time.
2. After every phase, run the app and run tests.
3. Do not delete, overwrite, or modify original video files.
4. Do not implement payment, public accounts, cloud upload, or multi-user deployment until explicitly approved.
5. If a step says **STOP FOR USER CHECK**, stop coding, summarize what was done, and ask the user to confirm before continuing.

---

## 1. Product Scope

### 1.1 First version

The first version is a transcript-based AI cutter, not a full Premiere/CapCut replacement.

Core workflow:

```text
Import video
→ extract audio
→ transcribe with OpenAI Whisper
→ ask GPT to choose sections to keep/remove
→ review cut plan
→ render final video locally
→ optionally upload final video later
```

### 1.2 Supported editing features

Build only these at first:

- Cut and trim sections from one main video.
- Add simple text overlay.
- Add image overlay.
- Add small video overlay.
- Store descriptions for image/video assets.
- Export a final rendered video.

Do not build these yet:

- Complex transitions.
- Masking.
- Color grading.
- Multi-track audio mixing.
- Keyframe animation.
- Public collaboration.
- Payment.
- Full cloud editing.

---

## 2. Recommended Tech Stack

### 2.1 Backend

Use:

- Python 3.11+
- FastAPI
- SQLite for local version
- SQLModel or SQLAlchemy
- Pydantic models
- Uvicorn
- FFmpeg through `subprocess`, not through fragile wrapper abstractions
- OpenAI Python SDK
- `python-dotenv` for local environment loading

### 2.2 Frontend

Use one of these:

- Preferred: React + Vite + TypeScript
- Alternative: simple HTML/JS if speed matters more than structure

For now, run the frontend as a web UI. Do not wrap it in Tauri/Electron until the local MVP works.

### 2.3 Local data folder

Default app data folder:

```text
~/.local_ai_video_editor/
  config/
  projects/
  cache/
  logs/
```

On macOS, this can later move to:

```text
~/Library/Application Support/LocalAIVideoEditor/
```

For the first version, keep the simple cross-platform folder and make it configurable in `.env`.

---

## 3. Project Folder Structure

Create a repo like this:

```text
ai-video-editor/
  backend/
    app/
      main.py
      config.py
      database.py
      models.py
      schemas.py
      services/
        media_service.py
        transcription_service.py
        ai_cut_service.py
        render_service.py
        storage_service.py
        thumbnail_service.py
      routers/
        projects.py
        media.py
        transcript.py
        ai.py
        render.py
      workers/
        job_runner.py
      utils/
        ffmpeg.py
        paths.py
        hashing.py
    tests/
    requirements.txt
    .env.example
  frontend/
    src/
      api/
      components/
      pages/
      styles/
    package.json
  docs/
    architecture.md
    api.md
    data-model.md
    stop-points.md
  README.md
```

---

## 4. Environment and Secrets

Create `backend/.env.example`:

```env
OPENAI_API_KEY=
OPENAI_TRANSCRIBE_MODEL=whisper-1
OPENAI_CUT_MODEL=gpt-5.5
APP_DATA_DIR=~/.local_ai_video_editor
MAX_IMPORT_FILE_GB=30
```

Rules:

- Never hardcode the API key.
- Never send the API key to the frontend.
- The frontend calls the local backend; the backend calls OpenAI.
- `.env` must be in `.gitignore`.

**STOP FOR USER CHECK:** If no OpenAI key exists, Cursor should stop and ask the user to create `backend/.env` manually. Cursor must not ask the user to paste the secret into chat.

---

## 5. Data Model

Implement these database entities first.

### 5.1 Project

Fields:

```text
id
name
created_at
updated_at
thumbnail_path
status
storage_mode
```

Possible `status`:

```text
empty
imported
transcribing
transcribed
ai_cut_ready
rendering
rendered
error
```

Possible `storage_mode`:

```text
local_only
final_uploaded
original_backed_up
original_missing_local
```

### 5.2 MediaAsset

Fields:

```text
id
project_id
type: video | image | audio | proxy | export
original_filename
local_path
relative_path
sha256
duration_seconds
width
height
size_bytes
description
tags_json
created_at
```

Important rule: the original imported video should be read-only from the app’s perspective. The app may copy or reference it, but it must never destructively modify it.

### 5.3 Transcript

Fields:

```text
id
project_id
media_asset_id
language
provider
model
raw_json_path
plain_text
created_at
```

### 5.4 TranscriptSegment

Fields:

```text
id
transcript_id
start_seconds
end_seconds
text
```

### 5.5 TranscriptWord

Fields:

```text
id
transcript_id
start_seconds
end_seconds
word
confidence optional
```

If word timestamps are unavailable or unreliable, segment timestamps are still enough for the first version.

### 5.6 Timeline

Fields:

```text
id
project_id
version
json_path
created_at
```

Store the actual timeline as JSON.

Example timeline:

```json
{
  "tracks": [
    {
      "type": "video",
      "items": [
        {
          "media_id": "vid_abc123",
          "source_start": 12.4,
          "source_end": 85.2,
          "timeline_start": 0.0
        }
      ]
    },
    {
      "type": "text",
      "items": [
        {
          "text": "Important explanation",
          "timeline_start": 2.0,
          "timeline_end": 6.0,
          "position": "bottom"
        }
      ]
    }
  ]
}
```

### 5.7 RenderJob

Fields:

```text
id
project_id
status
progress
input_timeline_id
output_path
error_message
created_at
updated_at
```

---

## 6. Backend API

Implement these endpoints.

### 6.1 Project endpoints

```text
POST /api/projects
GET  /api/projects
GET  /api/projects/{project_id}
PATCH /api/projects/{project_id}
DELETE /api/projects/{project_id}
```

**STOP FOR USER CHECK:** `DELETE /api/projects/{project_id}` must not delete video files in the first version. It should only mark a project deleted or remove database records after confirmation. Do not implement destructive deletion without approval.

### 6.2 Media endpoints

```text
POST /api/projects/{project_id}/media/import
GET  /api/projects/{project_id}/media
GET  /api/media/{media_id}/thumbnail
```

Import behavior:

1. Validate file exists.
2. Check file size against `MAX_IMPORT_FILE_GB`.
3. Compute sha256 or partial hash.
4. Copy or reference the file according to local setting.
5. Probe duration/width/height using FFmpeg.
6. Generate thumbnail.
7. Create database record.

For MVP, use copy mode by default, because it makes project folders self-contained.

**STOP FOR USER CHECK:** Before importing a file larger than 30 GB, stop and ask whether to continue. Large videos can take time and storage.

### 6.3 Transcription endpoints

```text
POST /api/projects/{project_id}/transcribe
GET  /api/projects/{project_id}/transcript
```

Transcription behavior:

1. Extract audio from the video into the project cache.
2. Send audio to OpenAI Whisper model configured by `OPENAI_TRANSCRIBE_MODEL`.
3. Save raw JSON.
4. Save plain text.
5. Save segments and words if returned.
6. Mark project as `transcribed`.

**STOP FOR USER CHECK:** If the extracted audio file is very long, for example over 2 hours, estimate that this may cost money and take time, then ask the user to confirm before sending it to OpenAI.

### 6.4 AI cut endpoints

```text
POST /api/projects/{project_id}/ai/cuts
POST /api/projects/{project_id}/timeline/apply-cuts
GET  /api/projects/{project_id}/timeline
```

AI cut behavior:

1. Load transcript.
2. Ask GPT to produce a structured JSON cut plan.
3. Validate JSON strictly.
4. Save the cut plan.
5. Show it to the user before applying.

GPT must not directly edit files. It only returns timestamps and reasons.

Expected AI output:

```json
{
  "cuts": [
    {
      "source_media_id": "vid_abc123",
      "start": 12.4,
      "end": 85.2,
      "label": "setup explanation",
      "reason": "keeps useful context"
    }
  ],
  "removed_sections": [
    {
      "start": 85.2,
      "end": 144.0,
      "reason": "repetition"
    }
  ]
}
```

Validation rules:

- `start` must be greater than or equal to 0.
- `end` must be less than or equal to video duration.
- `end` must be greater than `start`.
- Clips shorter than 0.5 seconds should be rejected.
- Overlapping clips should be merged or rejected.
- The final cut plan must be sorted.
- Add optional 0.2 to 0.5 second padding if user enables it.

**STOP FOR USER CHECK:** Do not automatically apply or render AI-generated cuts without showing the proposed cut list first.

### 6.5 Render endpoints

```text
POST /api/projects/{project_id}/render
GET  /api/jobs/{job_id}
GET  /api/projects/{project_id}/exports
```

Render behavior:

1. Load timeline.
2. Build an FFmpeg command.
3. Render to `projects/{id}/renders/`.
4. Store output as a MediaAsset of type `export`.
5. Mark job as completed or failed.

**STOP FOR USER CHECK:** Before running any FFmpeg command that overwrites an existing render, ask the user or write to a new versioned filename. Never overwrite silently.

---

## 7. Local Storage Layout

Each project should have this folder layout:

```text
~/.local_ai_video_editor/projects/{project_id}/
  project.json
  media/
    original/
    proxy/
    audio/
    images/
    overlays/
  thumbnails/
  transcripts/
    transcript_raw.json
    transcript.txt
  timelines/
    timeline_v1.json
    ai_cut_plan_v1.json
  renders/
  cache/
```

Naming rules:

- Use internal IDs, not raw filenames, for stored files.
- Preserve the original filename in metadata.
- Use versioned outputs: `export_v1.mp4`, `export_v2.mp4`, etc.
- Never modify files in `media/original/` after import.

---

## 8. UI Plan

The home screen should be inspired by the provided screenshot, but simpler.

### 8.1 Layout

Left sidebar:

```text
Account / Login placeholder
Home
Cloud Storage placeholder
Settings
```

Main area:

```text
Project card grid
Last card: + Start Creation
```

### 8.2 Project card

Each card should show:

```text
thumbnail
title
file size | duration
transcript status
storage status
last edited time
```

Example:

```text
Create Tutorial 11
7.3 GB | 26:46
Transcript ready
Local only
```

### 8.3 Start Creation flow

Clicking `+ Start Creation` opens:

```text
1. Choose video file
2. Create project
3. Import video
4. Transcribe
5. Ask AI to cut
6. Review cuts
7. Render
```

### 8.4 Project detail page

Include:

- Video preview.
- Transcript panel.
- AI prompt box.
- Proposed cuts list.
- Apply cuts button.
- Render button.
- Export list.

For MVP, a full visual timeline is optional. A cut list with preview buttons is enough.

---

## 9. AI Cut Prompt Design

Create a backend prompt template like this:

```text
You are an assistant inside a video editor. Your job is to choose video sections to keep based on the transcript.

Rules:
- Return only valid JSON.
- Do not invent timestamps.
- Use only timestamps that exist in the transcript.
- Prefer preserving full explanations.
- Avoid cutting mid-sentence when possible.
- If uncertain, keep slightly more context.

User goal:
{user_goal}

Transcript:
{transcript_chunks}

Return schema:
{
  "cuts": [
    {
      "start": number,
      "end": number,
      "label": string,
      "reason": string
    }
  ],
  "removed_sections": [
    {
      "start": number,
      "end": number,
      "reason": string
    }
  ]
}
```

Cursor should implement chunking for long transcripts. If the transcript is too large for one model request, do this:

```text
1. Split transcript into time-ordered chunks.
2. Ask GPT to suggest keeps/removes per chunk.
3. Merge all suggestions.
4. Run a final cleanup pass to remove overlaps and smooth boundaries.
```

**STOP FOR USER CHECK:** If implementing transcript chunking becomes complex, stop after single-video/single-request support and ask the user to test with shorter videos first.

---

## 10. Overlay System

Do not build complex overlay editing at first. Build a simple timeline representation that can support overlays later.

### 10.1 Text overlay item

```json
{
  "type": "text",
  "text": "Example title",
  "timeline_start": 2.0,
  "timeline_end": 6.0,
  "x": 0.5,
  "y": 0.85,
  "anchor": "center",
  "font_size": 36
}
```

### 10.2 Image overlay item

```json
{
  "type": "image_overlay",
  "media_id": "img_123",
  "timeline_start": 10.0,
  "timeline_end": 18.0,
  "x": 0.72,
  "y": 0.08,
  "width": 0.22
}
```

### 10.3 Video overlay item

```json
{
  "type": "video_overlay",
  "media_id": "vid_overlay_123",
  "source_start": 0.0,
  "source_end": 8.0,
  "timeline_start": 20.0,
  "x": 0.68,
  "y": 0.08,
  "width": 0.28
}
```

**STOP FOR USER CHECK:** Do not attempt a full drag-and-drop overlay editor before the transcript cutting workflow works end-to-end.

---

## 11. Asset Description System

Each image and video asset should support:

```text
manual description
tags
optional AI-generated description later
optional embedding later
```

This prepares the future feature where AI can inject relevant images/videos into the main video based on transcript meaning.

Future workflow:

```text
Transcript says: "mechanical power"
→ AI searches asset descriptions
→ finds an image tagged "Create mod mechanical power"
→ suggests placing it as a small overlay frame
→ user approves
→ render includes overlay
```

Do not implement automatic injection yet. Only implement asset descriptions and manual overlay insertion first.

---

## 12. Cloud and Server Plan

Do not build cloud in the MVP.

Future cloud behavior:

```text
Default:
- original footage stays local
- finished videos can be uploaded
- project metadata can be synced
- original footage can be uploaded only if user chooses backup
```

Future storage statuses:

```text
local_only
final_uploaded
original_backed_up
original_missing_local
ready_to_download
```

When the app becomes online:

```text
Frontend → FastAPI server → PostgreSQL → object storage/local large disk → workers
```

For small-medium users and infrequent requests, start with:

```text
one server
large disk
PostgreSQL
FastAPI
one or two worker processes
object storage later
```

**STOP FOR USER CHECK:** Before implementing online accounts, remote storage, public server deployment, or user-uploaded cloud media, stop and ask the user to confirm the storage provider, privacy model, and budget.

---

## 13. Testing Requirements

Cursor should add tests as features are built.

### 13.1 Unit tests

Test:

- project creation
- media path generation
- hash calculation
- transcript parsing
- AI cut JSON validation
- timeline creation
- render job state transitions

### 13.2 Integration tests

Use a tiny sample video generated by FFmpeg during tests. Do not commit large media files.

Test:

```text
create project
import tiny video
extract audio
mock transcription
mock GPT cuts
apply timeline
render output
verify output file exists
```

### 13.3 Manual tests

Create `docs/manual-test-checklist.md` with:

```text
[ ] Can start backend
[ ] Can start frontend
[ ] Can create project
[ ] Can import video
[ ] Thumbnail appears
[ ] Can transcribe
[ ] Transcript appears
[ ] Can ask AI for cuts
[ ] Cut list appears
[ ] Can apply cuts
[ ] Can render
[ ] Export plays correctly
```

---

## 14. Phase-by-Phase Build Plan

### Phase 1 — Backend skeleton

Build:

- FastAPI app.
- SQLite database.
- project model.
- project CRUD endpoints.
- health endpoint.
- `.env.example`.
- README start instructions.

Definition of done:

```text
GET /health returns ok
POST /api/projects creates project
GET /api/projects lists projects
tests pass
```

### Phase 2 — Media import

Build:

- import video endpoint.
- local project folder creation.
- safe file copy.
- FFmpeg probe.
- thumbnail generation.
- media asset database record.

Definition of done:

```text
User can import a video
Project has media/original file
Thumbnail is generated
Duration and dimensions are stored
Original is not modified
```

**STOP FOR USER CHECK:** Stop after this phase and ask the user to import one real video and confirm the project card data looks correct.

### Phase 3 — Frontend home screen

Build:

- left sidebar.
- account placeholder.
- project grid.
- project cards.
- `+ Start Creation` card as the last card.
- import flow.

Definition of done:

```text
UI looks similar in structure to the screenshot but simpler
User can create/import from UI
Project cards update after import
```

### Phase 4 — Transcription

Build:

- audio extraction service.
- OpenAI transcription service.
- transcript storage.
- transcript viewer UI.
- job status UI.

Definition of done:

```text
User clicks Transcribe
Audio is extracted
OpenAI Whisper returns transcript
Transcript is saved and displayed
Project status becomes transcribed
```

**STOP FOR USER CHECK:** Stop after this phase and ask the user to confirm transcription speed, language recognition, and cost acceptability.

### Phase 5 — GPT cut planning

Build:

- AI cut prompt.
- GPT call service.
- strict JSON validation.
- proposed cut list UI.
- reasons for each cut.
- no automatic apply yet.

Definition of done:

```text
User enters editing goal
App returns proposed keep sections
Each section has start, end, label, reason
Invalid model output is rejected safely
```

**STOP FOR USER CHECK:** Stop after this phase and ask the user to review whether the AI cut quality is good enough.

### Phase 6 — Apply cuts and render

Build:

- timeline creation from cut plan.
- FFmpeg render service.
- render job status.
- export file listing.
- final video playback/download from UI.

Definition of done:

```text
User approves cut plan
App creates timeline
App renders final MP4
Export plays correctly
Original file remains unchanged
```

### Phase 7 — Simple overlays

Build:

- manual text overlay.
- manual image overlay.
- manual small video overlay.
- overlay timeline JSON.
- FFmpeg overlay render support.

Definition of done:

```text
User can add one text overlay
User can add one image overlay
User can add one small video overlay
Rendered video includes overlays
```

**STOP FOR USER CHECK:** Stop before attempting drag-and-drop or automatic AI overlay injection.

### Phase 8 — Asset descriptions

Build:

- description field for image/video assets.
- tag editing UI.
- asset library list.
- search by text/tags.

Definition of done:

```text
User can describe assets
User can search assets by description/tag
Descriptions are stored and loaded
```

### Phase 9 — Cloud final export placeholder

Build only a local interface placeholder first:

- upload final button disabled or mock mode.
- storage status display.
- settings page for future provider.

Definition of done:

```text
UI shows where cloud upload will go
No real cloud upload happens yet
```

**STOP FOR USER CHECK:** Stop and ask which storage provider to use before implementing real upload.

---

## 15. Risk Rules

Cursor must stop and ask for approval before doing any of these:

1. Deleting local video files.
2. Overwriting existing rendered exports.
3. Sending videos longer than 2 hours to OpenAI.
4. Uploading any original video to the internet.
5. Implementing payment or subscriptions.
6. Creating public user accounts.
7. Deploying a public server.
8. Changing the database in a way that may break existing projects.
9. Installing unusually heavy dependencies.
10. Changing from local-first to cloud-first behavior.

---

## 16. Non-Goals for MVP

Do not build these until the core workflow is working:

```text
real-time collaborative editing
cloud-only editing
mobile app
advanced timeline editor
multi-user permission system
billing system
automatic AI overlay injection
full plugin architecture
complex transitions
voice cloning
AI video generation
```

---

## 17. Final Cursor Command

Cursor should start with this task:

```text
Create the initial repo for the local-first AI video editor described in docs/cursor_plan.md.
Implement Phase 1 only: FastAPI backend skeleton, SQLite database, project model, project CRUD endpoints, health endpoint, .env.example, README, and basic tests. Do not implement media import, OpenAI calls, rendering, frontend, cloud, or auth yet. Stop after Phase 1 and show me how to run and test it.
```

After Phase 1 works, continue phase by phase.

---

## 18. References for Later Implementation

- OpenAI Speech-to-Text API docs: https://platform.openai.com/docs/guides/speech-to-text
- OpenAI API key safety guidance: https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety
- FFmpeg documentation: https://ffmpeg.org/documentation.html
- FastAPI documentation: https://fastapi.tiangolo.com/
- SQLite documentation: https://sqlite.org/docs.html
