"""AI edit assistant.

A multi-turn assistant that reads a project's transcript and proposes edits. For
now the only change type is a cut plan (keep/remove sections). The OpenAI call is
isolated so it can be mocked, and a fake provider (off by default) lets the app
run without a key.

The design keeps a typed "change envelope" so future change types (add text,
reorder, overlays) can be added without reworking the chat plumbing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from ..config import Settings

SYSTEM_PROMPT = """You are an editing assistant inside a local video editor.
You help the user edit a single video using its transcript.

Rules:
- Be concise and helpful in your chat reply.
- When the user asks you to cut, trim, tighten, or restructure the video,
  propose a cut plan: which time ranges to KEEP and which to REMOVE.
- Use only timestamps that fall within the video duration. Do not invent content.
- Prefer keeping whole sentences/ideas; avoid cutting mid-sentence.
- If uncertain, keep slightly more context.
- If the user is only chatting or asking a question, reply without a change.

Return ONLY valid JSON with this shape:
{
  "reply": "your chat message to the user",
  "change": null OR {
    "type": "cut_plan",
    "keep":   [{"start": number, "end": number, "label": string, "reason": string}],
    "remove": [{"start": number, "end": number, "reason": string}]
  }
}
"""


@dataclass
class KeepSegment:
    start: float
    end: float
    label: str = ""
    reason: str = ""


@dataclass
class AssistantResult:
    reply: str
    change: dict | None  # validated change envelope, or None


class MissingApiKeyError(Exception):
    pass


class AiError(Exception):
    pass


def _transcript_context(segments: list[dict], duration: float | None) -> str:
    lines = [f"Video duration: {duration:.2f} seconds." if duration else "Video."]
    lines.append("Transcript segments (start - end : text):")
    for s in segments:
        lines.append(f"[{s['start']:.2f} - {s['end']:.2f}] {s['text']}")
    return "\n".join(lines)


def build_messages(
    segments: list[dict],
    duration: float | None,
    history: list[dict],
    user_text: str,
) -> list[dict]:
    """Assemble the chat context sent to the model."""
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "system", "content": _transcript_context(segments, duration)},
    ]
    for h in history:
        messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": user_text})
    return messages


def validate_cut_plan(change: dict, duration: float | None) -> dict:
    """Clean an AI cut plan: clamp, drop invalid/tiny clips, sort, merge overlaps."""
    keep_raw = change.get("keep") or []
    cleaned: list[KeepSegment] = []
    max_end = duration if duration else float("inf")
    for c in keep_raw:
        try:
            start = max(0.0, float(c.get("start", 0)))
            end = min(max_end, float(c.get("end", 0)))
        except (TypeError, ValueError):
            continue
        if end - start < 0.5:  # reject sub-half-second clips
            continue
        cleaned.append(
            KeepSegment(
                start=start,
                end=end,
                label=str(c.get("label", "")),
                reason=str(c.get("reason", "")),
            )
        )

    cleaned.sort(key=lambda s: s.start)

    # Merge overlapping/adjacent keep ranges.
    merged: list[KeepSegment] = []
    for seg in cleaned:
        if merged and seg.start <= merged[-1].end:
            if seg.end > merged[-1].end:
                merged[-1].end = seg.end
        else:
            merged.append(seg)

    return {
        "type": "cut_plan",
        "keep": [
            {"start": s.start, "end": s.end, "label": s.label, "reason": s.reason}
            for s in merged
        ],
        "remove": change.get("remove") or [],
    }


def _fake_chat(segments: list[dict], duration: float | None, user_text: str) -> dict:
    """Canned assistant turn for offline dev/testing (SHELFEDIT_FAKE_AI)."""
    keep = []
    if segments:
        # Keep every other segment as a stand-in cut plan.
        for i, s in enumerate(segments):
            if i % 2 == 0:
                keep.append(
                    {
                        "start": s["start"],
                        "end": s["end"],
                        "label": (s["text"][:24] or "segment"),
                        "reason": "kept in offline sample plan",
                    }
                )
    return {
        "reply": (
            "Here's a proposed cut plan based on the transcript (offline sample). "
            "Review the ranges and click Apply if they look right."
        ),
        "change": {"type": "cut_plan", "keep": keep, "remove": []},
    }


def _openai_chat(messages: list[dict], model: str, api_key: str) -> dict:
    from openai import OpenAI

    client = OpenAI(api_key=api_key)
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            response_format={"type": "json_object"},
        )
        content = resp.choices[0].message.content or "{}"
    except Exception as e:  # noqa: BLE001
        raise AiError(str(e)) from e

    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return {"reply": content, "change": None}


def generate_assistant_result(
    segments: list[dict],
    duration: float | None,
    history: list[dict],
    user_text: str,
    settings: Settings,
) -> AssistantResult:
    if settings.fake_ai:
        raw = _fake_chat(segments, duration, user_text)
    else:
        if not settings.openai_api_key:
            raise MissingApiKeyError(
                "No OpenAI API key configured. Add OPENAI_API_KEY to backend/.env."
            )
        messages = build_messages(segments, duration, history, user_text)
        raw = _openai_chat(messages, settings.openai_cut_model, settings.openai_api_key)

    reply = str(raw.get("reply", "")).strip() or "(no reply)"
    change = raw.get("change")
    if isinstance(change, dict) and change.get("type") == "cut_plan":
        change = validate_cut_plan(change, duration)
        # Drop empty plans so we don't show a useless change card.
        if not change["keep"]:
            change = None
    else:
        change = None

    return AssistantResult(reply=reply, change=change)


def build_timeline_data(change: dict, media_id: str) -> dict:
    """Turn an approved cut plan into timeline JSON (one video track)."""
    elements = []
    timeline_pos = 0.0
    for i, seg in enumerate(change.get("keep", [])):
        start = float(seg["start"])
        end = float(seg["end"])
        dur = end - start
        elements.append(
            {
                "id": f"el_{i+1}",
                "type": "video",
                "media_id": media_id,
                "source_start": start,
                "source_end": end,
                "timeline_start": timeline_pos,
            }
        )
        timeline_pos += dur

    return {
        "duration": timeline_pos,
        "tracks": [
            {
                "id": "trk_video_1",
                "kind": "video",
                "order": 0,
                "elements": elements,
            }
        ],
    }
