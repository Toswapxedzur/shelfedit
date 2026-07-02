"""Request/response schemas for the API.

Separate from database models so the wire format can evolve independently of
storage. Phase 1 covers project create/update/read shapes.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from .models import (
    JobKind,
    JobStatus,
    MediaType,
    ProjectStatus,
    StorageKind,
    StorageMode,
)


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    storage_mode: StorageMode = StorageMode.local_only


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    status: ProjectStatus | None = None
    storage_mode: StorageMode | None = None
    thumbnail_path: str | None = None


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    created_at: datetime
    updated_at: datetime
    thumbnail_path: str | None
    status: ProjectStatus
    storage_mode: StorageMode

    # Summary of the project's primary video, filled in by the API when known.
    media_count: int = 0
    duration_seconds: float | None = None
    size_bytes: int | None = None
    has_thumbnail: bool = False


class MediaImportRequest(BaseModel):
    # Accept the JSON key "copy" without shadowing BaseModel.copy().
    model_config = ConfigDict(populate_by_name=True)

    # Absolute path to a local video file. The backend never receives the file
    # bytes over HTTP; it reads the file directly from disk (local-first).
    source_path: str = Field(min_length=1)
    # True = copy into the project folder; False = reference in place.
    copy_into_project: bool = Field(default=True, alias="copy")
    # Set true to proceed past the large-file size guard.
    confirm_large: bool = False


class MediaRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    type: MediaType
    storage_kind: StorageKind
    original_filename: str
    relative_path: str | None
    duration_seconds: float | None
    width: int | None
    height: int | None
    size_bytes: int | None
    description: str | None
    created_at: datetime


class TranscribeRequest(BaseModel):
    # Proceed past the long-audio cost/time warning.
    confirm_long: bool = False


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    kind: JobKind
    status: JobStatus
    progress: float
    message: str | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime


class SegmentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    idx: int
    start_seconds: float
    end_seconds: float
    text: str


class TranscriptRead(BaseModel):
    id: str
    language: str | None
    provider: str
    model: str
    plain_text: str
    created_at: datetime
    segments: list[SegmentRead] = []


class HealthResponse(BaseModel):
    status: str = "ok"
    app: str
