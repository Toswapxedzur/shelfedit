"""Database engine and session management.

Phase 1 uses SQLite for a self-contained local install. The engine is created
from a URL in settings, so a later phase can point this at a networked database
(for the deployable server) without changing calling code.
"""

from __future__ import annotations

from collections.abc import Iterator

from sqlmodel import Session, SQLModel, create_engine

from .config import get_settings


def _make_engine():
    settings = get_settings()
    connect_args = {}
    # SQLite needs this flag to be usable across FastAPI's threaded request
    # handling. It is harmless / ignored for other database backends.
    if settings.database_url.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
        # Ensure the parent directory for the SQLite file exists.
        settings.ensure_data_dirs()
    return create_engine(settings.database_url, echo=False, connect_args=connect_args)


engine = _make_engine()


def init_db() -> None:
    """Create all tables. Import models so they register with SQLModel metadata."""
    from . import models  # noqa: F401  (import for side effects: table registration)

    SQLModel.metadata.create_all(engine)


def get_session() -> Iterator[Session]:
    """FastAPI dependency that yields a database session per request."""
    with Session(engine) as session:
        yield session
