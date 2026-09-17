"""
Central configuration.

The Groq key (and every other secret) lives in the `.env` file at the
*project root* (one level above `backend/`). It is loaded here once with
python-dotenv, so anywhere in the backend `os.getenv("GROQ_API_KEY")` works;
modules read it through `settings` for convenience.
"""
from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent

# Project-root .env first, then backend/.env (lets people keep either layout).
load_dotenv(PROJECT_ROOT / ".env")
load_dotenv(BACKEND_DIR / ".env")


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


@dataclass(frozen=True)
class Settings:
    groq_api_key: str = field(default_factory=lambda: _env("GROQ_API_KEY"))
    groq_model: str = field(default_factory=lambda: _env("GROQ_MODEL", "llama-3.3-70b-versatile"))
    groq_fallback_model: str = field(default_factory=lambda: _env("GROQ_FALLBACK_MODEL", "llama-3.1-8b-instant"))

    hf_token: str = field(default_factory=lambda: _env("HF_TOKEN"))
    hf_model: str = field(default_factory=lambda: _env("HF_MODEL", "Qwen/Qwen2.5-7B-Instruct"))
    hf_local_model: str = field(default_factory=lambda: _env("HF_LOCAL_MODEL"))

    embedding_model: str = field(
        default_factory=lambda: _env("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
    )
    whisper_model: str = field(default_factory=lambda: _env("WHISPER_MODEL", "base"))

    host: str = field(default_factory=lambda: _env("HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(_env("PORT", "8765")))
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(o.strip() for o in _env("CORS_ORIGINS", "*").split(",") if o.strip())
    )

    notion_token: str = field(default_factory=lambda: _env("NOTION_TOKEN"))
    notion_parent_page_id: str = field(default_factory=lambda: _env("NOTION_PARENT_PAGE_ID"))

    data_dir: Path = BACKEND_DIR / "data"

    @property
    def groq_enabled(self) -> bool:
        return bool(self.groq_api_key) and self.groq_api_key != "your_api_key_here"


settings = Settings()
for sub in ("", "cache", "media"):
    (settings.data_dir / sub).mkdir(parents=True, exist_ok=True)


def has_module(name: str) -> bool:
    """True when an optional dependency is importable (checked without importing it)."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False
