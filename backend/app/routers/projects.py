"""Project CRUD endpoints.

Phase 1 scope. Deletion is intentionally non-destructive: it soft-deletes the
project record and never touches media files (per the plan's safety rules).
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from ..database import get_session
from ..models import MediaAsset, MediaType, Project
from ..schemas import ProjectCreate, ProjectRead, ProjectUpdate

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _get_active_project(project_id: str, session: Session) -> Project:
    project = session.get(Project, project_id)
    if project is None or project.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Project not found"
        )
    return project


def build_project_read(project: Project, session: Session) -> ProjectRead:
    """Attach a summary of the project's primary video (duration/size/count)."""
    assets = session.exec(
        select(MediaAsset).where(MediaAsset.project_id == project.id)
    ).all()
    primary = next((a for a in assets if a.type == MediaType.video), None)
    return ProjectRead(
        id=project.id,
        name=project.name,
        created_at=project.created_at,
        updated_at=project.updated_at,
        thumbnail_path=project.thumbnail_path,
        status=project.status,
        storage_mode=project.storage_mode,
        media_count=len(assets),
        duration_seconds=primary.duration_seconds if primary else None,
        size_bytes=primary.size_bytes if primary else None,
        has_thumbnail=bool(project.thumbnail_path),
    )


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectCreate, session: Session = Depends(get_session)):
    project = Project(name=payload.name, storage_mode=payload.storage_mode)
    session.add(project)
    session.commit()
    session.refresh(project)
    return build_project_read(project, session)


@router.get("", response_model=list[ProjectRead])
def list_projects(session: Session = Depends(get_session)):
    statement = (
        select(Project)
        .where(Project.deleted_at.is_(None))  # type: ignore[union-attr]
        .order_by(Project.created_at.desc())  # type: ignore[union-attr]
    )
    projects = session.exec(statement).all()
    return [build_project_read(p, session) for p in projects]


@router.get("/{project_id}", response_model=ProjectRead)
def get_project(project_id: str, session: Session = Depends(get_session)):
    project = _get_active_project(project_id, session)
    return build_project_read(project, session)


@router.patch("/{project_id}", response_model=ProjectRead)
def update_project(
    project_id: str,
    payload: ProjectUpdate,
    session: Session = Depends(get_session),
):
    project = _get_active_project(project_id, session)
    updates = payload.model_dump(exclude_unset=True)
    for key, value in updates.items():
        setattr(project, key, value)
    project.updated_at = _utcnow()
    session.add(project)
    session.commit()
    session.refresh(project)
    return build_project_read(project, session)


@router.delete("/{project_id}", status_code=status.HTTP_200_OK)
def delete_project(project_id: str, session: Session = Depends(get_session)):
    """Soft-delete only. Never removes media files in this phase."""
    project = _get_active_project(project_id, session)
    project.deleted_at = _utcnow()
    session.add(project)
    session.commit()
    return {"id": project_id, "deleted": True, "files_removed": False}
