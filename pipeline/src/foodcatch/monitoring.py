"""Monitoring: healthchecks.io dead-man's-switch pings and optional Sentry.

Pings never raise: a monitoring outage must not fail a data collection run.
"""

from __future__ import annotations

from typing import Literal

import httpx
import sentry_sdk

from foodcatch import USER_AGENT
from foodcatch.config import Settings
from foodcatch.logging import get_logger

log = get_logger(__name__)

type PingKind = Literal["start", "success", "fail"]
MAX_PING_BODY_BYTES = 10_000


class Healthchecks:
    """Pings one healthchecks.io check. All methods are no-ops when ``url`` is ``None``."""

    def __init__(
        self,
        url: str | None,
        *,
        run_id: str | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        self.url = url.rstrip("/") if url else None
        self.run_id = run_id
        self._client = client

    @classmethod
    def for_job(cls, settings: Settings, job: str, *, run_id: str | None = None) -> Healthchecks:
        """Pinger configured from ``HEALTHCHECKS_URL_<JOB>``."""
        return cls(settings.healthchecks_url(job), run_id=run_id)

    def start(self) -> None:
        """Signal that the job started (``/start``)."""
        self._ping("start")

    def success(self, message: str = "") -> None:
        """Signal success (base URL)."""
        self._ping("success", message)

    def fail(self, message: str = "") -> None:
        """Signal failure (``/fail``)."""
        self._ping("fail", message)

    def _ping(self, kind: PingKind, message: str = "") -> None:
        if not self.url:
            return
        url = self.url if kind == "success" else f"{self.url}/{kind}"
        params = {"rid": self.run_id} if self.run_id else None
        body = message.encode()[:MAX_PING_BODY_BYTES]
        try:
            if self._client is not None:
                self._client.post(url, params=params, content=body, timeout=10)
            else:
                httpx.post(
                    url,
                    params=params,
                    content=body,
                    timeout=10,
                    headers={"User-Agent": USER_AGENT},
                )
        except httpx.HTTPError as exc:
            log.warning("healthchecks.ping_failed", kind=kind, error=str(exc))


def init_sentry(settings: Settings, *, release: str | None = None) -> bool:
    """Initialize Sentry if ``SENTRY_DSN`` is set. Returns whether Sentry is active."""
    if settings.sentry_dsn is None:
        return False
    sentry_sdk.init(
        dsn=settings.sentry_dsn.get_secret_value(),
        release=release or settings.git_sha,
        traces_sample_rate=0.0,
        send_default_pii=False,
    )
    return True
