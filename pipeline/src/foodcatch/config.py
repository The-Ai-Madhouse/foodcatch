"""Pipeline configuration (architecture §8).

Values come from real environment variables first, then from a ``.env`` file found by searching
upward from the current working directory (normally the repository root). Set
``FOODCATCH_ENV_FILE`` to an explicit path to use another file, or to an empty string to load no
file at all (the test-suite does this).
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from dotenv import dotenv_values
from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

ENV_FILE_OVERRIDE = "FOODCATCH_ENV_FILE"
DEFAULT_DATABASE_URL = "postgresql+psycopg://foodcatch:foodcatch@localhost:5432/foodcatch"
DEFAULT_REGION_CENTERS: tuple[tuple[float, float], ...] = ((55.6761, 12.5683),)

type Coordinate = tuple[float, float]


class ConfigError(ValueError):
    """Raised when configuration is missing or malformed."""


def find_env_file(start: Path | None = None) -> Path | None:
    """Return the nearest ``.env`` in ``start`` (default: cwd) or one of its parents."""
    override = os.environ.get(ENV_FILE_OVERRIDE)
    if override is not None:
        return Path(override) if override else None
    here = (start or Path.cwd()).resolve()
    for directory in (here, *here.parents):
        candidate = directory / ".env"
        if candidate.is_file():
            return candidate
    return None


def find_project_root(start: Path | None = None) -> Path:
    """Return the repository root: the nearest ancestor containing ``.git`` or ``.env``.

    Relative paths in settings (e.g. ``RAW_STORE_URL=file://./data/raw``) are resolved against
    it, so commands behave the same whether they run from the repo root or ``pipeline/``.
    Falls back to ``start`` (default: cwd) when no marker is found.
    """
    here = (start or Path.cwd()).resolve()
    for directory in (here, *here.parents):
        if (directory / ".git").exists() or (directory / ".env").is_file():
            return directory
    return here


def parse_coordinates(value: str) -> list[Coordinate]:
    """Parse ``"lat,lon;lat,lon"`` into a list of ``(lat, lon)`` tuples.

    Raises:
        ConfigError: if a pair is malformed or out of range.
    """
    centers: list[Coordinate] = []
    for raw_pair in value.split(";"):
        pair = raw_pair.strip()
        if not pair:
            continue
        parts = [p.strip() for p in pair.split(",")]
        if len(parts) != 2:
            raise ConfigError(f"expected 'lat,lon', got {pair!r}")
        try:
            lat, lon = float(parts[0]), float(parts[1])
        except ValueError as exc:
            raise ConfigError(f"expected numeric 'lat,lon', got {pair!r}") from exc
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            raise ConfigError(f"coordinate out of range: {pair!r}")
        centers.append((lat, lon))
    return centers


def healthchecks_env_key(job: str) -> str:
    """Name of the env var with the ping URL of ``job`` (``tjek-offers`` -> ``..._TJEK_OFFERS``)."""
    return "HEALTHCHECKS_URL_" + re.sub(r"[^A-Z0-9]+", "_", job.upper()).strip("_")


class Settings(BaseSettings):
    """All pipeline settings. Field names map to upper-case environment variables."""

    model_config = SettingsConfigDict(
        env_file=None,
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
        frozen=True,
    )

    database_url: str = DEFAULT_DATABASE_URL
    raw_store_url: str = "file://./data/raw"

    s3_endpoint_url: str | None = None
    s3_access_key_id: str | None = None
    s3_secret_access_key: SecretStr | None = None
    s3_region: str | None = None

    salling_api_key: SecretStr | None = None

    region_centers: Annotated[list[Coordinate], NoDecode] = Field(
        default_factory=lambda: list(DEFAULT_REGION_CENTERS)
    )
    region_radius_km: float = Field(default=30.0, gt=0)

    sentry_dsn: SecretStr | None = None
    db_size_budget_mb: int = Field(default=1024, gt=0)
    quality_drop_threshold: float = Field(default=0.5, ge=0, le=1)
    """A run whose quality metric drops by more than this fraction is ``degraded``."""

    off_batch_size: int = Field(default=500, ge=1, le=10_000)
    """Products looked up per ``off-enrich`` run (``OFF_BATCH_SIZE``)."""

    log_level: str = "INFO"
    log_format: Literal["auto", "json", "console"] = "auto"
    git_sha: str | None = Field(
        default=None, validation_alias=AliasChoices("GIT_SHA", "GITHUB_SHA")
    )

    env_file_path: Path | None = Field(default=None, exclude=True)
    """The ``.env`` file these settings were loaded from (informational)."""

    @field_validator("region_centers", mode="before")
    @classmethod
    def _parse_region_centers(cls, value: object) -> object:
        if isinstance(value, str):
            return parse_coordinates(value)
        return value

    @field_validator(
        "s3_endpoint_url",
        "s3_access_key_id",
        "s3_secret_access_key",
        "s3_region",
        "salling_api_key",
        "sentry_dsn",
        "git_sha",
        mode="before",
    )
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    def healthchecks_url(self, job: str) -> str | None:
        """Return the healthchecks.io ping URL for ``job`` or ``None`` if not configured.

        Looks up ``HEALTHCHECKS_URL_<JOB>`` in the environment, then in the ``.env`` file.
        """
        key = healthchecks_env_key(job)
        value = os.environ.get(key)
        if value is None and self.env_file_path is not None and self.env_file_path.is_file():
            value = dotenv_values(self.env_file_path).get(key)
        return value.strip() or None if value else None

    def require_salling_api_key(self) -> str:
        """Return the Salling API key or raise :class:`ConfigError` if it is not set."""
        if self.salling_api_key is None:
            raise ConfigError("SALLING_API_KEY is not set")
        return self.salling_api_key.get_secret_value()

    def resolve_path(self, path: str | Path) -> Path:
        """Resolve a possibly relative path against the project root."""
        p = Path(path).expanduser()
        if p.is_absolute():
            return p
        base = self.env_file_path.parent if self.env_file_path else find_project_root()
        return (base / p).resolve()


def load_settings(env_file: Path | None = None) -> Settings:
    """Build settings from the environment and ``env_file`` (default: :func:`find_env_file`)."""
    path = env_file if env_file is not None else find_env_file()
    return Settings(_env_file=path, env_file_path=path)  # pyright: ignore[reportCallIssue]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings (cached). Call ``get_settings.cache_clear()`` in tests."""
    return load_settings()
