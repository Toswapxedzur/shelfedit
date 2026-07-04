"""Media endpoints: import a local video, list media, serve thumbnails."""

from __future__ import annotations

import json
import threading
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from ..database import engine, get_session
from ..models import MediaAsset, Project
from ..schemas import MediaClassifyRequest, MediaImportRequest, MediaRead
from ..services import media_service
from ..utils import ffmpeg, paths
from ..utils.ffmpeg import FFmpegError
from .projects import _get_active_project

router = APIRouter(tags=["media"])


# Derived-asset (filmstrip / waveform) generation is CPU + full-file IO heavy.
# If it runs on-demand while the preview engine is streaming the same file over
# HTTP range requests, the two contend and the video decode underruns (the
# picture "sticks"). To avoid that we (1) pre-generate these at import time in
# the background, and (2) guard each output with a lock so a given asset is only
# ever generated once — concurrent callers wait for the single in-flight job
# instead of spawning a duplicate ffmpeg pass.
_gen_locks: dict[str, threading.Lock] = {}
_gen_locks_guard = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _gen_locks_guard:
        lock = _gen_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _gen_locks[key] = lock
        return lock


def _ensure_filmstrip(media_id: str, src: Path, project_id: str, duration: float) -> Path:
    dest = paths.cache_dir(project_id) / f"filmstrip_{media_id}.jpg"
    if dest.exists():
        return dest
    with _lock_for(str(dest)):
        if not dest.exists():
            ffmpeg.generate_filmstrip(src, dest, duration=duration)
    return dest


def _ensure_waveform(media_id: str, src: Path, project_id: str) -> Path:
    dest = paths.cache_dir(project_id) / f"waveform_{media_id}.json"
    if dest.exists():
        return dest
    with _lock_for(str(dest)):
        if not dest.exists():
            peaks = ffmpeg.extract_waveform_peaks(src)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps(peaks))
    return dest


def _warm_derived(media_id: str, src_path: str, project_id: str, duration: float) -> None:
    """Best-effort background pre-generation so editing never triggers ffmpeg."""
    src = Path(src_path)
    if not src.exists():
        return
    for fn in (
        lambda: _ensure_filmstrip(media_id, src, project_id, duration),
        lambda: _ensure_waveform(media_id, src, project_id),
    ):
        try:
            fn()
        except Exception:  # noqa: BLE001 — warming is best-effort
            pass


# The preview proxy is an optimized, downscaled, constant-frame-rate H.264 copy
# that the in-app preview decodes instead of the (possibly huge / VFR / heavy)
# original. Transcoding is expensive and full-file, so it runs once on a daemon
# thread, guarded so a media_id is only ever transcoded by one worker at a time.
_proxy_threads: set[str] = set()
_proxy_guard = threading.Lock()


def _ensure_proxy(media_id: str, src: Path, project_id: str) -> Path:
    dest = paths.proxy_path(project_id, media_id)
    if dest.exists():
        return dest
    with _lock_for(f"proxy:{dest}"):
        if not dest.exists():
            ffmpeg.generate_proxy(src, dest)
    return dest


def _start_proxy(media_id: str, src_path: str, project_id: str) -> bool:
    """Kick off proxy generation on a daemon thread if not already done/running.

    Returns True if the proxy already exists (ready now), else False.
    """
    if paths.proxy_path(project_id, media_id).exists():
        return True
    src = Path(src_path)
    if not src.exists():
        return False
    with _proxy_guard:
        if media_id in _proxy_threads:
            return False
        _proxy_threads.add(media_id)

    def _run() -> None:
        try:
            _ensure_proxy(media_id, src, project_id)
        except Exception:  # noqa: BLE001 — best-effort; preview falls back to original
            pass
        finally:
            with _proxy_guard:
                _proxy_threads.discard(media_id)

    threading.Thread(target=_run, daemon=True).start()
    return False


@router.post(
    "/api/projects/{project_id}/media/import",
    response_model=MediaRead,
    status_code=status.HTTP_201_CREATED,
)
def import_media(
    project_id: str,
    payload: MediaImportRequest,
    background: BackgroundTasks,
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
    # Pre-generate the filmstrip + waveform off the request path so they're
    # cached before the editor plays (and never compete with the decoder).
    background.add_task(
        _warm_derived,
        asset.id,
        asset.local_path,
        asset.project_id,
        asset.duration_seconds or 0.0,
    )
    # Start building the optimized preview proxy so the first play is smooth.
    _start_proxy(asset.id, asset.local_path, asset.project_id)
    return asset


@router.get("/api/projects/{project_id}/media", response_model=list[MediaRead])
def list_media(project_id: str, session: Session = Depends(get_session)):
    _get_active_project(project_id, session)
    assets = session.exec(
        select(MediaAsset).where(MediaAsset.project_id == project_id)
    ).all()
    return assets


@router.patch("/api/media/{media_id}", response_model=MediaRead)
def update_media(
    media_id: str,
    payload: MediaClassifyRequest,
    session: Session = Depends(get_session),
):
    """Edit an asset's library classification (category / tags / description)."""
    asset = session.get(MediaAsset, media_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Media not found")

    current = asset._classification()
    category = current["category"] if payload.category is None else payload.category
    tags = current["tags"] if payload.tags is None else payload.tags
    # Normalize/dedupe tags, drop blanks.
    clean_tags = []
    seen = set()
    for t in tags:
        s = str(t).strip()
        if s and s.lower() not in seen:
            seen.add(s.lower())
            clean_tags.append(s)
    asset.tags_json = json.dumps({"category": (category or None), "tags": clean_tags})
    if payload.description is not None:
        asset.description = payload.description or None
    session.add(asset)
    session.commit()
    session.refresh(asset)
    return asset


# These endpoints stream files back and can be requested many times
# concurrently (the preview engine demuxes/decodes via HTTP range requests, and
# the timeline requests filmstrips/waveforms per clip). They must NOT hold a DB
# connection for the whole streaming response — doing so exhausts the connection
# pool / locks SQLite under concurrency (500s + stalled reads). So they look up
# the asset in a short-lived session that closes *before* the file is streamed.
@router.get("/api/media/{media_id}/thumbnail")
def get_media_thumbnail(media_id: str):
    with Session(engine) as session:
        asset = session.get(MediaAsset, media_id)
        thumb = asset.thumbnail_path if asset else None
    if not thumb:
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    path = Path(thumb)
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
def get_media_file(media_id: str):
    """Stream the video file for in-app preview. Read-only; supports range."""
    with Session(engine) as session:
        asset = session.get(MediaAsset, media_id)
        if asset is None:
            raise HTTPException(status_code=404, detail="Media not found")
        path = Path(asset.local_path)
        original = asset.original_filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Media file missing")
    media_type = _VIDEO_MIME.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type, filename=original)


@router.get("/api/media/{media_id}/preview")
def get_media_preview(media_id: str):
    """Stream the file the preview should decode.

    Serves the optimized proxy when it is ready; otherwise serves the original
    (so playback always works) and kicks off proxy generation in the background
    so subsequent plays are smooth.
    """
    with Session(engine) as session:
        asset = session.get(MediaAsset, media_id)
        if asset is None:
            raise HTTPException(status_code=404, detail="Media not found")
        original = Path(asset.local_path)
        original_name = asset.original_filename
        project_id = asset.project_id

    proxy = paths.proxy_path(project_id, media_id)
    if proxy.exists():
        return FileResponse(proxy, media_type="video/mp4", filename=f"{media_id}.mp4")

    if not original.exists():
        raise HTTPException(status_code=404, detail="Media file missing")
    _start_proxy(media_id, str(original), project_id)
    media_type = _VIDEO_MIME.get(original.suffix.lower(), "application/octet-stream")
    return FileResponse(original, media_type=media_type, filename=original_name)


@router.get("/api/media/{media_id}/proxy")
def get_media_proxy_status(media_id: str):
    """Report proxy readiness (and ensure generation has started)."""
    with Session(engine) as session:
        asset = session.get(MediaAsset, media_id)
        if asset is None:
            raise HTTPException(status_code=404, detail="Media not found")
        local_path = asset.local_path
        project_id = asset.project_id
    ready = _start_proxy(media_id, local_path, project_id)
    return {"ready": ready}


@router.get("/api/media/{media_id}/filmstrip")
def get_media_filmstrip(media_id: str):
    """A tiled strip of frames for the clip background (generated + cached)."""
    with Session(engine) as session:
        asset = session.get(MediaAsset, media_id)
        if asset is None:
            raise HTTPException(status_code=404, detail="Media not found")
        src = Path(asset.local_path)
        project_id = asset.project_id
        duration = asset.duration_seconds or 0.0
    if not src.exists():
        raise HTTPException(status_code=404, detail="Media file missing")

    try:
        dest = _ensure_filmstrip(media_id, src, project_id, duration)
    except FFmpegError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return FileResponse(dest, media_type="image/jpeg")


@router.get("/api/media/{media_id}/waveform")
def get_media_waveform(media_id: str):
    """Normalized audio peaks for waveform drawing (generated + cached)."""
    with Session(engine) as session:
        asset = session.get(MediaAsset, media_id)
        if asset is None:
            raise HTTPException(status_code=404, detail="Media not found")
        src = Path(asset.local_path)
        project_id = asset.project_id
    if not src.exists():
        raise HTTPException(status_code=404, detail="Media file missing")

    try:
        dest = _ensure_waveform(media_id, src, project_id)
    except FFmpegError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"peaks": json.loads(dest.read_text())}


@router.get("/api/projects/{project_id}/thumbnail")
def get_project_thumbnail(project_id: str, session: Session = Depends(get_session)):
    project = _get_active_project(project_id, session)
    if not project.thumbnail_path:
        raise HTTPException(status_code=404, detail="No thumbnail")
    path = Path(project.thumbnail_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail file missing")
    return FileResponse(path, media_type="image/jpeg")
