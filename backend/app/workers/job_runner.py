"""Background job runner.

Runs long tasks (transcription now) off the request thread and records progress
on a Job row that the UI polls. Each run uses its own database session because
it executes on a separate thread.
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import Session, select

from ..config import get_settings
from ..database import engine
from ..models import (
    Job,
    JobStatus,
    MediaAsset,
    MediaType,
    Project,
    ProjectStatus,
    Transcript,
    TranscriptSegment,
    TranscriptWord,
)
from ..services import transcription_service as tx
from ..utils import ffmpeg, paths


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _update_job(
    session: Session,
    job: Job,
    *,
    status: JobStatus | None = None,
    progress: float | None = None,
    message: str | None = None,
    error: str | None = None,
) -> None:
    if status is not None:
        job.status = status
    if progress is not None:
        job.progress = progress
    if message is not None:
        job.message = message
    if error is not None:
        job.error_message = error
    job.updated_at = _utcnow()
    session.add(job)
    session.commit()


def _run_transcription(job_id: str) -> None:
    settings = get_settings()
    with Session(engine) as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        project = session.get(Project, job.project_id)
        if project is None:
            _update_job(session, job, status=JobStatus.error, error="Project missing")
            return

        video = session.exec(
            select(MediaAsset)
            .where(MediaAsset.project_id == project.id)
            .where(MediaAsset.type == MediaType.video)
        ).first()
        if video is None:
            _update_job(
                session, job, status=JobStatus.error, error="No video to transcribe"
            )
            return

        try:
            _update_job(
                session,
                job,
                status=JobStatus.running,
                progress=0.1,
                message="Extracting audio",
            )
            project.status = ProjectStatus.transcribing
            session.add(project)
            session.commit()

            audio_path = paths.audio_dir(project.id) / f"{video.id}.mp3"
            ffmpeg.extract_audio(Path(video.local_path), audio_path)

            _update_job(
                session, job, progress=0.4, message="Transcribing audio"
            )
            result = tx.transcribe_audio_file(audio_path, settings)

            _update_job(session, job, progress=0.8, message="Saving transcript")
            _persist_transcript(session, project, video, result)

            project.status = ProjectStatus.transcribed
            project.updated_at = _utcnow()
            session.add(project)
            session.commit()

            _update_job(
                session,
                job,
                status=JobStatus.done,
                progress=1.0,
                message="Transcription complete",
            )
        except tx.MissingApiKeyError as e:
            _revert(session, project)
            _update_job(session, job, status=JobStatus.error, error=str(e))
        except (ffmpeg.FFmpegError, tx.TranscriptionError) as e:
            _revert(session, project)
            _update_job(session, job, status=JobStatus.error, error=str(e))
        except Exception as e:  # noqa: BLE001
            _revert(session, project)
            _update_job(
                session, job, status=JobStatus.error, error=f"Unexpected error: {e}"
            )


def _revert(session: Session, project: Project) -> None:
    project.status = ProjectStatus.imported
    project.updated_at = _utcnow()
    session.add(project)
    session.commit()


def _persist_transcript(
    session: Session,
    project: Project,
    video: MediaAsset,
    result: tx.NormalizedTranscript,
) -> Transcript:
    tdir = paths.transcripts_dir(project.id)
    raw_path = tdir / "transcript_raw.json"
    tx.save_raw_json(result.raw, raw_path)
    (tdir / "transcript.txt").write_text(result.text)

    settings = get_settings()
    transcript = Transcript(
        project_id=project.id,
        media_asset_id=video.id,
        language=result.language,
        provider="openai" if not settings.fake_transcribe else "offline",
        model=settings.openai_transcribe_model,
        raw_json_path=str(raw_path),
        plain_text=result.text,
    )
    session.add(transcript)
    session.commit()
    session.refresh(transcript)

    for i, seg in enumerate(result.segments):
        session.add(
            TranscriptSegment(
                transcript_id=transcript.id,
                idx=i,
                start_seconds=seg.start,
                end_seconds=seg.end,
                text=seg.text,
            )
        )
    for w in result.words:
        session.add(
            TranscriptWord(
                transcript_id=transcript.id,
                start_seconds=w.start,
                end_seconds=w.end,
                word=w.word,
            )
        )
    session.commit()
    return transcript


def start_transcription_job(job_id: str) -> None:
    """Spawn the transcription worker on a daemon thread."""
    threading.Thread(target=_run_transcription, args=(job_id,), daemon=True).start()
