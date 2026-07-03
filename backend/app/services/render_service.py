"""Render service — bakes the timeline (with effects) into a final MP4.

This mirrors the live compositor (`frontend/src/editor/PreviewCanvas.tsx` +
`effects.ts`) as closely as a single FFmpeg pass allows: a black 1280x720 canvas,
video tracks layered bottom-first, each clip trimmed/placed on the timeline with
its transform, color grade, opacity, fades, green-screen key and rectangular
mask, text overlays painted on top, and audio taken from the bottom-most
non-muted video track with per-clip volume + fades.

Text is rasterized to transparent PNGs with Pillow because this FFmpeg build has
no `drawtext`. Keyframed scale / position / rotation are sampled once (at the
clip midpoint) — animated fades are exact, animated transforms are approximated.

Only sources are read; the originals are never modified. Outputs go to a fresh,
versioned filename.
"""

from __future__ import annotations

import math
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from ..utils.ffmpeg import FFmpegError, ffmpeg_available

OUT_W = 1280
OUT_H = 720
FPS = 30

# Matches the compositor's text placement (bottom-anchored, 70px up).
TEXT_BASELINE_UP = 70
TEXT_BASE_FONT = 52

_FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]


@dataclass
class MediaInfo:
    path: str
    width: int | None = None
    height: int | None = None
    has_audio: bool = False


@dataclass
class _Build:
    """Accumulated ffmpeg inputs + filter graph."""

    inputs: list[str] = field(default_factory=list)
    filters: list[str] = field(default_factory=list)
    idx: int = 0

    def add_input(self, *args: str) -> int:
        i = self.idx
        self.inputs.extend(args)
        self.idx += 1
        return i


# ---- timeline math (mirror of frontend/src/editor/timeline.ts + effects.ts) ----

MIN_CLIP = 0.1
DEFAULT_TEXT_DUR = 3.0


def _clip_duration(el: dict) -> float:
    if el.get("type") == "text":
        end = el.get("timeline_end")
        if end is None:
            end = float(el.get("timeline_start", 0.0)) + DEFAULT_TEXT_DUR
        return max(MIN_CLIP, float(end) - float(el.get("timeline_start", 0.0)))
    src = float(el.get("source_end", 0.0)) - float(el.get("source_start", 0.0))
    return max(MIN_CLIP, src)


def _sample_keyframed(keys: list[dict], prop: str, lt: float, fallback: float) -> float:
    defined = sorted((k for k in keys if k.get(prop) is not None), key=lambda k: k["t"])
    if not defined:
        return fallback
    if lt <= defined[0]["t"]:
        return float(defined[0][prop])
    if lt >= defined[-1]["t"]:
        return float(defined[-1][prop])
    for a, b in zip(defined, defined[1:]):
        if a["t"] <= lt <= b["t"]:
            span = (b["t"] - a["t"]) or 1
            f = (lt - a["t"]) / span
            return float(a[prop]) + (float(b[prop]) - float(a[prop])) * f
    return fallback


def _resolve_transform(el: dict, dur: float) -> tuple[float, float, float, float, float]:
    """Return (scale, x, y, rotation, opacity) sampled at the clip midpoint."""
    t = el.get("transform") or {}
    keys = el.get("keyframes") or []
    lt = dur / 2
    scale = _sample_keyframed(keys, "scale", lt, float(t.get("scale", 1)))
    x = _sample_keyframed(keys, "x", lt, float(t.get("x", 0)))
    y = _sample_keyframed(keys, "y", lt, float(t.get("y", 0)))
    rot = _sample_keyframed(keys, "rotation", lt, float(t.get("rotation", 0)))
    op = _sample_keyframed(keys, "opacity", lt, float(el.get("opacity", 1)))
    return scale, x, y, rot, max(0.0, min(1.0, op))


def _hex6(color: str) -> str:
    h = color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return h[:6].lower()


# ---- text rasterization (Pillow) ----


def _find_font() -> str | None:
    for cand in _FONT_CANDIDATES:
        if Path(cand).exists():
            return cand
    return None


def _render_text_png(
    text: str, font_size: int, opacity: float, cx: float, cy: float, dest: Path
) -> None:
    """Draw one text clip onto a transparent 1280x720 PNG (white + black stroke)."""
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGBA", (OUT_W, OUT_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font_path = _find_font()
    font = (
        ImageFont.truetype(font_path, font_size)
        if font_path
        else ImageFont.load_default()
    )
    draw.text(
        (cx, cy),
        text,
        font=font,
        anchor="ms",  # horizontal middle, baseline — matches canvas center/bottom
        fill=(255, 255, 255, 255),
        stroke_width=3,
        stroke_fill=(0, 0, 0, 191),  # ~0.75 alpha black outline
    )
    if opacity < 0.999:
        r, g, b, a = img.split()
        a = a.point(lambda v: int(v * opacity))
        img = Image.merge("RGBA", (r, g, b, a))
    img.save(dest)


# ---- filter graph construction ----


def _video_clip_chain(b: _Build, el: dict, media: MediaInfo, label: str) -> tuple[int, int]:
    """Emit the per-clip filter chain into `b`. Returns overlay offset (x, y)."""
    s = float(el.get("source_start", 0.0))
    dur = _clip_duration(el)
    e = s + dur
    ts = float(el.get("timeline_start", 0.0))
    te = ts + dur

    vw = media.width or OUT_W
    vh = media.height or OUT_H
    fit = min(OUT_W / vw, OUT_H / vh)
    scale, x, y, rot, op = _resolve_transform(el, dur)
    w = max(2, round(vw * fit * scale))
    h = max(2, round(vh * fit * scale))

    parts = [f"[{el['_in']}:v]trim=start={s:.3f}:end={e:.3f}"]
    parts.append(f"setpts=PTS-STARTPTS+{ts:.3f}/TB")
    parts.append("format=rgba")

    color = el.get("color")
    if color:
        br = float(color.get("brightness", 1))
        ct = float(color.get("contrast", 1))
        sa = float(color.get("saturation", 1))
        if abs(br - 1) > 1e-3:
            parts.append(f"colorchannelmixer=rr={br:.3f}:gg={br:.3f}:bb={br:.3f}")
        if abs(ct - 1) > 1e-3 or abs(sa - 1) > 1e-3:
            parts.append(f"eq=contrast={ct:.3f}:saturation={sa:.3f}")

    chroma = el.get("chroma")
    if chroma and chroma.get("enabled"):
        sim = max(0.01, min(1.0, float(chroma.get("similarity", 0.4))))
        blend = max(0.0, min(1.0, float(chroma.get("smoothness", 0.1))))
        parts.append(f"colorkey=0x{_hex6(chroma.get('color', '#00ff00'))}:{sim:.3f}:{blend:.3f}")

    parts.append(f"scale={w}:{h}")

    rw, rh = w, h
    if abs(rot) > 1e-3:
        rad = rot * math.pi / 180
        rw = math.ceil(abs(w * math.cos(rad)) + abs(h * math.sin(rad)))
        rh = math.ceil(abs(w * math.sin(rad)) + abs(h * math.cos(rad)))
        parts.append(f"rotate={rad:.5f}:ow={rw}:oh={rh}:c=black@0.0")

    if op < 0.999:
        parts.append(f"colorchannelmixer=aa={op:.3f}")

    fin = float(el.get("fadeIn", 0) or 0)
    fout = float(el.get("fadeOut", 0) or 0)
    if fin > 0:
        parts.append(f"fade=t=in:st={ts:.3f}:d={fin:.3f}:alpha=1")
    if fout > 0:
        parts.append(f"fade=t=out:st={te - fout:.3f}:d={fout:.3f}:alpha=1")

    b.filters.append(",".join(parts) + f"[{label}]")

    cx = OUT_W / 2 + x * OUT_W
    cy = OUT_H / 2 + y * OUT_H
    off_x = round(cx - rw / 2)
    off_y = round(cy - rh / 2)
    return off_x, off_y


def _iter_video_clips_bottom_up(tracks: list[dict]):
    """Yield (track, clip) in compositing order: bottom track first, top last."""
    for track in reversed(tracks):
        if track.get("kind") == "video":
            for el in track.get("elements", []):
                if el.get("media_id"):
                    yield track, el


def _iter_text_clips_bottom_up(tracks: list[dict]):
    for track in reversed(tracks):
        if track.get("kind") == "text":
            for el in track.get("elements", []):
                if (el.get("text") or "").strip():
                    yield track, el


def _pick_audio_track(tracks: list[dict], media_map: dict[str, MediaInfo]) -> dict | None:
    """Bottom-most non-muted video track that has an audio-bearing clip."""
    for track in reversed(tracks):
        if track.get("kind") != "video" or track.get("muted"):
            continue
        for el in track.get("elements", []):
            mi = media_map.get(el.get("media_id", ""))
            if mi and mi.has_audio:
                return track
    return None


def build_render(
    data: dict, media_map: dict[str, MediaInfo], text_dir: Path
) -> tuple[list[str], str, str | None, float]:
    """Build (input_args, filter_complex, audio_label_or_None, duration)."""
    tracks = data.get("tracks", [])

    duration = float(data.get("duration", 0) or 0)
    for track in tracks:
        for el in track.get("elements", []):
            duration = max(duration, float(el.get("timeline_start", 0)) + _clip_duration(el))
    if duration <= 0:
        raise FFmpegError("Timeline has no clips to render")

    b = _Build()

    # Register a decode input per video clip (reused for its audio).
    video_clips = list(_iter_video_clips_bottom_up(tracks))
    if not video_clips and not list(_iter_text_clips_bottom_up(tracks)):
        raise FFmpegError("Timeline has no clips to render")

    for _track, el in video_clips:
        mi = media_map.get(el["media_id"])
        if mi is None or not Path(mi.path).exists():
            raise FFmpegError(f"Source media missing for clip {el.get('id')}")
        el["_in"] = b.add_input("-i", mi.path)

    # Base black canvas.
    b.filters.append(
        f"color=c=black:s={OUT_W}x{OUT_H}:r={FPS}:d={duration:.3f}[bg]"
    )
    cur = "[bg]"

    # Video layers, bottom track first.
    for n, (_track, el) in enumerate(video_clips):
        mi = media_map[el["media_id"]]
        off_x, off_y = _video_clip_chain(b, el, mi, f"vc{n}")
        ts = float(el.get("timeline_start", 0.0))
        te = ts + _clip_duration(el)
        mask = el.get("mask")
        if mask:
            mx = round(float(mask.get("x", 0)) * OUT_W)
            my = round(float(mask.get("y", 0)) * OUT_H)
            mw = max(2, round(float(mask.get("w", 1)) * OUT_W))
            mh = max(2, round(float(mask.get("h", 1)) * OUT_H))
            b.filters.append(f"color=c=black@0.0:s={OUT_W}x{OUT_H}:r={FPS}[tb{n}]")
            b.filters.append(f"[tb{n}][vc{n}]overlay=x={off_x}:y={off_y}:format=auto[full{n}]")
            b.filters.append(f"[full{n}]crop={mw}:{mh}:{mx}:{my}[mp{n}]")
            b.filters.append(
                f"{cur}[mp{n}]overlay=x={mx}:y={my}:"
                f"enable='between(t,{ts:.3f},{te:.3f})':format=auto:eof_action=pass[stg{n}]"
            )
        else:
            b.filters.append(
                f"{cur}[vc{n}]overlay=x={off_x}:y={off_y}:"
                f"enable='between(t,{ts:.3f},{te:.3f})':format=auto:eof_action=pass[stg{n}]"
            )
        cur = f"[stg{n}]"

    # Text overlays on top (bottom text track first, top last).
    for m, (_track, el) in enumerate(_iter_text_clips_bottom_up(tracks)):
        dur = _clip_duration(el)
        ts = float(el.get("timeline_start", 0.0))
        te = ts + dur
        scale, x, y, _rot, op = _resolve_transform(el, dur)
        font_size = max(8, round(TEXT_BASE_FONT * scale))
        cx = OUT_W / 2 + x * OUT_W
        cy = OUT_H - TEXT_BASELINE_UP + y * OUT_H
        png = text_dir / f"text_{m}.png"
        _render_text_png(el["text"], font_size, op, cx, cy, png)
        in_idx = b.add_input("-loop", "1", "-t", f"{dur:.3f}", "-i", str(png))

        parts = [f"[{in_idx}:v]format=rgba", f"setpts=PTS-STARTPTS+{ts:.3f}/TB"]
        fin = float(el.get("fadeIn", 0) or 0)
        fout = float(el.get("fadeOut", 0) or 0)
        if fin > 0:
            parts.append(f"fade=t=in:st={ts:.3f}:d={fin:.3f}:alpha=1")
        if fout > 0:
            parts.append(f"fade=t=out:st={te - fout:.3f}:d={fout:.3f}:alpha=1")
        b.filters.append(",".join(parts) + f"[txt{m}]")
        b.filters.append(
            f"{cur}[txt{m}]overlay=x=0:y=0:"
            f"enable='between(t,{ts:.3f},{te:.3f})':format=auto:eof_action=pass[tstg{m}]"
        )
        cur = f"[tstg{m}]"

    # Final video: force yuv420p for broad playback.
    b.filters.append(f"{cur}format=yuv420p[vout]")

    # Audio from the bottom-most non-muted video track.
    audio_label = _build_audio(b, tracks, media_map)

    return b.inputs, ";".join(b.filters), audio_label, duration


def _build_audio(
    b: _Build, tracks: list[dict], media_map: dict[str, MediaInfo]
) -> str | None:
    track = _pick_audio_track(tracks, media_map)
    if track is None:
        return None
    track_vol = float(track.get("volume", 1) or 1)
    labels: list[str] = []
    for el in track.get("elements", []):
        mi = media_map.get(el.get("media_id", ""))
        if not mi or not mi.has_audio or "_in" not in el:
            continue
        s = float(el.get("source_start", 0.0))
        dur = _clip_duration(el)
        e = s + dur
        ts = float(el.get("timeline_start", 0.0))
        gain = float(el.get("volume", 1) or 1) * track_vol
        parts = [f"[{el['_in']}:a]atrim=start={s:.3f}:end={e:.3f}", "asetpts=PTS-STARTPTS"]
        if abs(gain - 1) > 1e-3:
            parts.append(f"volume={gain:.3f}")
        afin = float(el.get("audioFadeIn", 0) or 0)
        afout = float(el.get("audioFadeOut", 0) or 0)
        if afin > 0:
            parts.append(f"afade=t=in:st=0:d={afin:.3f}")
        if afout > 0:
            parts.append(f"afade=t=out:st={dur - afout:.3f}:d={afout:.3f}")
        if ts > 0:
            parts.append(f"adelay={round(ts * 1000)}:all=1")
        lbl = f"ac{len(labels)}"
        b.filters.append(",".join(parts) + f"[{lbl}]")
        labels.append(lbl)

    if not labels:
        return None
    if len(labels) == 1:
        b.filters.append(f"[{labels[0]}]anull[aout]")
    else:
        joined = "".join(f"[{lbl}]" for lbl in labels)
        b.filters.append(f"{joined}amix=inputs={len(labels)}:normalize=0[aout]")
    return "[aout]"


def build_command(
    input_args: list[str],
    filter_complex: str,
    audio_label: str | None,
    output_path: Path,
) -> list[str]:
    cmd = ["ffmpeg", "-y", *input_args, "-filter_complex", filter_complex, "-map", "[vout]"]
    if audio_label:
        cmd += ["-map", audio_label]
    cmd += [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    ]
    if audio_label:
        cmd += ["-c:a", "aac", "-b:a", "160k"]
    cmd += [
        "-movflags", "+faststart",
        str(output_path),
        "-progress", "pipe:1", "-nostats",
    ]
    return cmd


def _parse_timestamp(value: str) -> float | None:
    value = value.strip()
    if not value or value == "N/A":
        return None
    try:
        h, m, s = value.split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)
    except ValueError:
        return None


def render_timeline(
    data: dict,
    media_map: dict[str, MediaInfo],
    output_path: Path,
    *,
    on_progress: Callable[[float], None] | None = None,
) -> Path:
    """Bake the full timeline (video + effects + text + audio) to output_path."""
    if not ffmpeg_available():
        raise FFmpegError("ffmpeg not found on PATH")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="shelfedit_render_") as tmp:
        input_args, filter_complex, audio_label, duration = build_render(
            data, media_map, Path(tmp)
        )
        cmd = build_command(input_args, filter_complex, audio_label, output_path)

        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            if on_progress and duration > 0 and line.startswith("out_time="):
                seconds = _parse_timestamp(line.split("=", 1)[1])
                if seconds is not None:
                    on_progress(min(0.99, seconds / duration))
        proc.wait()
        stderr = proc.stderr.read() if proc.stderr else ""

    if proc.returncode != 0 or not output_path.exists():
        raise FFmpegError(f"render failed: {stderr.strip()[-800:]}")
    return output_path
