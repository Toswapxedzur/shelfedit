"""Test fixtures.

Each test runs against an isolated on-disk SQLite database in a temp dir, so the
real app data folder is never touched.
"""

from __future__ import annotations

import importlib
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch) -> Iterator[TestClient]:
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_file}")
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path))

    # Reimport config/database/main so they pick up the patched environment
    # with a fresh engine bound to the temp database.
    import app.config as config

    config.get_settings.cache_clear()

    import app.database as database

    importlib.reload(database)

    import app.routers.projects as projects_router

    importlib.reload(projects_router)

    import app.routers.media as media_router

    importlib.reload(media_router)

    # Job runner binds the DB engine at import time, so reload it after database.
    import app.workers.job_runner as job_runner

    importlib.reload(job_runner)

    import app.routers.transcript as transcript_router

    importlib.reload(transcript_router)

    import app.routers.ai as ai_router

    importlib.reload(ai_router)

    import app.routers.render as render_router

    importlib.reload(render_router)

    import app.main as main

    importlib.reload(main)

    with TestClient(main.app) as c:
        yield c
