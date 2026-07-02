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


class MediaType(str, Enum):
    video = "video"
    image = "image"
    audio = "audio"
    proxy = "proxy"
    export = "export"


class StorageKind(str, Enum):
    """How the app holds the file on disk."""

    copied = "copied"  # copied into the project folder (self-contained)
    referenced = "referenced"  # left in place; we only store its path


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


class JobKind(str, Enum):
    transcribe = "transcribe"
    render = "render"


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    done = "done"
    error = "error"


class Job(SQLModel, table=True):
    """A background task (transcription now, rendering later)."""

    __tablename__ = "jobs"

    id: str = Field(default_factory=_new_id, primary_key=True)
    project_id: str = Field(index=True, foreign_key="projects.id")
    kind: JobKind
    status: JobStatus = Field(default=JobStatus.queued)
    progress: float = Field(default=0.0)  # 0.0 - 1.0
    message: str | None = Field(default=None)
    error_message: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class Transcript(SQLModel, table=True):
    __tablename__ = "transcripts"

    id: str = Field(default_factory=_new_id, primary_key=True)
    project_id: str = Field(index=True, foreign_key="projects.id")
    media_asset_id: str = Field(foreign_key="media_assets.id")
    language: str | None = Field(default=None)
    provider: str = Field(default="openai")
    model: str = Field(default="whisper-1")
    raw_json_path: str | None = Field(default=None)
    plain_text: str = Field(default="")
    created_at: datetime = Field(default_factory=_utcnow)


class TranscriptSegment(SQLModel, table=True):
    __tablename__ = "transcript_segments"

    id: str = Field(default_factory=_new_id, primary_key=True)
    transcript_id: str = Field(index=True, foreign_key="transcripts.id")
    idx: int = Field(default=0)
    start_seconds: float
    end_seconds: float
    text: str


class TranscriptWord(SQLModel, table=True):
    __tablename__ = "transcript_words"

    id: str = Field(default_factory=_new_id, primary_key=True)
    transcript_id: str = Field(index=True, foreign_key="transcripts.id")
    start_seconds: float
    end_seconds: float
    word: str
    confidence: float | None = Field(default=None)


class MediaAsset(SQLModel, table=True):
    __tablename__ = "media_assets"

    id: str = Field(default_factory=_new_id, primary_key=True)
    project_id: str = Field(index=True, foreign_key="projects.id")
    type: MediaType = Field(default=MediaType.video)

    # How we hold the file: copied into the project, or referenced in place.
    storage_kind: StorageKind = Field(default=StorageKind.copied)

    original_filename: str
    # Absolute path we read the file from (the copy, or the original if referenced).
    local_path: str
    # Path relative to the project folder when copied; None when referenced.
    relative_path: str | None = Field(default=None)

    sha256: str | None = Field(default=None)
    duration_seconds: float | None = Field(default=None)
    width: int | None = Field(default=None)
    height: int | None = Field(default=None)
    size_bytes: int | None = Field(default=None)

    description: str | None = Field(default=None)
    tags_json: str | None = Field(default=None)

    thumbnail_path: str | None = Field(default=None)

    created_at: datetime = Field(default_factory=_utcnow)
