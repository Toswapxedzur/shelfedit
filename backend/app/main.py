"""FastAPI application entrypoint.

Run locally with:
    uvicorn app.main:app --reload
from the backend/ directory.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .database import init_db
from .routers import media, projects, transcript
from .schemas import HealthResponse

# Built desktop UI (produced by `npm run build` in ../frontend).
_WEBUI_DIR = Path(__file__).resolve().parent / "webui"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create data dirs and tables on startup.
    settings = get_settings()
    settings.ensure_data_dirs()
    init_db()
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allow_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health", response_model=HealthResponse, tags=["system"])
    def health() -> HealthResponse:
        return HealthResponse(status="ok", app=settings.app_name)

    app.include_router(projects.router)
    app.include_router(media.router)
    app.include_router(transcript.router)

    # Serve the built desktop UI as a fallback for any non-API path. API and
    # docs routes are registered above, so they take precedence over this mount.
    # When the UI has not been built yet, we skip this so the API still runs.
    if _WEBUI_DIR.is_dir():
        app.mount("/", StaticFiles(directory=_WEBUI_DIR, html=True), name="webui")

    return app


app = create_app()
