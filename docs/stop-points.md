# Stop points (checkpoints for user confirmation)

The app pauses and asks for your confirmation before doing anything risky or
costly. These mirror the safety rules in the plan.

## Build-time stop points (between phases)

- **After Phase 1 (backend skeleton):** confirm the server runs and project CRUD
  works before adding media import. ← we are here.
- **After Phase 2 (media import):** import one real video and confirm the project
  data looks correct.
- **After Phase 4 (transcription):** confirm transcription speed, language accuracy,
  and cost are acceptable.
- **After Phase 5 (AI cut planning):** confirm the AI cut quality is good enough.

## Runtime stop points (inside the app, later phases)

- Before importing a file larger than the configured limit (default 30 GB).
- Before sending audio longer than ~2 hours to OpenAI (time + cost warning).
- Before applying or rendering AI-generated cuts (always show the plan first).
- Before overwriting an existing render (write a new versioned file instead).
- Before any destructive project/file deletion.
- Before uploading any original footage, or enabling accounts / online deployment.

## Guarantees already enforced in Phase 1

- `DELETE /api/projects/{id}` is a **soft delete**: it marks the record and removes
  no files.
- Original media files are never modified.
- Secrets live only in `backend/.env` (git-ignored).
