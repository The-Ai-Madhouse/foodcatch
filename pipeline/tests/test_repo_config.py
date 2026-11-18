"""Repository configuration that protects the development database (finding S4)."""

from __future__ import annotations

from pathlib import Path

COMPOSE = Path(__file__).resolve().parents[2] / "docker-compose.yml"


def test_dev_postgres_is_published_on_loopback_only() -> None:
    # The superuser password is public in this repository: never publish it on 0.0.0.0.
    ports = [
        line.strip().lstrip("- ").strip('"')
        for line in COMPOSE.read_text(encoding="utf-8").splitlines()
        if line.strip().startswith('- "') and line.strip().endswith(':5432"')
    ]
    assert ports == ["127.0.0.1:5432:5432"]
