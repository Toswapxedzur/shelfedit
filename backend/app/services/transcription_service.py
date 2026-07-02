"""Transcription logic.

Extracts audio from a project's video and turns it into a transcript. The
OpenAI call is isolated in one function so it can be mocked in tests, and a
fake provider (off by default) lets the app run without a key for local dev.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from ..config import Settings


class MissingApiKeyError(Exception):
    """Raised when transcription is attempted without an OpenAI key."""


class TranscriptionError(Exception):
    """Raised when the transcription provider fails."""


@dataclass
class Segment:
    start: float
    end: float
    text: str


@dataclass
class Word:
    start: float
    end: float
    word: str


@dataclass
class NormalizedTranscript:
    text: str
    language: str | None
    segments: list[Segment] = field(default_factory=list)
    words: list[Word] = field(default_factory=list)
    raw: dict = field(default_factory=dict)


def _normalize(raw: dict) -> NormalizedTranscript:
    """Turn a verbose_json transcription payload into our internal shape."""
    segments = [
        Segment(
            start=float(s.get("start", 0.0)),
            end=float(s.get("end", 0.0)),
            text=str(s.get("text", "")).strip(),
        )
        for s in (raw.get("segments") or [])
    ]
    words = [
        Word(
            start=float(w.get("start", 0.0)),
            end=float(w.get("end", 0.0)),
            word=str(w.get("word", "")),
        )
        for w in (raw.get("words") or [])
    ]
    return NormalizedTranscript(
        text=str(raw.get("text", "")).strip(),
        language=raw.get("language"),
        segments=segments,
        words=words,
        raw=raw,
    )


def _fake_transcribe(audio_path: Path) -> dict:
    """Canned result for offline dev/testing (SHELFEDIT_FAKE_TRANSCRIBE).

    Segments are spread evenly across the real audio duration so the offline
    sample lines up with the actual clip on the timeline.
    """
    phrases = [
        "This is a sample transcript",
        "generated in offline mode.",
        "It stands in for a real transcription.",
    ]

    # Best-effort duration probe; fall back to a nominal length if unavailable.
    total = 9.0
    try:
        from ..utils.ffmpeg import probe

        probed = probe(audio_path).duration_seconds
        if probed and probed > 0:
            total = probed
    except Exception:  # noqa: BLE001 - offline sample must never hard-fail
        pass

    step = total / len(phrases)
    segments = [
        {
            "start": round(i * step, 3),
            "end": round(min((i + 1) * step, total), 3),
            "text": phrase,
        }
        for i, phrase in enumerate(phrases)
    ]
    return {
        "text": " ".join(phrases),
        "language": "english",
        "segments": segments,
        "words": [],
    }


def _openai_transcribe(audio_path: Path, model: str, api_key: str) -> dict:
    """Call OpenAI's transcription API and return a plain dict payload."""
    from openai import OpenAI

    client = OpenAI(api_key=api_key)
    with audio_path.open("rb") as f:
        try:
            result = client.audio.transcriptions.create(
                model=model,
                file=f,
                response_format="verbose_json",
                timestamp_granularities=["segment", "word"],
            )
        except Exception as e:  # noqa: BLE001 - surface a clean error upward
            raise TranscriptionError(str(e)) from e

    if hasattr(result, "model_dump"):
        return result.model_dump()
    if hasattr(result, "to_dict"):
        return result.to_dict()
    return dict(result)


def transcribe_audio_file(audio_path: Path, settings: Settings) -> NormalizedTranscript:
    """Produce a normalized transcript for an already-extracted audio file."""
    if settings.fake_transcribe:
        return _normalize(_fake_transcribe(audio_path))

    if not settings.openai_api_key:
        raise MissingApiKeyError(
            "No OpenAI API key configured. Add OPENAI_API_KEY to backend/.env."
        )

    raw = _openai_transcribe(
        audio_path, settings.openai_transcribe_model, settings.openai_api_key
    )
    return _normalize(raw)


def save_raw_json(raw: dict, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(raw, indent=2, ensure_ascii=False))
    return dest
