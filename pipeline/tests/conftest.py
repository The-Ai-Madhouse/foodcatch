"""Shared pytest fixtures.

Database: one uniquely named database per test session (``foodcatch_test_<hex>``) is created on
the server behind ``TEST_DATABASE_ADMIN_URL`` (default: local docker compose Postgres), migrated
to ``head`` and dropped afterwards, so concurrent sessions never interfere.

* ``database_url`` / ``db_engine`` - session-wide URL and engine of the migrated test database.
* ``db_conn`` - a connection inside a transaction that is rolled back after the test. Code
  under test must not commit (ingest/classify/deals never do).
* ``clean_db`` - the engine for tests that commit (job runner, CLI); data tables are emptied
  and seed rows restored afterwards.
* ``raw_payload`` - factory inserting ``fetch_run`` + ``raw_object`` rows (in ``db_conn``) and
  returning a :class:`~foodcatch.ingest.RawPayload` for ingest tests.
* ``settings`` - hermetic :class:`~foodcatch.config.Settings` (test DB, tmp raw store).
* ``raw_store`` - a :class:`~foodcatch.storage.raw.LocalRawStore` in ``tmp_path``.
* ``http_client`` - the shared HTTP client without real sleeping (use with ``respx``).
* ``load_fixture`` / ``fixture_bytes`` - read files from ``tests/fixtures/`` (JSON / bytes).
* ``shared_fixture`` - read JSON from the repo-root ``fixtures/`` (e.g. ``verdict_cases.json``).
"""

from __future__ import annotations

import ipaddress
import json
import os
import socket
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import Connection, Engine, insert, text

from dbtools import create_database, drop_database
from foodcatch.config import ENV_FILE_OVERRIDE, Settings, get_settings
from foodcatch.db import migrate
from foodcatch.db.engine import make_engine
from foodcatch.db.tables import fetch_run, raw_object
from foodcatch.http import create_client
from foodcatch.ingest import RawPayload
from foodcatch.storage.raw import LocalRawStore, describe, raw_key

TESTS_DIR = Path(__file__).parent
FIXTURES_DIR = TESTS_DIR / "fixtures"
SHARED_FIXTURES_DIR = TESTS_DIR.parent.parent / "fixtures"
INITIAL_MATCHER_VERSION = "2026.11.1"

# Variables that would make tests depend on the developer's environment.
_ISOLATED_PREFIXES = ("HEALTHCHECKS_URL_", "SENTRY_DSN", "SALLING_API_KEY", "S3_", "RAW_STORE_URL")


@pytest.fixture(scope="session", autouse=True)
def _isolate_environment() -> Iterator[None]:
    """Never read the developer's ``.env`` or monitoring/secret variables in tests."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv(ENV_FILE_OVERRIDE, "")
        for key in list(os.environ):
            if key.startswith(_ISOLATED_PREFIXES):
                mp.delenv(key)
        get_settings.cache_clear()
        yield
    get_settings.cache_clear()


class NetworkAccessError(RuntimeError):
    """A test tried to open a real network connection (mock it with respx instead)."""


def _is_local(address: object) -> bool:
    if not isinstance(address, tuple) or not address:
        return True  # AF_UNIX path or similar
    host = str(address[0])  # pyright: ignore[reportUnknownArgumentType]
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


@pytest.fixture(scope="session", autouse=True)
def _block_network() -> Iterator[None]:
    """Fail any test that opens a non-loopback connection: tests never hit real APIs.

    respx and moto intercept requests before a socket is opened, and psycopg connects through
    libpq (not Python sockets), so mocked HTTP, S3 and the test database keep working.
    """
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex

    def check(sock: socket.socket, address: object) -> None:
        if not _is_local(address):
            sock.close()  # the caller never gets a usable socket; avoid a ResourceWarning
            raise NetworkAccessError(f"tests must not use the network (connect to {address!r})")

    def connect(self: socket.socket, address: Any) -> None:
        check(self, address)
        real_connect(self, address)

    def connect_ex(self: socket.socket, address: Any) -> int:
        check(self, address)
        return real_connect_ex(self, address)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(socket.socket, "connect", connect)
        mp.setattr(socket.socket, "connect_ex", connect_ex)
        yield


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    """URL of a fresh, migrated database for this test session."""
    name = f"foodcatch_test_{uuid4().hex[:12]}"
    url = create_database(name)
    try:
        migrate.upgrade(url)
        yield url
    finally:
        drop_database(name)


@pytest.fixture(scope="session")
def db_engine(database_url: str) -> Iterator[Engine]:
    """Engine bound to the session test database."""
    engine = make_engine(database_url)
    yield engine
    engine.dispose()


@pytest.fixture
def db_conn(db_engine: Engine) -> Iterator[Connection]:
    """A connection in a transaction that is rolled back after the test."""
    with db_engine.connect() as conn:
        trans = conn.begin()
        try:
            yield conn
        finally:
            trans.rollback()


_DATA_TABLES = (
    "deal",
    "review_item",
    "classification",
    "classification_override",
    "listing",
    "product_reference_price",
    "product",
    "store",
    "raw_object",
    "fetch_run",
)


@pytest.fixture
def clean_db(db_engine: Engine) -> Iterator[Engine]:
    """The engine for tests that commit; data is wiped (seed rows kept) afterwards."""
    yield db_engine
    with db_engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {', '.join(_DATA_TABLES)} RESTART IDENTITY CASCADE"))
        conn.execute(
            text("DELETE FROM matcher_release WHERE version <> :v"),
            {"v": INITIAL_MATCHER_VERSION},
        )
        conn.execute(
            text("UPDATE matcher_release SET is_current = true WHERE version = :v"),
            {"v": INITIAL_MATCHER_VERSION},
        )


@pytest.fixture
def raw_store(tmp_path: Path) -> LocalRawStore:
    """A local raw store in a temporary directory."""
    return LocalRawStore(tmp_path / "raw")


@pytest.fixture
def settings(database_url: str, tmp_path: Path) -> Settings:
    """Hermetic settings pointing at the test database and a temporary raw store."""
    return Settings(
        _env_file=None,  # pyright: ignore[reportCallIssue]
        database_url=database_url,
        raw_store_url=(tmp_path / "raw").as_uri(),
    )


@pytest.fixture
def http_client() -> Iterator[httpx.Client]:
    """Shared HTTP client that does not really sleep (for respx-mocked tests)."""
    client = create_client(sleep=lambda _seconds: None)
    yield client
    client.close()


type RawPayloadFactory = Callable[..., RawPayload]


@pytest.fixture
def raw_payload(db_conn: Connection) -> RawPayloadFactory:
    """Factory: ``raw_payload(source, endpoint, body, params=None) -> RawPayload``.

    Inserts the ``fetch_run`` and ``raw_object`` rows (inside ``db_conn``'s transaction) so
    ingested rows can reference ``payload.raw_object_id``. ``body`` may be bytes or any
    JSON-serializable value.
    """

    def factory(
        source: str,
        endpoint: str,
        body: bytes | Any,
        params: Mapping[str, Any] | None = None,
    ) -> RawPayload:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        run_id: UUID = uuid4()
        started_at = db_conn.execute(
            insert(fetch_run)
            .values(id=run_id, job=f"test-{source}", source=source, status="running")
            .returning(fetch_run.c.started_at)
        ).scalar_one()
        info = describe(data)
        object_id = uuid4()
        db_conn.execute(
            insert(raw_object).values(
                id=object_id,
                fetch_run_id=run_id,
                source=source,
                endpoint=endpoint,
                params=dict(params or {}),
                storage_key=raw_key(source, endpoint, started_at, run_id, 0),
                sha256=info.sha256,
                bytes=info.bytes,
                fetched_at=started_at,
            )
        )
        return RawPayload(
            raw_object_id=object_id,
            source=source,
            endpoint=endpoint,
            params=dict(params or {}),
            body=data,
            fetched_at=started_at,
        )

    return factory


@pytest.fixture
def fixture_bytes() -> Callable[[str], bytes]:
    """``fixture_bytes("tjek/offers.json")`` -> raw bytes from ``tests/fixtures/``."""
    return lambda name: (FIXTURES_DIR / name).read_bytes()


@pytest.fixture
def load_fixture() -> Callable[[str], Any]:
    """``load_fixture("tjek/offers.json")`` -> parsed JSON from ``tests/fixtures/``."""
    return lambda name: json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


@pytest.fixture
def shared_fixture() -> Callable[[str], Any]:
    """``shared_fixture("verdict_cases.json")`` -> parsed JSON from the repo-root ``fixtures/``."""
    return lambda name: json.loads((SHARED_FIXTURES_DIR / name).read_text(encoding="utf-8"))
