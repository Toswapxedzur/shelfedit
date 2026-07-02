"""AI edit endpoints: converse with the assistant, apply a proposed change."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from ..config import get_settings
from ..database import get_session
from ..models import (
    AiMessage,
    AiRole,
    ChangeStatus,
    MediaAsset,
    MediaType,
    ProjectStatus,
    Timeline,
    Transcript,
    TranscriptSegment,
)
from ..schemas import AiMessageRead, AiSendRequest, TimelineRead
from ..services import ai_edit_service as ai
from .projects import _get_active_project

router = APIRouter(tags=["ai"])


def _to_read(msg: AiMessage) -> AiMessageRead:
    change = json.loads(msg.change_json) if msg.change_json else None
    return AiMessageRead(
        id=msg.id,
        role=msg.role,
        content=msg.content,
        change=change,
        change_status=msg.change_status,
        created_at=msg.created_at,
    )


def _load_transcript_segments(session: Session, project_id: str):
    transcript = session.exec(
        select(Transcript)
        .where(Transcript.project_id == project_id)
        .order_by(Transcript.created_at.desc())  # type: ignore[union-attr]
    ).first()
    if transcript is None:
        return None, []
    segs = session.exec(
        select(TranscriptSegment)
        .where(TranscriptSegment.transcript_id == transcript.id)
        .order_by(TranscriptSegment.idx)  # type: ignore[arg-type]
    ).all()
    return transcript, [
        {"start": s.start_seconds, "end": s.end_seconds, "text": s.text} for s in segs
    ]


@router.get("/api/projects/{project_id}/ai/messages", response_model=list[AiMessageRead])
def list_messages(project_id: str, session: Session = Depends(get_session)):
    _get_active_project(project_id, session)
    msgs = session.exec(
        select(AiMessage)
        .where(AiMessage.project_id == project_id)
        .order_by(AiMessage.created_at)  # type: ignore[arg-type]
    ).all()
    return [_to_read(m) for m in msgs]


@router.post(
    "/api/projects/{project_id}/ai/messages",
    response_model=list[AiMessageRead],
    status_code=status.HTTP_201_CREATED,
)
def send_message(
    project_id: str,
    payload: AiSendRequest,
    session: Session = Depends(get_session),
):
    project = _get_active_project(project_id, session)
    settings = get_settings()

    transcript, segments = _load_transcript_segments(session, project_id)
    if transcript is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Transcribe the video before using AI edit.",
        )

    video = session.exec(
        select(MediaAsset)
        .where(MediaAsset.project_id == project_id)
        .where(MediaAsset.type == MediaType.video)
    ).first()
    duration = video.duration_seconds if video else None

    # Prior conversation for context.
    history_msgs = session.exec(
        select(AiMessage)
        .where(AiMessage.project_id == project_id)
        .order_by(AiMessage.created_at)  # type: ignore[arg-type]
    ).all()
    history = [{"role": m.role.value, "content": m.content} for m in history_msgs]

    # Persist the user's message.
    user_msg = AiMessage(
        project_id=project_id, role=AiRole.user, content=payload.content
    )
    session.add(user_msg)
    session.commit()

    try:
        result = ai.generate_assistant_result(
            segments, duration, history, payload.content, settings
        )
    except ai.MissingApiKeyError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except ai.AiError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI request failed: {e}",
        )

    assistant_msg = AiMessage(
        project_id=project_id,
        role=AiRole.assistant,
        content=result.reply,
        change_json=json.dumps(result.change) if result.change else None,
        change_status=ChangeStatus.proposed if result.change else None,
    )
    session.add(assistant_msg)
    session.commit()
    session.refresh(user_msg)
    session.refresh(assistant_msg)
    return [_to_read(user_msg), _to_read(assistant_msg)]


@router.post(
    "/api/projects/{project_id}/ai/messages/{message_id}/apply",
    response_model=TimelineRead,
)
def apply_change(
    project_id: str,
    message_id: str,
    session: Session = Depends(get_session),
):
    project = _get_active_project(project_id, session)
    msg = session.get(AiMessage, message_id)
    if msg is None or msg.project_id != project_id or not msg.change_json:
        raise HTTPException(status_code=404, detail="No applicable change found")
    if msg.change_status == ChangeStatus.applied:
        raise HTTPException(status_code=409, detail="Change already applied")

    change = json.loads(msg.change_json)
    if change.get("type") != "cut_plan":
        raise HTTPException(status_code=400, detail="Unsupported change type")

    video = session.exec(
        select(MediaAsset)
        .where(MediaAsset.project_id == project_id)
        .where(MediaAsset.type == MediaType.video)
    ).first()
    if video is None:
        raise HTTPException(status_code=400, detail="No video to build a timeline from")

    data = ai.build_timeline_data(change, video.id)

    # Version the timeline (never overwrite a previous one).
    prior = session.exec(
        select(Timeline)
        .where(Timeline.project_id == project_id)
        .order_by(Timeline.version.desc())  # type: ignore[union-attr]
    ).first()
    next_version = (prior.version + 1) if prior else 1

    timeline = Timeline(
        project_id=project_id, version=next_version, data_json=json.dumps(data)
    )
    session.add(timeline)

    msg.change_status = ChangeStatus.applied
    session.add(msg)

    project.status = ProjectStatus.ai_cut_ready
    session.add(project)
    session.commit()
    session.refresh(timeline)

    return TimelineRead(
        id=timeline.id,
        version=timeline.version,
        data=json.loads(timeline.data_json),
        created_at=timeline.created_at,
    )
