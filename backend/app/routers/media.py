"""Media endpoints: import a local video, list media, serve thumbnails."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from ..database import get_session
from ..models import MediaAsset, Project
from ..schemas import MediaImportRequest, MediaRead
from ..services import media_service
from ..utils import ffmpeg, paths
from ..utils.ffmpeg import FFmpegError
from .projects import _get_active_project

router = APIRouter(tags=["media"])


@router.post(
    "/api/projects/{project_id}/media/import",
    response_model=MediaRead,
    status_code=status.HTTP_201_CREATED,
)
def import_media(
    project_id: str,
    payload: MediaImportRequest,
    session: Session = Depends(get_session),
):
    project: Project = _get_active_project(project_id, session)
    try:
        asset = media_service.import_media(
            session,
            project,
            payload.source_path,
            copy=payload.copy_into_project,
            confirm_large=payload.confirm_large,
        )
    except media_service.SourceFileError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except media_service.LargeFileConfirmationRequired as e:
        # 409: the client should re-send with confirm_large=true to proceed.
        gb = e.size_bytes / (1024**3)
        limit_gb = e.limit_bytes / (1024**3)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"File is {gb:.1f} GB, over the {limit_gb:.0f} GB limit. "
                "Re-send with confirm_large=true to import anyway."
            ),
        )
    except FFmpegError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Could not read video: {e}",
        )
    return asset


@router.get("/api/projects/{project_id}/media", response_model=list[MediaRead])
def list_media(project_id: str, session: Session = Depends(get_session)):
    _get_active_project(project_id, session)
    assets = session.exec(
        select(MediaAsset).where(MediaAsset.project_id == project_id)
    ).all()
    return assets


@router.get("/api/media/{media_id}/thumbnail")
def get_media_thumbnail(media_id: str, session: Session = Depends(get_session)):
    asset = session.get(MediaAsset, media_id)
    if asset is None or not asset.thumbnail_path:
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    path = Path(asset.thumbnail_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail file missing")
    return FileResponse(path, media_type="image/jpeg")


# Common video containers -> MIME type for the <video> element.
_VIDEO_MIME = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
}


@router.get("/api/media/{media_id}/file")
def get_media_file(media_id: str, session: Session = Depends(get_session)):
    """Stream the video file for in-app preview. Read-only; supports range."""
    asset = session.get(MediaAsset, media_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Media not found")
    path = Path(asset.local_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Media file missing")
    media_type = _VIDEO_MIME.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type, filename=asset.original_filename)


@router.get("/api/media/{media_id}/filmstrip")
def get_media_filmstrip(media_id: str, session: Session = Depends(get_session)):
    """A tiled strip of frames for the clip background (generated + cached)."""
    asset = session.get(MediaAsset, media_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Media not found")
    src = Path(asset.local_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Media file missing")

    dest = paths.cache_dir(asset.project_id) / f"filmstrip_{media_id}.jpg"
    if not dest.exists():
        try:
            ffmpeg.generate_filmstrip(
                src, dest, duration=asset.duration_seconds or 0.0
            )
        except FFmpegError as e:
            raise HTTPException(status_code=422, detail=str(e))
    return FileResponse(dest, media_type="image/jpeg")


@router.get("/api/media/{media_id}/waveform")
def get_media_waveform(media_id: str, session: Session = Depends(get_session)):
    """Normalized audio peaks for waveform drawing (generated + cached)."""
    asset = session.get(MediaAsset, media_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Media not found")
    src = Path(asset.local_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Media file missing")

    dest = paths.cache_dir(asset.project_id) / f"waveform_{media_id}.json"
    if dest.exists():
        return {"peaks": json.loads(dest.read_text())}
    try:
        peaks = ffmpeg.extract_waveform_peaks(src)
    except FFmpegError as e:
        raise HTTPException(status_code=422, detail=str(e))
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(peaks))
    return {"peaks": peaks}


@router.get("/api/projects/{project_id}/thumbnail")
def get_project_thumbnail(project_id: str, session: Session = Depends(get_session)):
    project = _get_active_project(project_id, session)
    if not project.thumbnail_path:
        raise HTTPException(status_code=404, detail="No thumbnail")
    path = Path(project.thumbnail_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail file missing")
    return FileResponse(path, media_type="image/jpeg")
