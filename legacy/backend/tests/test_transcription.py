"""Transcription tests.

Audio extraction runs for real via FFmpeg; the OpenAI call is replaced by the
offline/fake provider (SHELFEDIT_FAKE_TRANSCRIBE) so tests never hit the network.
"""

from __future__ import annotations

import subprocess
import time

import pytest

from app.utils.ffmpeg import ffmpeg_available


@pytest.fixture()
def sample_video_with_audio(tmp_path):
    """1-second test video that includes an audio track for extraction."""
    if not ffmpeg_available():
        pytest.skip("ffmpeg/ffprobe not available")
    out = tmp_path / "sample_av.mp4"
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=1:size=320x240:rate=10",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-pix_fmt",
        "yuv420p",
        "-shortest",
        str(out),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    return out


def _import(client, video) -> str:
    pid = client.post("/api/projects", json={"name": "TX"}).json()["id"]
    client.post(
        f"/api/projects/{pid}/media/import",
        json={"source_path": str(video), "copy": True},
    )
    return pid


def _wait_for_job(client, job_id, timeout=20.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = client.get(f"/api/jobs/{job_id}").json()
        if last["status"] in ("done", "error"):
            return last
        time.sleep(0.2)
    return last


def test_transcribe_flow_offline(client, sample_video_with_audio, monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("SHELFEDIT_FAKE_TRANSCRIBE", "1")
    get_settings.cache_clear()

    pid = _import(client, sample_video_with_audio)

    resp = client.post(f"/api/projects/{pid}/transcribe", json={})
    assert resp.status_code == 202, resp.text
    job = resp.json()
    assert job["kind"] == "transcribe"

    final = _wait_for_job(client, job["id"])
    assert final is not None and final["status"] == "done", final

    # Project moves to transcribed and the transcript is retrievable.
    project = client.get(f"/api/projects/{pid}").json()
    assert project["status"] == "transcribed"

    transcript = client.get(f"/api/projects/{pid}/transcript").json()
    assert transcript["plain_text"]
    assert len(transcript["segments"]) >= 1
    assert transcript["provider"] == "offline"


def test_transcribe_without_key_is_clear_error(
    client, sample_video_with_audio, monkeypatch
):
    from app.config import get_settings

    monkeypatch.delenv("SHELFEDIT_FAKE_TRANSCRIBE", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    get_settings.cache_clear()

    pid = _import(client, sample_video_with_audio)
    resp = client.post(f"/api/projects/{pid}/transcribe", json={})
    assert resp.status_code == 400
    assert "OPENAI_API_KEY" in resp.json()["detail"]


def test_transcribe_requires_video(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("SHELFEDIT_FAKE_TRANSCRIBE", "1")
    get_settings.cache_clear()

    pid = client.post("/api/projects", json={"name": "No Media"}).json()["id"]
    resp = client.post(f"/api/projects/{pid}/transcribe", json={})
    assert resp.status_code == 400


def test_long_audio_requires_confirmation(
    client, sample_video_with_audio, monkeypatch
):
    from app.config import get_settings

    monkeypatch.setenv("SHELFEDIT_FAKE_TRANSCRIBE", "1")
    # Force the warning threshold below the clip length (1s ~= 0.017 min).
    monkeypatch.setenv("TRANSCRIBE_WARN_MINUTES", "0")
    get_settings.cache_clear()

    pid = _import(client, sample_video_with_audio)

    resp = client.post(f"/api/projects/{pid}/transcribe", json={})
    assert resp.status_code == 409

    resp = client.post(
        f"/api/projects/{pid}/transcribe", json={"confirm_long": True}
    )
    assert resp.status_code == 202
    final = _wait_for_job(client, resp.json()["id"])
    assert final["status"] == "done"
