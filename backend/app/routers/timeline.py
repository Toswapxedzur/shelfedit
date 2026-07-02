"""Editable timeline: the central document the editor reads and writes.

GET returns the working timeline (creating an empty default with the standard
text / video / audio tracks if none exists). PUT saves the whole timeline JSON
(the editor autosaves after each change). Rendering reads this same data.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from ..database import get_session
from ..models import Timeline
from ..schemas import TimelineRead, TimelineSave
from .projects import _get_active_project

router = APIRouter(tags=["timeline"])


def _default_timeline_data() -> dict:
    return {
        "duration": 0,
        "tracks": [
            {"id": "trk_text_1", "kind": "text", "name": "Text", "order": 0, "elements": []},
            {"id": "trk_video_1", "kind": "video", "name": "Video", "order": 1, "elements": []},
            {"id": "trk_audio_1", "kind": "audio", "name": "Audio", "order": 2, "elements": []},
        ],
    }


def _working_timeline(session: Session, project_id: str) -> Timeline:
    timeline = session.exec(
        select(Timeline)
        .where(Timeline.project_id == project_id)
        .order_by(Timeline.version.desc())  # type: ignore[union-attr]
    ).first()
    if timeline is None:
        timeline = Timeline(
            project_id=project_id,
            version=1,
            data_json=json.dumps(_default_timeline_data()),
        )
        session.add(timeline)
        session.commit()
        session.refresh(timeline)
    return timeline


def _to_read(timeline: Timeline) -> TimelineRead:
    return TimelineRead(
        id=timeline.id,
        version=timeline.version,
        data=json.loads(timeline.data_json),
        created_at=timeline.created_at,
    )


@router.get("/api/projects/{project_id}/timeline", response_model=TimelineRead)
def get_timeline(project_id: str, session: Session = Depends(get_session)):
    _get_active_project(project_id, session)
    return _to_read(_working_timeline(session, project_id))


@router.put("/api/projects/{project_id}/timeline", response_model=TimelineRead)
def save_timeline(
    project_id: str,
    payload: TimelineSave,
    session: Session = Depends(get_session),
):
    _get_active_project(project_id, session)
    timeline = _working_timeline(session, project_id)
    timeline.data_json = json.dumps(payload.data)
    session.add(timeline)
    session.commit()
    session.refresh(timeline)
    return _to_read(timeline)
