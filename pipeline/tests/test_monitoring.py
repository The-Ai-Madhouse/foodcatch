from __future__ import annotations

import httpx
import pytest
import respx

from foodcatch.config import Settings
from foodcatch.monitoring import Healthchecks, init_sentry

PING = "https://hc-ping.com/uuid-1"


@respx.mock
def test_pings_start_success_fail_with_run_id() -> None:
    start = respx.post(f"{PING}/start").mock(return_value=httpx.Response(200))
    ok = respx.post(PING).mock(return_value=httpx.Response(200))
    fail = respx.post(f"{PING}/fail").mock(return_value=httpx.Response(200))
    hc = Healthchecks(PING + "/", run_id="r1")
    hc.start()
    hc.success("records=3")
    hc.fail("boom")
    assert start.called
    assert ok.calls.last.request.content == b"records=3"
    assert fail.calls.last.request.url.params["rid"] == "r1"


def test_no_url_is_noop() -> None:
    with respx.mock(assert_all_called=False) as mock:
        hc = Healthchecks(None)
        hc.start()
        hc.success()
        hc.fail()
        assert not mock.calls


@respx.mock
def test_ping_errors_are_swallowed() -> None:
    respx.post(f"{PING}/start").mock(side_effect=httpx.ConnectError("down"))
    Healthchecks(PING).start()


def test_for_job_reads_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HEALTHCHECKS_URL_TJEK_OFFERS", PING)
    hc = Healthchecks.for_job(Settings(_env_file=None), "tjek-offers")  # pyright: ignore[reportCallIssue]
    assert hc.url == PING


def test_sentry_disabled_without_dsn() -> None:
    assert init_sentry(Settings(_env_file=None)) is False  # pyright: ignore[reportCallIssue]
