"""Request/response schemas for the API.

Separate from database models so the wire format can evolve independently of
storage. Phase 1 covers project create/update/read shapes.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from .models import ProjectStatus, StorageMode


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


class HealthResponse(BaseModel):
    status: str = "ok"
    app: str
