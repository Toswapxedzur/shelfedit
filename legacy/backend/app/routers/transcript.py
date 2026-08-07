"""Transcription endpoints: start a job, poll job status, read the transcript."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from ..config import get_settings
from ..database import get_session
from ..models import (
    Job,
    JobKind,
    JobStatus,
    MediaAsset,
    MediaType,
    Transcript,
    TranscriptSegment,
)
from ..schemas import JobRead, TranscribeRequest, TranscriptRead
from ..workers import job_runner
from .projects import _get_active_project

router = APIRouter(tags=["transcription"])


@router.post(
    "/api/projects/{project_id}/transcribe",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_transcription(
    project_id: str,
    payload: TranscribeRequest,
    session: Session = Depends(get_session),
):
    project = _get_active_project(project_id, session)
    settings = get_settings()

    video = session.exec(
        select(MediaAsset)
        .where(MediaAsset.project_id == project_id)
        .where(MediaAsset.type == MediaType.video)
    ).first()
    if video is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Import a video before transcribing.",
        )

    # Require a key up front (unless offline/fake mode) so the user gets a clear
    # message instead of a failed background job.
    if not settings.fake_transcribe and not settings.openai_api_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "No OpenAI API key configured. Add OPENAI_API_KEY to "
                "backend/.env and restart, then try again."
            ),
        )

    # Long-audio cost/time guard.
    warn_seconds = settings.transcribe_warn_minutes * 60
    if (
        video.duration_seconds
        and video.duration_seconds > warn_seconds
        and not payload.confirm_long
    ):
        minutes = video.duration_seconds / 60
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"This video is about {minutes:.0f} minutes long. Transcribing "
                "it may take time and cost money. Re-send with confirm_long=true "
                "to proceed."
            ),
        )

    job = Job(project_id=project_id, kind=JobKind.transcribe, status=JobStatus.queued)
    session.add(job)
    session.commit()
    session.refresh(job)

    job_runner.start_transcription_job(job.id)
    return job


@router.get("/api/jobs/{job_id}", response_model=JobRead)
def get_job(job_id: str, session: Session = Depends(get_session)):
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/api/projects/{project_id}/transcript", response_model=TranscriptRead)
def get_transcript(project_id: str, session: Session = Depends(get_session)):
    _get_active_project(project_id, session)
    transcript = session.exec(
        select(Transcript)
        .where(Transcript.project_id == project_id)
        .order_by(Transcript.created_at.desc())  # type: ignore[union-attr]
    ).first()
    if transcript is None:
        raise HTTPException(status_code=404, detail="No transcript yet")

    segments = session.exec(
        select(TranscriptSegment)
        .where(TranscriptSegment.transcript_id == transcript.id)
        .order_by(TranscriptSegment.idx)  # type: ignore[arg-type]
    ).all()

    return TranscriptRead(
        id=transcript.id,
        language=transcript.language,
        provider=transcript.provider,
        model=transcript.model,
        plain_text=transcript.plain_text,
        created_at=transcript.created_at,
        segments=list(segments),
    )
