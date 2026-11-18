"""Job orchestration: registry, run lifecycle and the registered collection jobs.

Importing this package registers every job: the job modules are imported once, here, so
``foodcatch collect <name>`` and ``foodcatch jobs list`` see them all. A new job module is added
to the import below (the only shared line a new source needs to touch).
"""

from foodcatch.jobs import openfoodfacts, rema, salling, tjek  # registers the jobs
from foodcatch.jobs.context import JobContext, PipelineState
from foodcatch.jobs.registry import (
    JobSpec,
    UnknownJobError,
    get_job,
    list_jobs,
    register_job,
)

__all__ = [
    "JobContext",
    "JobSpec",
    "PipelineState",
    "UnknownJobError",
    "get_job",
    "list_jobs",
    "openfoodfacts",
    "register_job",
    "rema",
    "salling",
    "tjek",
]
