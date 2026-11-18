from __future__ import annotations

import pytest

from foodcatch.jobs import JobContext, get_job, list_jobs, register_job
from foodcatch.jobs.quality import check_record_drop
from foodcatch.jobs.registry import DuplicateJobError, unregister_job

EXPECTED_JOBS = {
    "salling-stores": "salling",
    "salling-food-waste": "salling",
    "tjek-stores": "tjek",
    "tjek-offers": "tjek",
    "rema-products": "rema",
    "off-enrich": "openfoodfacts",
}


def test_all_architecture_jobs_are_registered() -> None:
    assert {spec.name: spec.source for spec in list_jobs()} == EXPECTED_JOBS
    assert all(spec.description for spec in list_jobs())


def test_duplicate_registration_is_rejected() -> None:
    with pytest.raises(DuplicateJobError):

        @register_job("tjek-offers", source="tjek")
        def _dup(ctx: JobContext) -> None: ...


def test_description_defaults_to_docstring() -> None:
    @register_job("doc-job", source="rema")
    def _job(ctx: JobContext) -> None:
        """First line.

        More.
        """

    try:
        assert get_job("doc-job").description == "First line."
    finally:
        unregister_job("doc-job")


@pytest.mark.parametrize(
    ("previous", "current", "metric", "status"),
    [
        ({}, {"records": 0}, "records", "succeeded"),  # first run
        ({"records": 100}, {"records": 50}, "records", "succeeded"),  # exactly 50 %
        ({"records": 100}, {"records": 49}, "records", "degraded"),
        ({"records": 100}, {}, "records", "degraded"),
        ({"records": 0}, {"records": 0}, "records", "succeeded"),
        ({"records": 100}, {"records": 1}, None, "succeeded"),  # metric disabled
    ],
)
def test_check_record_drop(
    previous: dict[str, int], current: dict[str, int], metric: str | None, status: str
) -> None:
    assert check_record_drop(previous, current, metric, 0.5).status == status
