"""Request/response schemas for the API.

Separate from database models so the wire format can evolve independently of
storage. Phase 1 covers project create/update/read shapes.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from typing import Any

from .models import (
    AiRole,
    ChangeStatus,
    JobKind,
    JobStatus,
    MediaType,
    ProjectStatus,
    StorageKind,
    StorageMode,
)


class CanvasSpec(BaseModel):
    """The project's output canvas: compositing resolution + frame rate."""

    width: int = Field(default=1280, ge=16, le=7680)
    height: int = Field(default=720, ge=16, le=4320)
    fps: int = Field(default=30, ge=1, le=120)


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    storage_mode: StorageMode = StorageMode.local_only
    # Optional project setup chosen in the create panel. When given, the
    # initial timeline is seeded with this canvas.
    canvas: CanvasSpec | None = None


class RenderRequest(BaseModel):
    """Export options chosen in the export panel."""

    container: str = Field(default="mp4", pattern="^(mp4|mov|webm)$")
    quality: str = Field(default="high", pattern="^(high|medium|low)$")
    # Final output resolution / fps. None → use the project canvas.
    width: int | None = Field(default=None, ge=16, le=7680)
    height: int | None = Field(default=None, ge=16, le=4320)
    fps: int | None = Field(default=None, ge=1, le=120)
    # Base filename (no extension) when saving into the project folder.
    filename: str | None = Field(default=None, max_length=200)
    # Absolute path chosen via the native save dialog. When set, the render is
    # written there instead of the project's renders folder.
    output_path: str | None = Field(default=None, max_length=1024)


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
    # Asset-library classification: a single editable category + free-form tags.
    category: str | None = None
    tags: list[str] = []
    # True once an optimized preview proxy exists (preview then decodes that).
    proxy_ready: bool = False
    created_at: datetime


class MediaClassifyRequest(BaseModel):
    # Any subset may be provided; omitted fields are left unchanged.
    category: str | None = None
    tags: list[str] | None = None
    description: str | None = None


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


class AiSendRequest(BaseModel):
    content: str = Field(min_length=1, max_length=4000)


class AiMessageRead(BaseModel):
    id: str
    role: AiRole
    content: str
    change: dict[str, Any] | None = None
    change_status: ChangeStatus | None = None
    created_at: datetime


class TimelineRead(BaseModel):
    id: str
    version: int
    data: dict[str, Any]
    created_at: datetime


class TimelineSave(BaseModel):
    data: dict[str, Any]


class HealthResponse(BaseModel):
    status: str = "ok"
    app: str
