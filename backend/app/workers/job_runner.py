"""Background job runner.

Runs long tasks (transcription now) off the request thread and records progress
on a Job row that the UI polls. Each run uses its own database session because
it executes on a separate thread.
"""

from __future__ import annotations

import json
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
    StorageKind,
    Timeline,
    Transcript,
    TranscriptSegment,
    TranscriptWord,
)
from ..services import render_service, transcription_service as tx
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


def _referenced_media_ids(data: dict) -> set[str]:
    ids: set[str] = set()
    for track in data.get("tracks", []):
        for el in track.get("elements", []):
            mid = el.get("media_id")
            if mid:
                ids.add(mid)
    return ids


def _has_text(data: dict) -> bool:
    for track in data.get("tracks", []):
        if track.get("kind") == "text":
            for el in track.get("elements", []):
                if (el.get("text") or "").strip():
                    return True
    return False


def _build_media_map(
    session: Session, project_id: str, data: dict
) -> dict[str, render_service.MediaInfo]:
    """Resolve every media_id referenced by the timeline to path + probe info."""
    media_map: dict[str, render_service.MediaInfo] = {}
    for mid in _referenced_media_ids(data):
        asset = session.get(MediaAsset, mid)
        if asset is None or asset.project_id != project_id:
            continue
        path = Path(asset.local_path)
        if not path.exists():
            continue
        has_audio = False
        try:
            has_audio = ffmpeg.has_audio_stream(path)
        except ffmpeg.FFmpegError:
            has_audio = False
        media_map[mid] = render_service.MediaInfo(
            path=str(path),
            width=asset.width,
            height=asset.height,
            has_audio=has_audio,
        )
    return media_map


def _next_export_path(project_id: str) -> Path:
    """A fresh, versioned export filename — never overwrites an existing one."""
    rdir = paths.renders_dir(project_id)
    rdir.mkdir(parents=True, exist_ok=True)
    version = 1
    while (rdir / f"export_v{version}.mp4").exists():
        version += 1
    return rdir / f"export_v{version}.mp4"


def _run_render(job_id: str) -> None:
    with Session(engine) as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        project = session.get(Project, job.project_id)
        if project is None:
            _update_job(session, job, status=JobStatus.error, error="Project missing")
            return

        timeline = session.exec(
            select(Timeline)
            .where(Timeline.project_id == project.id)
            .order_by(Timeline.version.desc())  # type: ignore[union-attr]
        ).first()
        if timeline is None:
            _update_job(
                session, job, status=JobStatus.error, error="No timeline to render"
            )
            return

        data = json.loads(timeline.data_json)
        media_map = _build_media_map(session, project.id, data)
        if not media_map and not _has_text(data):
            _update_job(
                session, job, status=JobStatus.error, error="Timeline has no clips"
            )
            return

        prior_status = project.status
        try:
            _update_job(
                session,
                job,
                status=JobStatus.running,
                progress=0.05,
                message="Preparing render",
            )
            project.status = ProjectStatus.rendering
            session.add(project)
            session.commit()

            output_path = _next_export_path(project.id)

            # Throttle DB writes: only commit when progress moves a bit.
            last = {"p": 0.0}

            def on_progress(p: float) -> None:
                scaled = 0.1 + 0.85 * p
                if scaled - last["p"] >= 0.02:
                    last["p"] = scaled
                    _update_job(
                        session, job, progress=scaled, message="Rendering video"
                    )

            render_service.render_timeline(
                data,
                media_map,
                output_path,
                on_progress=on_progress,
            )

            _update_job(session, job, progress=0.96, message="Finalizing export")
            _persist_export(session, project, output_path)

            project.status = ProjectStatus.rendered
            project.updated_at = _utcnow()
            session.add(project)
            session.commit()

            _update_job(
                session,
                job,
                status=JobStatus.done,
                progress=1.0,
                message="Render complete",
            )
        except ffmpeg.FFmpegError as e:
            _restore_status(session, project, prior_status)
            _update_job(session, job, status=JobStatus.error, error=str(e))
        except Exception as e:  # noqa: BLE001
            _restore_status(session, project, prior_status)
            _update_job(
                session, job, status=JobStatus.error, error=f"Unexpected error: {e}"
            )


def _restore_status(session: Session, project: Project, status: ProjectStatus) -> None:
    project.status = status
    project.updated_at = _utcnow()
    session.add(project)
    session.commit()


def _persist_export(session: Session, project: Project, output_path: Path) -> MediaAsset:
    probe = ffmpeg.probe(output_path)
    asset = MediaAsset(
        project_id=project.id,
        type=MediaType.export,
        storage_kind=StorageKind.copied,
        original_filename=output_path.name,
        local_path=str(output_path),
        relative_path=f"renders/{output_path.name}",
        duration_seconds=probe.duration_seconds,
        width=probe.width,
        height=probe.height,
        size_bytes=output_path.stat().st_size,
    )
    session.add(asset)
    session.commit()
    session.refresh(asset)
    return asset


def start_render_job(job_id: str) -> None:
    """Spawn the render worker on a daemon thread."""
    threading.Thread(target=_run_render, args=(job_id,), daemon=True).start()
