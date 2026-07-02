"""Application configuration.

Loads settings from environment variables (optionally via a local .env file).
Nothing secret is hardcoded here; the OpenAI key lives only in the environment.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

# Load backend/.env if present. This is a no-op when the file is absent,
# which keeps CI and tests happy without requiring secrets.
_BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(_BACKEND_DIR / ".env")


def _expand(path_str: str) -> Path:
    """Expand ~ and environment variables into an absolute path."""
    return Path(os.path.expandvars(os.path.expanduser(path_str))).resolve()


class Settings:
    """Runtime settings resolved from the environment.

    Kept intentionally simple for Phase 1. Fields unrelated to the backend
    skeleton (OpenAI models, import limits) are read but not yet used, so the
    same .env carries forward cleanly into later phases.
    """

    def __init__(self) -> None:
        self.app_name: str = "ShelfEdit"
        self.app_data_dir: Path = _expand(
            os.getenv("APP_DATA_DIR", "~/.local_ai_video_editor")
        )

        # Database URL. Defaults to a SQLite file inside the app data dir so the
        # local install is self-contained. Deployable later by pointing this at
        # a networked database without touching application code.
        default_db = f"sqlite:///{self.app_data_dir / 'shelfedit.db'}"
        self.database_url: str = os.getenv("DATABASE_URL", default_db)

        # Carried forward for later phases (not used in Phase 1).
        self.openai_api_key: str | None = os.getenv("OPENAI_API_KEY") or None
        self.openai_transcribe_model: str = os.getenv(
            "OPENAI_TRANSCRIBE_MODEL", "whisper-1"
        )
        self.openai_cut_model: str = os.getenv("OPENAI_CUT_MODEL", "gpt-4o")
        self.max_import_file_gb: float = float(os.getenv("MAX_IMPORT_FILE_GB", "30"))

        # Warn/confirm before transcribing very long audio (cost + time guard).
        self.transcribe_warn_minutes: float = float(
            os.getenv("TRANSCRIBE_WARN_MINUTES", "120")
        )

        # Dev/test aid: when true, transcription returns a canned result instead
        # of calling OpenAI. Off by default — real OpenAI is used normally.
        self.fake_transcribe: bool = os.getenv(
            "SHELFEDIT_FAKE_TRANSCRIBE", ""
        ).strip().lower() in ("1", "true", "yes")

        # CORS origins for the desktop/web client during local development.
        raw_origins = os.getenv(
            "CORS_ALLOW_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
        )
        self.cors_allow_origins: list[str] = [
            o.strip() for o in raw_origins.split(",") if o.strip()
        ]

    def ensure_data_dirs(self) -> None:
        """Create the base app data directory tree if it does not exist."""
        for sub in ("", "config", "projects", "cache", "logs"):
            (self.app_data_dir / sub).mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()
