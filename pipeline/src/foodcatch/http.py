"""Shared HTTP client for all external sources.

:func:`create_client` returns an :class:`httpx.Client` whose transport

* sends the project ``User-Agent`` (architecture §3),
* throttles requests per host (default 4 requests/s, stricter for Nominatim and Open Food Facts),
* retries network errors, HTTP 429 and 5xx responses with exponential backoff (tenacity),
  honouring ``Retry-After``. When retries are exhausted the last response is returned so callers
  decide via ``response.raise_for_status()``; the last network error is re-raised.

Callers never need their own retry loop. Source-specific headers (e.g. the Salling bearer token)
are passed per request so they never end up in stored params.
"""

from __future__ import annotations

import random
import threading
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

import httpx
from tenacity import (
    RetryCallState,
    Retrying,
    retry_if_exception_type,
    stop_after_attempt,
)

from foodcatch import USER_AGENT
from foodcatch.logging import get_logger

log = get_logger(__name__)

DEFAULT_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
DEFAULT_RATE_PER_SECOND = 4.0
HOST_RATES_PER_SECOND: Mapping[str, float] = {
    # Salling sends "Retry-After: 1" on successful responses and answers faster callers with
    # 429 + long penalties (observed 2026-11-18), so stay just under one request per second.
    "api.sallinggroup.com": 0.9,
    "squid-api.tjek.com": 4.0,
    "cphapp.rema1000.dk": 4.0,
    "world.openfoodfacts.org": 1.5,  # documented limit: 100 product reads/minute
    "nominatim.openstreetmap.org": 1.0,  # documented limit: 1 request/second
}
RETRY_STATUS_CODES = frozenset({429, 500, 502, 503, 504})
MAX_RETRY_AFTER_SECONDS = 120.0

type Sleep = Callable[[float], None]
type Clock = Callable[[], float]


class RetryableStatusError(Exception):
    """Internal: a response with a retryable status code (429/5xx)."""

    def __init__(self, request: httpx.Request, response: httpx.Response) -> None:
        super().__init__(f"HTTP {response.status_code} from {request.url.copy_with(query=None)}")
        self.response = response


def parse_retry_after(value: str | None, *, now: datetime | None = None) -> float | None:
    """Parse a ``Retry-After`` header (seconds or HTTP date) into seconds, capped."""
    if not value:
        return None
    value = value.strip()
    try:
        seconds = float(value)
    except ValueError:
        try:
            when = parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        seconds = (when - (now or datetime.now(UTC))).total_seconds()
    return min(max(seconds, 0.0), MAX_RETRY_AFTER_SECONDS)


class HostThrottle:
    """Enforces a minimum interval between requests to the same host (thread-safe)."""

    def __init__(
        self,
        rates: Mapping[str, float] | None = None,
        *,
        default_rate: float = DEFAULT_RATE_PER_SECOND,
        sleep: Sleep = time.sleep,
        clock: Clock = time.monotonic,
    ) -> None:
        self._rates = dict(HOST_RATES_PER_SECOND if rates is None else rates)
        self._default_rate = default_rate
        self._sleep = sleep
        self._clock = clock
        self._next_allowed: dict[str, float] = {}
        self._lock = threading.Lock()

    def interval(self, host: str) -> float:
        """Minimum seconds between two requests to ``host`` (0 = unthrottled)."""
        rate = self._rates.get(host, self._default_rate)
        return 0.0 if rate <= 0 else 1.0 / rate

    def wait(self, host: str) -> None:
        """Block until a request to ``host`` is allowed and reserve the slot."""
        with self._lock:
            now = self._clock()
            start = max(now, self._next_allowed.get(host, now))
            self._next_allowed[host] = start + self.interval(host)
        if start > now:
            self._sleep(start - now)


class RetryingTransport(httpx.BaseTransport):
    """httpx transport adding per-host throttling and retries around an inner transport."""

    def __init__(
        self,
        inner: httpx.BaseTransport | None = None,
        *,
        throttle: HostThrottle | None = None,
        max_attempts: int = 5,
        backoff_initial: float = 1.0,
        backoff_max: float = 60.0,
        sleep: Sleep = time.sleep,
    ) -> None:
        self._inner = inner or httpx.HTTPTransport()
        self._throttle = throttle or HostThrottle(sleep=sleep)
        self._max_attempts = max_attempts
        self._backoff_initial = backoff_initial
        self._backoff_max = backoff_max
        self._sleep = sleep

    def _wait_seconds(self, state: RetryCallState) -> float:
        exc = state.outcome.exception() if state.outcome else None
        if isinstance(exc, RetryableStatusError):
            retry_after = parse_retry_after(exc.response.headers.get("Retry-After"))
            if retry_after is not None:
                return retry_after
        backoff = self._backoff_initial * 2 ** (state.attempt_number - 1)
        return min(backoff, self._backoff_max) + random.uniform(0, self._backoff_initial / 2)  # noqa: S311

    def _before_sleep(self, state: RetryCallState) -> None:
        exc = state.outcome.exception() if state.outcome else None
        log.warning(
            "http.retry",
            attempt=state.attempt_number,
            wait_s=round(state.upcoming_sleep, 2),
            error=str(exc),
        )

    def _send_once(self, request: httpx.Request) -> httpx.Response:
        self._throttle.wait(request.url.host)
        response = self._inner.handle_request(request)
        if response.status_code in RETRY_STATUS_CODES:
            response.read()
            response.close()
            raise RetryableStatusError(request, response)
        return response

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        retrying = Retrying(
            stop=stop_after_attempt(self._max_attempts),
            wait=self._wait_seconds,
            retry=retry_if_exception_type((RetryableStatusError, httpx.TransportError)),
            sleep=self._sleep,
            before_sleep=self._before_sleep,
            reraise=True,
        )
        try:
            return retrying(self._send_once, request)
        except RetryableStatusError as exc:
            # Out of attempts: hand the final response to the caller (raise_for_status decides).
            return exc.response

    def close(self) -> None:
        self._inner.close()


def create_client(
    *,
    base_url: str = "",
    headers: Mapping[str, str] | None = None,
    timeout: httpx.Timeout | float = DEFAULT_TIMEOUT,
    max_attempts: int = 5,
    rates: Mapping[str, float] | None = None,
    transport: httpx.BaseTransport | None = None,
    sleep: Sleep = time.sleep,
) -> httpx.Client:
    """Create the shared HTTP client (see module docstring).

    Args:
        base_url: optional base URL for relative request paths.
        headers: extra default headers (never put secrets here if the client is shared).
        timeout: request timeout.
        max_attempts: total attempts per request including the first.
        rates: per-host requests/second overriding :data:`HOST_RATES_PER_SECOND`.
        transport: inner transport (tests may pass ``httpx.MockTransport``).
        sleep: sleep function (tests pass a no-op).
    """
    merged_rates = {**HOST_RATES_PER_SECOND, **(rates or {})}
    retrying = RetryingTransport(
        transport,
        throttle=HostThrottle(merged_rates, sleep=sleep),
        max_attempts=max_attempts,
        sleep=sleep,
    )
    return httpx.Client(
        base_url=base_url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})},
        timeout=timeout,
        transport=retrying,
        follow_redirects=True,
    )
