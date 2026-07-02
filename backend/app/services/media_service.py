"""Media import logic.

Imports a local video into a project. The source file is treated as read-only:
we either copy it into the project folder or reference it in place, never modify
or move the original.
"""

from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import Session

from ..config import get_settings
from ..models import (
    MediaAsset,
    MediaType,
    Project,
    ProjectStatus,
    StorageKind,
)
from ..utils import ffmpeg, hashing, paths

_GB = 1024**3


class LargeFileConfirmationRequired(Exception):
    """Raised when a file exceeds the configured limit and needs confirmation."""

    def __init__(self, size_bytes: int, limit_bytes: int) -> None:
        self.size_bytes = size_bytes
        self.limit_bytes = limit_bytes
        super().__init__("File exceeds import size limit; confirmation required.")


class SourceFileError(Exception):
    """Raised when the source path is missing or not a regular file."""


def _new_media_id() -> str:
    import uuid

    return "med_" + uuid.uuid4().hex[:16]


def import_media(
    session: Session,
    project: Project,
    source_path: str,
    *,
    copy: bool,
    confirm_large: bool = False,
) -> MediaAsset:
    settings = get_settings()
    src = Path(source_path).expanduser()

    if not src.exists() or not src.is_file():
        raise SourceFileError(f"File not found: {source_path}")

    size_bytes = src.stat().st_size
    limit_bytes = int(settings.max_import_file_gb * _GB)
    if size_bytes > limit_bytes and not confirm_large:
        raise LargeFileConfirmationRequired(size_bytes, limit_bytes)

    paths.ensure_project_dirs(project.id)
    media_id = _new_media_id()
    ext = src.suffix.lower()

    # Copy into the project (self-contained) or reference the original in place.
    if copy:
        dest = paths.original_media_dir(project.id) / f"{media_id}{ext}"
        shutil.copy2(src, dest)
        local_path = dest
        relative_path = str(dest.relative_to(paths.project_dir(project.id)))
        storage_kind = StorageKind.copied
    else:
        local_path = src.resolve()
        relative_path = None
        storage_kind = StorageKind.referenced

    sha = hashing.partial_hash(src)

    # Probe duration/dimensions and generate a thumbnail (best-effort).
    duration = width = height = None
    thumb_path: str | None = None
    try:
        info = ffmpeg.probe(local_path)
        duration, width, height = info.duration_seconds, info.width, info.height
    except ffmpeg.FFmpegError:
        pass

    try:
        at = 1.0
        if duration:
            at = min(1.0, duration * 0.1)
        thumb_dest = paths.thumbnails_dir(project.id) / f"{media_id}.jpg"
        ffmpeg.generate_thumbnail(local_path, thumb_dest, at_seconds=at)
        thumb_path = str(thumb_dest)
    except ffmpeg.FFmpegError:
        thumb_path = None

    asset = MediaAsset(
        id=media_id,
        project_id=project.id,
        type=MediaType.video,
        storage_kind=storage_kind,
        original_filename=src.name,
        local_path=str(local_path),
        relative_path=relative_path,
        sha256=sha,
        duration_seconds=duration,
        width=width,
        height=height,
        size_bytes=size_bytes,
        thumbnail_path=thumb_path,
    )
    session.add(asset)

    # Update the project: mark imported and adopt the thumbnail for its card.
    project.status = ProjectStatus.imported
    if thumb_path:
        project.thumbnail_path = thumb_path
    project.updated_at = datetime.now(timezone.utc)
    session.add(project)

    session.commit()
    session.refresh(asset)
    return asset
