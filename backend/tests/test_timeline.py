"""Editable timeline + media preview (filmstrip / waveform) tests."""

from __future__ import annotations

import subprocess

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


def test_timeline_default_is_created(client):
    pid = client.post("/api/projects", json={"name": "TL"}).json()["id"]
    tl = client.get(f"/api/projects/{pid}/timeline").json()
    kinds = [t["kind"] for t in tl["data"]["tracks"]]
    assert kinds == ["text", "video", "audio"]
    assert all(t["elements"] == [] for t in tl["data"]["tracks"])


def test_timeline_save_roundtrip(client):
    pid = client.post("/api/projects", json={"name": "TL2"}).json()["id"]
    data = {
        "duration": 5.0,
        "tracks": [
            {
                "id": "trk_video_1",
                "kind": "video",
                "name": "Video",
                "order": 0,
                "elements": [
                    {
                        "id": "c1",
                        "type": "video",
                        "media_id": "m1",
                        "source_start": 0.0,
                        "source_end": 5.0,
                        "timeline_start": 0.0,
                    }
                ],
            }
        ],
    }
    saved = client.put(f"/api/projects/{pid}/timeline", json={"data": data}).json()
    assert saved["data"]["tracks"][0]["elements"][0]["id"] == "c1"

    reloaded = client.get(f"/api/projects/{pid}/timeline").json()
    assert reloaded["data"]["duration"] == 5.0
    assert reloaded["data"]["tracks"][0]["elements"][0]["media_id"] == "m1"


def test_filmstrip_and_waveform(client, av_video):
    pid = client.post("/api/projects", json={"name": "Prev"}).json()["id"]
    media = client.post(
        f"/api/projects/{pid}/media/import",
        json={"source_path": str(av_video), "copy": True},
    ).json()
    mid = media["id"]

    strip = client.get(f"/api/media/{mid}/filmstrip")
    assert strip.status_code == 200
    assert strip.headers["content-type"] == "image/jpeg"
    assert len(strip.content) > 0

    wave = client.get(f"/api/media/{mid}/waveform").json()
    assert isinstance(wave["peaks"], list)
    assert len(wave["peaks"]) > 0
    assert all(0.0 <= p <= 1.0 for p in wave["peaks"])
