from __future__ import annotations

from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import httpx
import pytest
import respx

from foodcatch import USER_AGENT
from foodcatch.http import (
    NO_RETRY,
    HostThrottle,
    RetryPolicy,
    create_client,
    parse_retry_after,
    retry_extensions,
)

URL = "https://api.example.test/items"


class FakeClock:
    """Monotonic clock advanced only by the fake sleep."""

    def __init__(self) -> None:
        self.now = 100.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture
def sleeps() -> list[float]:
    return []


@pytest.fixture
def client(sleeps: list[float]) -> httpx.Client:
    # Unthrottled host so only retry waits are recorded.
    return create_client(sleep=sleeps.append, rates={"api.example.test": 0})


@respx.mock
def test_sends_user_agent(client: httpx.Client) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(200, json={}))
    client.get(URL)
    assert route.calls.last.request.headers["User-Agent"] == USER_AGENT
    assert USER_AGENT.startswith("foodcatch/")
    assert "github.com/toke-dk/foodcatch" in USER_AGENT


@respx.mock
def test_retries_server_errors_then_succeeds(client: httpx.Client, sleeps: list[float]) -> None:
    route = respx.get(URL).mock(
        side_effect=[httpx.Response(503), httpx.Response(502), httpx.Response(200, json={"ok": 1})]
    )
    response = client.get(URL)
    assert response.status_code == 200
    assert response.json() == {"ok": 1}
    assert route.call_count == 3
    assert len(sleeps) == 2
    assert sleeps[1] > sleeps[0]  # exponential backoff


@respx.mock
def test_honours_retry_after_seconds(client: httpx.Client, sleeps: list[float]) -> None:
    respx.get(URL).mock(
        side_effect=[httpx.Response(429, headers={"Retry-After": "7"}), httpx.Response(200)]
    )
    assert client.get(URL).status_code == 200
    assert sleeps == [7.0]


@respx.mock
def test_returns_last_response_when_retries_exhausted(sleeps: list[float]) -> None:
    client = create_client(sleep=sleeps.append, max_attempts=3, rates={"api.example.test": 0})
    route = respx.get(URL).mock(return_value=httpx.Response(500, text="boom"))
    response = client.get(URL)
    assert response.status_code == 500
    assert route.call_count == 3
    with pytest.raises(httpx.HTTPStatusError):
        response.raise_for_status()


@respx.mock
def test_does_not_retry_client_errors(client: httpx.Client) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(404))
    assert client.get(URL).status_code == 404
    assert route.call_count == 1


@respx.mock
def test_retries_network_errors_and_reraises(sleeps: list[float]) -> None:
    client = create_client(sleep=sleeps.append, max_attempts=2, rates={"api.example.test": 0})
    route = respx.get(URL).mock(side_effect=httpx.ConnectError("down"))
    with pytest.raises(httpx.ConnectError):
        client.get(URL)
    assert route.call_count == 2


@respx.mock
def test_recovers_from_network_error(client: httpx.Client) -> None:
    respx.get(URL).mock(side_effect=[httpx.ReadTimeout("slow"), httpx.Response(200)])
    assert client.get(URL).status_code == 200


def test_parse_retry_after() -> None:
    now = datetime(2026, 11, 18, 12, 0, tzinfo=UTC)
    assert parse_retry_after("3") == 3.0
    assert parse_retry_after(format_datetime(now + timedelta(seconds=30)), now=now) == 30.0
    assert parse_retry_after(format_datetime(now - timedelta(seconds=30)), now=now) == 0.0
    assert parse_retry_after("100000") == 120.0  # capped
    assert parse_retry_after("soon") is None
    assert parse_retry_after(None) is None


def test_throttle_spaces_requests_per_host() -> None:
    clock = FakeClock()
    throttle = HostThrottle({"slow.test": 2.0}, default_rate=4.0, sleep=clock.sleep, clock=clock)
    for _ in range(3):
        throttle.wait("slow.test")
    assert clock.sleeps == [0.5, 0.5]
    throttle.wait("other.test")  # independent host, default rate, first request is free
    throttle.wait("other.test")
    assert clock.sleeps == [0.5, 0.5, 0.25]


def test_throttle_does_not_sleep_when_requests_are_far_apart() -> None:
    clock = FakeClock()
    throttle = HostThrottle({"h": 1.0}, sleep=clock.sleep, clock=clock)
    throttle.wait("h")
    clock.now += 5
    throttle.wait("h")
    assert clock.sleeps == []


@respx.mock
def test_client_throttles_known_hosts(sleeps: list[float]) -> None:
    client = create_client(sleep=sleeps.append)
    respx.get("https://nominatim.openstreetmap.org/search").mock(return_value=httpx.Response(200))
    client.get("https://nominatim.openstreetmap.org/search")
    client.get("https://nominatim.openstreetmap.org/search")
    assert len(sleeps) == 1
    assert 0.9 < sleeps[0] <= 1.0


# --------------------------------------------------------------------------- per-request policy


@respx.mock
def test_no_retry_policy_returns_429_at_once(client: httpx.Client, sleeps: list[float]) -> None:
    route = respx.get(URL).mock(
        return_value=httpx.Response(429, headers={"Retry-After": "3600"}, text="slow down")
    )
    response = client.get(URL, extensions=retry_extensions(NO_RETRY))
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "3600"
    assert response.text == "slow down"
    assert route.call_count == 1
    assert sleeps == []  # never slept out


@respx.mock
def test_no_retry_policy_reraises_network_errors_at_once(client: httpx.Client) -> None:
    route = respx.get(URL).mock(side_effect=httpx.ConnectError("down"))
    with pytest.raises(httpx.ConnectError):
        client.get(URL, extensions=retry_extensions(NO_RETRY))
    assert route.call_count == 1


@respx.mock
def test_policy_can_retry_server_errors_but_not_429(
    client: httpx.Client, sleeps: list[float]
) -> None:
    policy = RetryPolicy(retry_statuses=frozenset({500, 502, 503, 504}))
    route = respx.get(URL).mock(
        side_effect=[httpx.Response(503), httpx.Response(429), httpx.Response(200)]
    )
    response = client.get(URL, extensions=retry_extensions(policy))
    assert response.status_code == 429
    assert route.call_count == 2
    assert len(sleeps) == 1


@respx.mock
def test_requests_without_policy_keep_the_defaults(
    client: httpx.Client, sleeps: list[float]
) -> None:
    route = respx.get(URL).mock(
        side_effect=[httpx.Response(429, headers={"Retry-After": "2"}), httpx.Response(200)]
    )
    assert client.get(URL, extensions=retry_extensions(None)).status_code == 200
    assert route.call_count == 2
    assert sleeps == [2.0]
