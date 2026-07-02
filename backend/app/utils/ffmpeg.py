"""Thin FFmpeg / FFprobe wrappers via subprocess.

Kept deliberately simple (no wrapper library) so behavior is predictable and
easy to debug. All calls are read-only with respect to the source file.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


class FFmpegError(RuntimeError):
    pass


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


@dataclass
class MediaProbe:
    duration_seconds: float | None
    width: int | None
    height: int | None


def probe(path: Path) -> MediaProbe:
    """Read duration and dimensions using ffprobe. Never modifies the file."""
    if shutil.which("ffprobe") is None:
        raise FFmpegError("ffprobe not found on PATH")

    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FFmpegError(f"ffprobe failed: {proc.stderr.strip()}")

    data = json.loads(proc.stdout or "{}")

    duration = None
    fmt = data.get("format", {})
    if fmt.get("duration") is not None:
        try:
            duration = float(fmt["duration"])
        except (TypeError, ValueError):
            duration = None

    width = height = None
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video":
            width = stream.get("width")
            height = stream.get("height")
            if duration is None and stream.get("duration"):
                try:
                    duration = float(stream["duration"])
                except (TypeError, ValueError):
                    pass
            break

    return MediaProbe(duration_seconds=duration, width=width, height=height)


def has_audio_stream(path: Path) -> bool:
    """True if the file has at least one audio stream (via ffprobe)."""
    if shutil.which("ffprobe") is None:
        raise FFmpegError("ffprobe not found on PATH")
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc.returncode == 0 and proc.stdout.strip() != ""


def extract_audio(src: Path, dest: Path) -> Path:
    """Extract a compact mono MP3 from the video for transcription.

    Mono 16 kHz at a low bitrate keeps the file small so longer videos stay
    under the transcription API's size limit. The source video is not modified.
    """
    if shutil.which("ffmpeg") is None:
        raise FFmpegError("ffmpeg not found on PATH")

    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-vn",  # drop video
        "-ac",
        "1",  # mono
        "-ar",
        "16000",  # 16 kHz
        "-b:a",
        "48k",
        str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not dest.exists():
        raise FFmpegError(f"audio extraction failed: {proc.stderr.strip()}")
    return dest


def generate_thumbnail(
    src: Path, dest: Path, at_seconds: float = 1.0, width: int = 640
) -> Path:
    """Grab a single frame from the video and write it as a JPEG thumbnail."""
    if shutil.which("ffmpeg") is None:
        raise FFmpegError("ffmpeg not found on PATH")

    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        f"{max(0.0, at_seconds):.3f}",
        "-i",
        str(src),
        "-frames:v",
        "1",
        "-vf",
        f"scale={width}:-2",
        str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not dest.exists():
        raise FFmpegError(f"thumbnail generation failed: {proc.stderr.strip()}")
    return dest
