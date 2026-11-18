from __future__ import annotations

from pathlib import Path

import pytest

from foodcatch.config import (
    ConfigError,
    Settings,
    find_env_file,
    find_project_root,
    healthchecks_env_key,
    load_settings,
    parse_coordinates,
)


def make_settings(**values: object) -> Settings:
    return Settings(_env_file=None, **values)  # pyright: ignore[reportCallIssue, reportArgumentType]


def test_defaults() -> None:
    s = make_settings()
    assert s.database_url.startswith("postgresql+psycopg://")
    assert s.region_centers == [(55.6761, 12.5683)]
    assert s.region_radius_km == 30
    assert s.db_size_budget_mb == 1024
    assert s.quality_drop_threshold == 0.5
    assert s.salling_api_key is None


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("55.6761,12.5683", [(55.6761, 12.5683)]),
        ("55.1, 12.2 ; 56.15,10.2;", [(55.1, 12.2), (56.15, 10.2)]),
        ("", []),
    ],
)
def test_parse_coordinates(raw: str, expected: list[tuple[float, float]]) -> None:
    assert parse_coordinates(raw) == expected


@pytest.mark.parametrize("raw", ["55.1", "a,b", "95,10", "55,10,3"])
def test_parse_coordinates_rejects_malformed(raw: str) -> None:
    with pytest.raises(ConfigError):
        parse_coordinates(raw)


def test_region_centers_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REGION_CENTERS", "55.1,12.2;56.15,10.2")
    monkeypatch.setenv("REGION_RADIUS_KM", "12.5")
    s = make_settings()
    assert s.region_centers == [(55.1, 12.2), (56.15, 10.2)]
    assert s.region_radius_km == 12.5


def test_empty_optional_values_are_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SALLING_API_KEY", "")
    monkeypatch.setenv("S3_ENDPOINT_URL", " ")
    s = make_settings()
    assert s.salling_api_key is None
    assert s.s3_endpoint_url is None
    with pytest.raises(ConfigError):
        s.require_salling_api_key()


def test_secret_is_not_rendered(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SALLING_API_KEY", "super-secret")
    s = make_settings()
    assert "super-secret" not in repr(s)
    assert s.require_salling_api_key() == "super-secret"


def test_git_sha_from_github(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GITHUB_SHA", "abc123")
    assert make_settings().git_sha == "abc123"


def test_env_file_is_found_upwards_and_loaded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / ".env").write_text(
        "DATABASE_URL=postgresql://u:p@db:5432/x\n"
        "REGION_RADIUS_KM=5\n"
        "HEALTHCHECKS_URL_TJEK_OFFERS=https://hc-ping.com/abc\n"
    )
    nested = tmp_path / "pipeline" / "src"
    nested.mkdir(parents=True)
    monkeypatch.chdir(nested)
    monkeypatch.delenv("FOODCATCH_ENV_FILE")
    assert find_env_file() == tmp_path / ".env"
    assert find_project_root() == tmp_path

    s = load_settings()
    assert s.database_url == "postgresql://u:p@db:5432/x"
    assert s.region_radius_km == 5
    assert s.healthchecks_url("tjek-offers") == "https://hc-ping.com/abc"
    assert s.healthchecks_url("rema-products") is None
    assert s.resolve_path("./data/raw") == tmp_path / "data" / "raw"


def test_environment_wins_over_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env = tmp_path / ".env"
    env.write_text("REGION_RADIUS_KM=5\nHEALTHCHECKS_URL_REMA_PRODUCTS=https://file\n")
    monkeypatch.setenv("REGION_RADIUS_KM", "7")
    monkeypatch.setenv("HEALTHCHECKS_URL_REMA_PRODUCTS", "https://env")
    s = load_settings(env)
    assert s.region_radius_km == 7
    assert s.healthchecks_url("rema-products") == "https://env"


def test_env_file_override_disables_loading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / ".env").write_text("REGION_RADIUS_KM=5\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("FOODCATCH_ENV_FILE", "")
    assert find_env_file() is None
    assert load_settings().region_radius_km == 30


@pytest.mark.parametrize(
    ("job", "key"),
    [
        ("tjek-offers", "HEALTHCHECKS_URL_TJEK_OFFERS"),
        ("salling-food-waste", "HEALTHCHECKS_URL_SALLING_FOOD_WASTE"),
        ("off-enrich", "HEALTHCHECKS_URL_OFF_ENRICH"),
    ],
)
def test_healthchecks_env_key(job: str, key: str) -> None:
    assert healthchecks_env_key(job) == key


def test_invalid_threshold_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("QUALITY_DROP_THRESHOLD", "1.5")
    with pytest.raises(ValueError, match="quality_drop_threshold"):
        make_settings()
