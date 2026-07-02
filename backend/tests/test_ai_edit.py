"""AI edit tests (offline). Uses fake transcription + fake AI, no network."""

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
        "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", "-shortest",
        str(out),
    ]
    assert subprocess.run(cmd, capture_output=True).returncode == 0
    return out


def _wait_job(client, job_id, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        j = client.get(f"/api/jobs/{job_id}").json()
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.2)
    return None


@pytest.fixture()
def transcribed_project(client, av_video, monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("SHELFEDIT_FAKE_TRANSCRIBE", "1")
    monkeypatch.setenv("SHELFEDIT_FAKE_AI", "1")
    get_settings.cache_clear()

    pid = client.post("/api/projects", json={"name": "AI"}).json()["id"]
    client.post(
        f"/api/projects/{pid}/media/import",
        json={"source_path": str(av_video), "copy": True},
    )
    job = client.post(f"/api/projects/{pid}/transcribe", json={}).json()
    final = _wait_job(client, job["id"])
    assert final and final["status"] == "done"
    return pid


def test_ai_requires_transcript(client, av_video, monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("SHELFEDIT_FAKE_AI", "1")
    get_settings.cache_clear()

    pid = client.post("/api/projects", json={"name": "No TX"}).json()["id"]
    client.post(
        f"/api/projects/{pid}/media/import",
        json={"source_path": str(av_video), "copy": True},
    )
    resp = client.post(
        f"/api/projects/{pid}/ai/messages", json={"content": "cut it"}
    )
    assert resp.status_code == 400


def test_message_proposes_cut_plan(transcribed_project, client):
    pid = transcribed_project
    resp = client.post(
        f"/api/projects/{pid}/ai/messages",
        json={"content": "Please tighten this video."},
    )
    assert resp.status_code == 201, resp.text
    msgs = resp.json()
    assert msgs[0]["role"] == "user"
    assistant = msgs[1]
    assert assistant["role"] == "assistant"
    assert assistant["change"] is not None
    assert assistant["change"]["type"] == "cut_plan"
    assert len(assistant["change"]["keep"]) >= 1
    assert assistant["change_status"] == "proposed"


def test_apply_change_creates_timeline(transcribed_project, client):
    pid = transcribed_project
    msgs = client.post(
        f"/api/projects/{pid}/ai/messages", json={"content": "cut"}
    ).json()
    assistant = msgs[1]

    resp = client.post(
        f"/api/projects/{pid}/ai/messages/{assistant['id']}/apply"
    )
    assert resp.status_code == 200, resp.text
    timeline = resp.json()
    assert timeline["version"] == 1
    tracks = timeline["data"]["tracks"]
    assert tracks and tracks[0]["kind"] == "video"
    assert len(tracks[0]["elements"]) >= 1

    # Project advanced and the change is marked applied.
    project = client.get(f"/api/projects/{pid}").json()
    assert project["status"] == "ai_cut_ready"

    # Applying again is rejected.
    again = client.post(
        f"/api/projects/{pid}/ai/messages/{assistant['id']}/apply"
    )
    assert again.status_code == 409

    # Timeline is retrievable.
    assert client.get(f"/api/projects/{pid}/timeline").status_code == 200


def test_conversation_history_persists(transcribed_project, client):
    pid = transcribed_project
    client.post(f"/api/projects/{pid}/ai/messages", json={"content": "first"})
    client.post(f"/api/projects/{pid}/ai/messages", json={"content": "second"})
    history = client.get(f"/api/projects/{pid}/ai/messages").json()
    # 2 turns x (user + assistant) = 4 messages, in order.
    assert len(history) == 4
    assert history[0]["content"] == "first"
    assert history[0]["role"] == "user"
