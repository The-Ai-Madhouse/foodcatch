from __future__ import annotations

import gzip
import hashlib
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import UUID

import boto3
import pytest
from moto import mock_aws

from foodcatch.config import Settings
from foodcatch.storage.raw import (
    LocalRawStore,
    RawObjectExistsError,
    RawObjectNotFoundError,
    RawStore,
    S3RawStore,
    from_url,
    raw_key,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

    from mypy_boto3_s3 import S3Client

BODY = '{"name": "Hakket oksekød 8-12%", "price": 39.95}'.encode()
RUN = UUID("12345678-1234-5678-1234-567812345678")


def test_raw_key_layout() -> None:
    key = raw_key("tjek", "offers", datetime(2026, 1, 2, 3, 4, tzinfo=UTC), RUN, 7)
    assert key == f"tjek/offers/2026/01/02/{RUN}/00007.json.gz"


@pytest.mark.parametrize(
    ("source", "endpoint"), [("", "x"), ("a/b", "x"), ("tjek", ".."), ("s", "")]
)
def test_raw_key_rejects_bad_segments(source: str, endpoint: str) -> None:
    with pytest.raises(ValueError, match="invalid"):
        raw_key(source, endpoint, datetime(2026, 1, 1, tzinfo=UTC), RUN, 0)


def _exercise(store: RawStore) -> None:
    key = "tjek/offers/2026/01/02/run/00000.json.gz"
    assert not store.exists(key)
    info = store.put(key, BODY)
    assert info.sha256 == hashlib.sha256(BODY).hexdigest()
    assert info.bytes == len(BODY)
    assert store.exists(key)
    assert store.get(key) == BODY
    with pytest.raises(RawObjectExistsError):
        store.put(key, b"{}")
    assert store.get(key) == BODY  # unchanged
    with pytest.raises(RawObjectNotFoundError):
        store.get("tjek/offers/missing.json.gz")


def test_local_store_roundtrip_and_gzip(tmp_path: Path) -> None:
    store = LocalRawStore(tmp_path)
    _exercise(store)
    stored = (tmp_path / "tjek/offers/2026/01/02/run/00000.json.gz").read_bytes()
    assert gzip.decompress(stored) == BODY
    assert isinstance(store, RawStore)


def test_local_store_compression_is_deterministic(tmp_path: Path) -> None:
    a, b = LocalRawStore(tmp_path / "a"), LocalRawStore(tmp_path / "b")
    a.put("x/y.json.gz", BODY)
    b.put("x/y.json.gz", BODY)
    assert (tmp_path / "a/x/y.json.gz").read_bytes() == (tmp_path / "b/x/y.json.gz").read_bytes()


@pytest.mark.parametrize("key", ["../escape.json.gz", "/abs.json.gz", "a//b", "a/./b"])
def test_local_store_rejects_unsafe_keys(tmp_path: Path, key: str) -> None:
    with pytest.raises(ValueError, match="invalid raw key"):
        LocalRawStore(tmp_path).put(key, BODY)


@pytest.fixture
def s3_client() -> Iterator[S3Client]:
    with mock_aws():
        client: S3Client = boto3.client("s3", region_name="us-east-1")  # pyright: ignore[reportUnknownMemberType]
        client.create_bucket(Bucket="foodcatch-raw")
        yield client


def test_s3_store_roundtrip(s3_client: S3Client) -> None:
    store = S3RawStore(s3_client, "foodcatch-raw", "/raw/")
    _exercise(store)
    obj = s3_client.get_object(
        Bucket="foodcatch-raw", Key="raw/tjek/offers/2026/01/02/run/00000.json.gz"
    )
    assert obj["ContentEncoding"] == "gzip"
    assert obj["Metadata"]["sha256"] == hashlib.sha256(BODY).hexdigest()
    assert gzip.decompress(obj["Body"].read()) == BODY
    assert store.url == "s3://foodcatch-raw/raw"


def test_from_url_file_relative_to_project_root(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("")
    settings = Settings(_env_file=None, env_file_path=env)  # pyright: ignore[reportCallIssue]
    store = from_url("file://./data/raw", settings)
    assert isinstance(store, LocalRawStore)
    assert store.root == tmp_path / "data" / "raw"
    absolute = from_url((tmp_path / "abs").as_uri(), settings)
    assert isinstance(absolute, LocalRawStore)
    assert absolute.root == tmp_path / "abs"


def test_from_url_s3_uses_settings(s3_client: S3Client) -> None:
    settings = Settings(
        _env_file=None,  # pyright: ignore[reportCallIssue]
        s3_access_key_id="testing",
        s3_secret_access_key="testing",  # pyright: ignore[reportArgumentType]
        s3_region="us-east-1",
    )
    store = from_url("s3://foodcatch-raw/raw", settings)
    assert isinstance(store, S3RawStore)
    assert store.bucket == "foodcatch-raw"
    assert store.prefix == "raw"
    store.put("a/b.json.gz", BODY)
    assert s3_client.head_object(Bucket="foodcatch-raw", Key="raw/a/b.json.gz")


@pytest.mark.parametrize("url", ["http://x/y", "s3:///nobucket", "ftp://x"])
def test_from_url_rejects_unsupported(url: str) -> None:
    with pytest.raises(ValueError, match="raw store URL"):
        from_url(url, Settings(_env_file=None))  # pyright: ignore[reportCallIssue]
