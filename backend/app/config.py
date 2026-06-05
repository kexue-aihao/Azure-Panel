from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(ROOT_DIR / ".env", ROOT_DIR / "backend" / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Azure Panel"
    secret_key: str = "change-me-in-production-use-long-random-string"
    database_url: str = "sqlite+aiosqlite:///./data/azure_panel.db"
    encryption_key: str = "change-me-32-byte-base64-fernet-key=="
    access_token_expire_minutes: int = 60 * 24 * 7
    worker_interval_seconds: int = 60
    azure_api_version: str = "2024-11-01"
    cors_origins: str = "*"


@lru_cache
def get_settings() -> Settings:
    return Settings()
