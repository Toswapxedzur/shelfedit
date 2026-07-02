"""Project CRUD endpoints.

Phase 1 scope. Deletion is intentionally non-destructive: it soft-deletes the
project record and never touches media files (per the plan's safety rules).
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from ..database import get_session
from ..models import Project
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


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectCreate, session: Session = Depends(get_session)):
    project = Project(name=payload.name, storage_mode=payload.storage_mode)
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


@router.get("", response_model=list[ProjectRead])
def list_projects(session: Session = Depends(get_session)):
    statement = (
        select(Project)
        .where(Project.deleted_at.is_(None))  # type: ignore[union-attr]
        .order_by(Project.created_at.desc())  # type: ignore[union-attr]
    )
    return session.exec(statement).all()


@router.get("/{project_id}", response_model=ProjectRead)
def get_project(project_id: str, session: Session = Depends(get_session)):
    return _get_active_project(project_id, session)


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
    return project


@router.delete("/{project_id}", status_code=status.HTTP_200_OK)
def delete_project(project_id: str, session: Session = Depends(get_session)):
    """Soft-delete only. Never removes media files in this phase."""
    project = _get_active_project(project_id, session)
    project.deleted_at = _utcnow()
    session.add(project)
    session.commit()
    return {"id": project_id, "deleted": True, "files_removed": False}
