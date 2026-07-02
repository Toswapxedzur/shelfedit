"""Per-project folder layout on disk.

Mirrors the layout documented in the plan. Files are stored under internal IDs;
the original filename is preserved only in the database record.
"""

from __future__ import annotations

from pathlib import Path

from ..config import get_settings

# Subfolders created inside every project directory.
_PROJECT_SUBDIRS = (
    "media/original",
    "media/proxy",
    "media/audio",
    "media/images",
    "media/overlays",
    "thumbnails",
    "transcripts",
    "timelines",
    "renders",
    "cache",
)


def project_dir(project_id: str) -> Path:
    return get_settings().app_data_dir / "projects" / project_id


def ensure_project_dirs(project_id: str) -> Path:
    """Create the full folder tree for a project and return its root."""
    root = project_dir(project_id)
    for sub in _PROJECT_SUBDIRS:
        (root / sub).mkdir(parents=True, exist_ok=True)
    return root


def original_media_dir(project_id: str) -> Path:
    return project_dir(project_id) / "media" / "original"


def thumbnails_dir(project_id: str) -> Path:
    return project_dir(project_id) / "thumbnails"
