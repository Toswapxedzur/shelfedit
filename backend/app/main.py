"""FastAPI application entrypoint.

Run locally with:
    uvicorn app.main:app --reload
from the backend/ directory.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .database import init_db
from .routers import projects
from .schemas import HealthResponse


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
    return app


app = create_app()
