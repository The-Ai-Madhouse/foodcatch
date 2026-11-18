"""``.github/scripts/mask_database_url.py`` (finding S1): the DB host never reaches public logs."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / ".github" / "scripts" / "mask_database_url.py"


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("mask_database_url", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _masks(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], url: str | None
) -> list[str]:
    if url is None:
        monkeypatch.delenv("DATABASE_URL", raising=False)
    else:
        monkeypatch.setenv("DATABASE_URL", url)
    assert _load().main() == 0
    return capsys.readouterr().out.splitlines()


def test_masks_host_endpoint_and_user_but_never_prints_the_password(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    url = (
        "postgresql://neondb_owner:s3cret@ep-cool-sun-a1b2c3-pooler.eu-central-1.aws.neon.tech"
        "/neondb?sslmode=require"
    )

    lines = _masks(monkeypatch, capsys, url)

    assert lines == [
        "::add-mask::ep-cool-sun-a1b2c3-pooler.eu-central-1.aws.neon.tech",
        "::add-mask::ep-cool-sun-a1b2c3-pooler",
        "::add-mask::ep-cool-sun-a1b2c3",
        "::add-mask::neondb_owner",
    ]
    assert not any("s3cret" in line for line in lines)


def test_nothing_to_mask_without_a_url(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    assert _masks(monkeypatch, capsys, None) == []
    assert _masks(monkeypatch, capsys, "postgresql://localhost/db") == ["::add-mask::localhost"]
