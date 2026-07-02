"""Database models.

Phase 1 only defines the Project entity. Later phases add media, transcripts,
timelines, and render jobs. Enum values match the plan's documented lifecycle.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum

from sqlmodel import Field, SQLModel


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _new_id() -> str:
    return uuid.uuid4().hex


class ProjectStatus(str, Enum):
    empty = "empty"
    imported = "imported"
    transcribing = "transcribing"
    transcribed = "transcribed"
    ai_cut_ready = "ai_cut_ready"
    rendering = "rendering"
    rendered = "rendered"
    error = "error"


class StorageMode(str, Enum):
    local_only = "local_only"
    final_uploaded = "final_uploaded"
    original_backed_up = "original_backed_up"
    original_missing_local = "original_missing_local"


class Project(SQLModel, table=True):
    __tablename__ = "projects"

    id: str = Field(default_factory=_new_id, primary_key=True)
    name: str = Field(index=True)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)
    thumbnail_path: str | None = Field(default=None)
    status: ProjectStatus = Field(default=ProjectStatus.empty)
    storage_mode: StorageMode = Field(default=StorageMode.local_only)

    # Soft-delete marker. The plan forbids destructive deletion in early phases,
    # so DELETE marks this timestamp instead of removing rows or files.
    deleted_at: datetime | None = Field(default=None)
