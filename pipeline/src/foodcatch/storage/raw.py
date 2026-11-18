"""Raw store: every external response body, unchanged and gzip-compressed (architecture §4).

Objects are write-once: :meth:`RawStore.put` refuses to overwrite an existing key. Callers pass
and receive the *uncompressed* body; compression is an implementation detail of the store.
:class:`ObjectInfo` describes the uncompressed body (its sha256 and length).

Backends:

* :class:`LocalRawStore` - ``file://<dir>`` (development; relative to the repo root)
* :class:`S3RawStore` - ``s3://<bucket>/<prefix>`` (Backblaze B2 in production)
"""

from __future__ import annotations

import gzip
import hashlib
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Protocol, runtime_checkable
from urllib.parse import urlparse
from uuid import UUID

import boto3
from botocore.exceptions import ClientError

from foodcatch.config import Settings

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client


class RawStoreError(Exception):
    """Base class for raw store errors."""


class RawObjectExistsError(RawStoreError):
    """Raised when writing a key that already exists (raw objects are immutable)."""


class RawObjectNotFoundError(RawStoreError):
    """Raised when reading a key that does not exist."""


@dataclass(frozen=True, slots=True)
class ObjectInfo:
    """Facts about a stored body (uncompressed)."""

    sha256: str
    bytes: int


@dataclass(frozen=True, slots=True)
class StoredObject:
    """A key in the raw store and the time the object was written."""

    key: str
    modified_at: datetime


def raw_key(
    source: str, endpoint: str, fetched_at: datetime, fetch_run_id: UUID | str, seq: int
) -> str:
    """Build the canonical key ``{source}/{endpoint}/{YYYY}/{MM}/{DD}/{run}/{seq:05d}.json.gz``.

    ``endpoint`` may not contain ``/``; use names like ``food-waste`` or ``offers``.
    """
    for name, part in (("source", source), ("endpoint", endpoint)):
        if not part or "/" in part or part in {".", ".."}:
            raise ValueError(f"invalid {name} for raw key: {part!r}")
    if seq < 0:
        raise ValueError("seq must be >= 0")
    return (
        f"{source}/{endpoint}/{fetched_at:%Y}/{fetched_at:%m}/{fetched_at:%d}/"
        f"{fetch_run_id}/{seq:05d}.json.gz"
    )


def compress(body: bytes) -> bytes:
    """Deterministic gzip (mtime 0) so identical bodies give identical objects."""
    return gzip.compress(body, compresslevel=9, mtime=0)


def describe(body: bytes) -> ObjectInfo:
    """Return :class:`ObjectInfo` for an uncompressed body."""
    return ObjectInfo(sha256=hashlib.sha256(body).hexdigest(), bytes=len(body))


def _check_key(key: str) -> str:
    if not key or key.startswith("/") or any(p in {"", ".", ".."} for p in key.split("/")):
        raise ValueError(f"invalid raw key: {key!r}")
    return key


@runtime_checkable
class RawStore(Protocol):
    """Write-once object store for raw payloads."""

    @property
    def url(self) -> str:
        """URL identifying the store location (for logs)."""
        ...

    def put(self, key: str, body: bytes) -> ObjectInfo:
        """Store ``body`` (uncompressed) gzip-compressed under ``key``.

        Raises:
            RawObjectExistsError: if ``key`` already exists.
        """
        ...

    def get(self, key: str) -> bytes:
        """Return the uncompressed body stored under ``key``.

        Raises:
            RawObjectNotFoundError: if ``key`` does not exist.
        """
        ...

    def exists(self, key: str) -> bool:
        """Whether ``key`` exists."""
        ...

    def iter_objects(self, prefix: str = "") -> Iterator[StoredObject]:
        """Every stored object whose key starts with ``prefix``, in key order."""
        ...


class LocalRawStore:
    """Raw store in a local directory."""

    def __init__(self, root: Path) -> None:
        self.root = root

    @property
    def url(self) -> str:
        return self.root.resolve().as_uri()

    def _path(self, key: str) -> Path:
        return self.root / _check_key(key)

    def put(self, key: str, body: bytes) -> ObjectInfo:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open("xb") as fh:  # exclusive create: never overwrite
                fh.write(compress(body))
        except FileExistsError as exc:
            raise RawObjectExistsError(key) from exc
        return describe(body)

    def get(self, key: str) -> bytes:
        try:
            return gzip.decompress(self._path(key).read_bytes())
        except FileNotFoundError as exc:
            raise RawObjectNotFoundError(key) from exc

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def iter_objects(self, prefix: str = "") -> Iterator[StoredObject]:
        if not self.root.is_dir():
            return
        keys = sorted(
            path.relative_to(self.root).as_posix()
            for path in self.root.rglob("*")
            if path.is_file()
        )
        for key in keys:
            if key.startswith(prefix):
                mtime = (self.root / key).stat().st_mtime
                yield StoredObject(key, datetime.fromtimestamp(mtime, tz=UTC))


class S3RawStore:
    """Raw store in an S3-compatible bucket (Backblaze B2 in production)."""

    def __init__(self, client: S3Client, bucket: str, prefix: str = "") -> None:
        self._client = client
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    @classmethod
    def from_settings(cls, bucket: str, prefix: str, settings: Settings) -> S3RawStore:
        """Create a store using ``S3_*`` settings for endpoint, region and credentials."""
        client: S3Client = boto3.client(  # pyright: ignore[reportUnknownMemberType]
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key_id,
            aws_secret_access_key=(
                settings.s3_secret_access_key.get_secret_value()
                if settings.s3_secret_access_key
                else None
            ),
        )
        return cls(client, bucket, prefix)

    @property
    def url(self) -> str:
        return f"s3://{self.bucket}/{self.prefix}" if self.prefix else f"s3://{self.bucket}"

    def _object_key(self, key: str) -> str:
        key = _check_key(key)
        return f"{self.prefix}/{key}" if self.prefix else key

    def put(self, key: str, body: bytes) -> ObjectInfo:
        if self.exists(key):
            raise RawObjectExistsError(key)
        info = describe(body)
        self._client.put_object(
            Bucket=self.bucket,
            Key=self._object_key(key),
            Body=compress(body),
            ContentType="application/json",
            ContentEncoding="gzip",
            Metadata={"sha256": info.sha256, "bytes": str(info.bytes)},
        )
        return info

    def get(self, key: str) -> bytes:
        try:
            obj = self._client.get_object(Bucket=self.bucket, Key=self._object_key(key))
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
                raise RawObjectNotFoundError(key) from exc
            raise
        return gzip.decompress(obj["Body"].read())

    def exists(self, key: str) -> bool:
        try:
            self._client.head_object(Bucket=self.bucket, Key=self._object_key(key))
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise
        return True

    def iter_objects(self, prefix: str = "") -> Iterator[StoredObject]:
        base = f"{self.prefix}/" if self.prefix else ""
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=base + prefix):
            for obj in page.get("Contents", []):
                key = obj.get("Key", "")
                modified = obj.get("LastModified")
                if key.startswith(base) and modified is not None:
                    yield StoredObject(key[len(base) :], modified.astimezone(UTC))


def from_url(url: str, settings: Settings) -> RawStore:
    """Create a raw store from ``RAW_STORE_URL`` (``file://...`` or ``s3://bucket/prefix``).

    Raises:
        ValueError: for unsupported schemes or a missing bucket.
    """
    parsed = urlparse(url)
    if parsed.scheme == "file":
        # file://./data/raw -> netloc "." + path "/data/raw"; file:///abs -> path "/abs"
        raw_path = f"{parsed.netloc}{parsed.path}" if parsed.netloc else parsed.path
        return LocalRawStore(settings.resolve_path(raw_path))
    if parsed.scheme == "s3":
        if not parsed.netloc:
            raise ValueError(f"missing bucket in raw store URL: {url!r}")
        return S3RawStore.from_settings(parsed.netloc, parsed.path, settings)
    raise ValueError(f"unsupported raw store URL scheme: {url!r}")
