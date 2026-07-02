"""Render service.

Turns a timeline's kept segments into a final MP4 using FFmpeg. The approach is
a single-input trim + concat filter graph (one re-encode pass), which keeps
audio and video in sync and handles clips that don't start on keyframes.

Only the source is read; the original file is never modified. Outputs are always
written to a fresh, versioned filename (never overwritten).
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from pathlib import Path

from ..utils.ffmpeg import FFmpegError, ffmpeg_available

# (source_start, source_end) pairs, in seconds, in output order.
Segment = tuple[float, float]


def build_concat_filter(segments: list[Segment], has_audio: bool) -> str:
    """Build an FFmpeg filter_complex that trims each segment and concatenates."""
    lines: list[str] = []
    for i, (start, end) in enumerate(segments):
        lines.append(
            f"[0:v]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS[v{i}]"
        )
        if has_audio:
            lines.append(
                f"[0:a]atrim=start={start:.3f}:end={end:.3f},"
                f"asetpts=PTS-STARTPTS[a{i}]"
            )

    n = len(segments)
    if has_audio:
        inputs = "".join(f"[v{i}][a{i}]" for i in range(n))
        lines.append(f"{inputs}concat=n={n}:v=1:a=1[outv][outa]")
    else:
        inputs = "".join(f"[v{i}]" for i in range(n))
        lines.append(f"{inputs}concat=n={n}:v=1:a=0[outv]")
    return ";".join(lines)


def build_command(
    input_path: Path, filter_complex: str, output_path: Path, has_audio: bool
) -> list[str]:
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-filter_complex",
        filter_complex,
        "-map",
        "[outv]",
    ]
    if has_audio:
        cmd += ["-map", "[outa]"]
    cmd += [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
    ]
    if has_audio:
        cmd += ["-c:a", "aac", "-b:a", "160k"]
    cmd += [
        "-movflags",
        "+faststart",
        str(output_path),
        # Machine-readable progress on stdout so we can report a percentage.
        "-progress",
        "pipe:1",
        "-nostats",
    ]
    return cmd


def _parse_timestamp(value: str) -> float | None:
    """Parse ffmpeg 'out_time' (HH:MM:SS.micro) into seconds."""
    value = value.strip()
    if not value or value == "N/A":
        return None
    try:
        h, m, s = value.split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)
    except ValueError:
        return None


def render_cut_list(
    input_path: Path,
    segments: list[Segment],
    output_path: Path,
    total_seconds: float,
    *,
    has_audio: bool,
    on_progress: Callable[[float], None] | None = None,
) -> Path:
    """Render the kept segments to output_path, reporting 0..1 progress."""
    if not ffmpeg_available():
        raise FFmpegError("ffmpeg not found on PATH")
    if not segments:
        raise FFmpegError("Timeline has no segments to render")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    filter_complex = build_concat_filter(segments, has_audio)
    cmd = build_command(input_path, filter_complex, output_path, has_audio)

    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        if on_progress and total_seconds > 0 and line.startswith("out_time="):
            seconds = _parse_timestamp(line.split("=", 1)[1])
            if seconds is not None:
                on_progress(min(0.99, seconds / total_seconds))
    proc.wait()
    stderr = proc.stderr.read() if proc.stderr else ""

    if proc.returncode != 0 or not output_path.exists():
        # Surface the tail of ffmpeg's stderr; it holds the actual reason.
        raise FFmpegError(f"render failed: {stderr.strip()[-600:]}")
    return output_path


def segments_from_timeline(data: dict) -> tuple[str | None, list[Segment]]:
    """Extract (media_id, [(start,end)...]) from a timeline's video track."""
    for track in data.get("tracks", []):
        if track.get("kind") == "video":
            elements = track.get("elements", [])
            media_id = elements[0]["media_id"] if elements else None
            segments = [
                (float(el["source_start"]), float(el["source_end"]))
                for el in elements
            ]
            return media_id, segments
    return None, []
