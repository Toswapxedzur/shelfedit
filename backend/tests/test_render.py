"""Render integration tests (offline). Import -> transcribe -> cut -> apply -> render.

Uses fake transcription + fake AI (no network) but a real FFmpeg render, matching
the plan's integration-test recipe. Skips when ffmpeg is unavailable.
"""

from __future__ import annotations

import subprocess
import time

import pytest

from app.utils.ffmpeg import ffmpeg_available


@pytest.fixture()
def av_video(tmp_path):
    if not ffmpeg_available():
        pytest.skip("ffmpeg not available")
    out = tmp_path / "av.mp4"
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", "-shortest",
        str(out),
    ]
    assert subprocess.run(cmd, capture_output=True).returncode == 0
    return out


def _wait_job(client, job_id, timeout=40.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        j = client.get(f"/api/jobs/{job_id}").json()
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.2)
    return None


@pytest.fixture()
def project_with_timeline(client, av_video, monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("SHELFEDIT_FAKE_TRANSCRIBE", "1")
    monkeypatch.setenv("SHELFEDIT_FAKE_AI", "1")
    get_settings.cache_clear()

    pid = client.post("/api/projects", json={"name": "Render"}).json()["id"]
    client.post(
        f"/api/projects/{pid}/media/import",
        json={"source_path": str(av_video), "copy": True},
    )
    job = client.post(f"/api/projects/{pid}/transcribe", json={}).json()
    assert _wait_job(client, job["id"])["status"] == "done"

    msgs = client.post(
        f"/api/projects/{pid}/ai/messages", json={"content": "cut"}
    ).json()
    assistant = msgs[1]
    client.post(f"/api/projects/{pid}/ai/messages/{assistant['id']}/apply")
    return pid


def test_filtergraph_bakes_all_effects(tmp_path):
    """build_render must emit filters for every effect the compositor supports."""
    from app.services import render_service as rs

    base = tmp_path / "base.mp4"
    over = tmp_path / "over.mp4"
    base.write_bytes(b"x")
    over.write_bytes(b"x")
    media = {
        "m_base": rs.MediaInfo(path=str(base), width=640, height=360, has_audio=True),
        "m_over": rs.MediaInfo(path=str(over), width=480, height=360, has_audio=False),
    }
    data = {
        "duration": 6.0,
        "tracks": [
            {"kind": "text", "elements": [
                {"type": "text", "text": "Hi", "timeline_start": 0, "timeline_end": 6,
                 "fadeIn": 1, "fadeOut": 1,
                 "keyframes": [{"t": 0, "scale": 0.6}, {"t": 6, "scale": 1.4}]},
            ]},
            {"kind": "video", "elements": [
                {"type": "video", "media_id": "m_over", "source_start": 0,
                 "source_end": 6, "timeline_start": 0, "opacity": 0.8,
                 "chroma": {"enabled": True, "color": "#00ff00", "similarity": 0.4,
                            "smoothness": 0.12},
                 "transform": {"scale": 0.5, "x": 0.2, "y": -0.1, "rotation": 12},
                 "mask": {"x": 0.1, "y": 0.05, "w": 0.8, "h": 0.7},
                 "fadeIn": 0.5, "fadeOut": 0.5},
            ]},
            {"kind": "video", "elements": [
                {"type": "video", "media_id": "m_base", "source_start": 0,
                 "source_end": 6, "timeline_start": 0,
                 "color": {"brightness": 1.15, "contrast": 1.2, "saturation": 0.7},
                 "volume": 0.5, "audioFadeIn": 1, "audioFadeOut": 1},
            ]},
        ],
    }

    inputs, fc, audio_label, duration = rs.build_render(data, media, tmp_path)

    assert duration == 6.0
    assert audio_label == "[aout]"
    # Color grade, chroma, transform, opacity, fades, mask, text, audio mixing.
    assert "colorchannelmixer=rr=1.150" in fc  # brightness (multiplicative)
    assert "eq=contrast=1.200:saturation=0.700" in fc
    assert "colorkey=0x00ff00" in fc
    assert "rotate=" in fc
    assert "colorchannelmixer=aa=0.800" in fc
    assert "fade=t=in" in fc and "fade=t=out" in fc
    assert "crop=" in fc  # rectangular mask
    assert "[vout]" in fc
    assert "volume=0.500" in fc and "afade=t=in" in fc
    # Two decode inputs (base + overlay) + one looped text image = 3 inputs.
    assert inputs.count("-i") == 3


def test_render_requires_timeline(client, av_video, monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("SHELFEDIT_FAKE_TRANSCRIBE", "1")
    get_settings.cache_clear()

    pid = client.post("/api/projects", json={"name": "NoCut"}).json()["id"]
    client.post(
        f"/api/projects/{pid}/media/import",
        json={"source_path": str(av_video), "copy": True},
    )
    resp = client.post(f"/api/projects/{pid}/render")
    assert resp.status_code == 400


def test_render_produces_playable_export(project_with_timeline, client):
    pid = project_with_timeline
    job = client.post(f"/api/projects/{pid}/render").json()
    final = _wait_job(client, job["id"])
    assert final is not None, "render job did not finish"
    assert final["status"] == "done", final.get("error_message")
    assert final["progress"] == 1.0

    exports = client.get(f"/api/projects/{pid}/exports").json()
    assert len(exports) == 1
    export = exports[0]
    assert export["type"] == "export"
    assert export["original_filename"] == "export_v1.mp4"
    assert export["duration_seconds"] and export["duration_seconds"] > 0

    # Project advanced, and the export streams back.
    assert client.get(f"/api/projects/{pid}").json()["status"] == "rendered"
    file_resp = client.get(f"/api/media/{export['id']}/file")
    assert file_resp.status_code == 200
    assert len(file_resp.content) > 0


def test_second_render_is_versioned(project_with_timeline, client):
    pid = project_with_timeline
    for _ in range(2):
        job = client.post(f"/api/projects/{pid}/render").json()
        assert _wait_job(client, job["id"])["status"] == "done"

    exports = client.get(f"/api/projects/{pid}/exports").json()
    names = {e["original_filename"] for e in exports}
    assert names == {"export_v1.mp4", "export_v2.mp4"}
