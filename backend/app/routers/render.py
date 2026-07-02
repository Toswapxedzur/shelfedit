"""Render endpoints: start a render job, list exported videos."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from ..database import get_session
from ..models import Job, JobKind, JobStatus, MediaAsset, MediaType, Timeline
from ..schemas import JobRead, MediaRead
from ..utils.ffmpeg import ffmpeg_available
from ..workers import job_runner
from .projects import _get_active_project

router = APIRouter(tags=["render"])


@router.post(
    "/api/projects/{project_id}/render",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_render(project_id: str, session: Session = Depends(get_session)):
    _get_active_project(project_id, session)

    if not ffmpeg_available():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="FFmpeg is not installed. Install ffmpeg to render.",
        )

    timeline = session.exec(
        select(Timeline).where(Timeline.project_id == project_id)
    ).first()
    if timeline is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Apply an AI cut plan before rendering.",
        )

    job = Job(project_id=project_id, kind=JobKind.render, status=JobStatus.queued)
    session.add(job)
    session.commit()
    session.refresh(job)

    job_runner.start_render_job(job.id)
    return job


@router.get("/api/projects/{project_id}/exports", response_model=list[MediaRead])
def list_exports(project_id: str, session: Session = Depends(get_session)):
    _get_active_project(project_id, session)
    exports = session.exec(
        select(MediaAsset)
        .where(MediaAsset.project_id == project_id)
        .where(MediaAsset.type == MediaType.export)
        .order_by(MediaAsset.created_at.desc())  # type: ignore[union-attr]
    ).all()
    return exports