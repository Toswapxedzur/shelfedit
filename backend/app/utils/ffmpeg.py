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


def generate_filmstrip(
    src: Path,
    dest: Path,
    *,
    duration: float,
    count: int = 12,
    frame_height: int = 90,
) -> Path:
    """Tile `count` evenly-spaced frames into a single horizontal strip image.

    Used as the background of a video clip in the timeline. Read-only.
    """
    if shutil.which("ffmpeg") is None:
        raise FFmpegError("ffmpeg not found on PATH")
    if duration <= 0:
        raise FFmpegError("cannot build filmstrip without a positive duration")

    count = max(1, min(count, 60))
    dest.parent.mkdir(parents=True, exist_ok=True)
    # fps = count/duration samples ~count frames across the whole clip.
    fps = count / duration
    vf = f"fps={fps:.6f},scale=-1:{frame_height},tile={count}x1"
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-vf",
        vf,
        "-frames:v",
        "1",
        str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not dest.exists():
        raise FFmpegError(f"filmstrip generation failed: {proc.stderr.strip()}")
    return dest


def extract_waveform_peaks(src: Path, buckets: int = 400) -> list[float]:
    """Return normalized (0..1) audio amplitude peaks for waveform drawing.

    Decodes mono PCM at a low sample rate and reduces it to `buckets` peak
    values. Returns an empty list if the file has no audio.
    """
    if shutil.which("ffmpeg") is None:
        raise FFmpegError("ffmpeg not found on PATH")
    if not has_audio_stream(src):
        return []

    cmd = [
        "ffmpeg",
        "-i",
        str(src),
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "s16le",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise FFmpegError(f"waveform decode failed: {proc.stderr.decode()[-300:]}")

    import array

    samples = array.array("h")
    samples.frombytes(proc.stdout)
    if len(samples) == 0:
        return []

    buckets = max(1, min(buckets, 2000))
    step = max(1, len(samples) // buckets)
    peaks: list[float] = []
    for i in range(0, len(samples), step):
        window = samples[i : i + step]
        peak = max((abs(s) for s in window), default=0)
        peaks.append(round(peak / 32768.0, 4))
    return peaks[:buckets]


def generate_proxy(
    src: Path,
    dest: Path,
    *,
    max_dim: int = 1280,
    fps: int = 30,
) -> Path:
    """Transcode `src` into an edit-friendly preview proxy.

    The proxy is what the in-app preview decodes, so it is normalized to the
    format browsers/WebCodecs play smoothly regardless of the source (this is
    the same idea as CapCut/Premiere/Resolve "optimized media"):

      • H.264 High, 8-bit yuv420p — universally, cheaply decodable.
      • Downscaled so the long edge is at most `max_dim` (the preview canvas is
        ~1280 wide, so decoding anything larger is wasted work). Dimensions are
        forced even (H.264 requirement).
      • Constant frame rate (`-r`/CFR) — screen recordings are often VFR, which
        upsets frame pacing; normalizing removes the jitter.
      • Short GOP (keyframe every ~0.5s) so scrubbing/seeking is fast.
      • +faststart so the moov atom is at the front for progressive range reads.
      • AAC audio so the preview has sound.

    The original file is never modified. Writes to a temp path and atomically
    renames on success, so a partially-written proxy is never observed as ready.
    """
    if shutil.which("ffmpeg") is None:
        raise FFmpegError("ffmpeg not found on PATH")

    dest.parent.mkdir(parents=True, exist_ok=True)
    fps = max(1, min(fps, 120))
    # Scale the long edge down to max_dim (never upscale), keep aspect, force even.
    vf = (
        f"scale='if(gt(iw,ih),min({max_dim},iw),-2)':"
        f"'if(gt(iw,ih),-2,min({max_dim},ih))':flags=bicubic,"
        "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"
    )
    tmp = dest.with_suffix(dest.suffix + ".part")
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-vf",
        vf,
        "-r",
        str(fps),
        "-fps_mode",
        "cfr",
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-g",
        str(max(1, fps // 2)),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        # The temp file ends in .part, so ffmpeg can't infer the container from
        # the extension — state it explicitly.
        "-f",
        "mp4",
        str(tmp),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not tmp.exists():
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise FFmpegError(f"proxy generation failed: {proc.stderr.strip()[-400:]}")
    tmp.replace(dest)
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
