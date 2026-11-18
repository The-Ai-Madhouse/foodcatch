"""Job registry.

A job is a function ``(ctx: JobContext) -> None`` registered under a CLI name::

    @register_job("tjek-offers", source="tjek", description="Tjek catalogs and offers")
    def collect_tjek_offers(ctx: JobContext) -> None: ...

``foodcatch collect <name>`` runs it through :func:`foodcatch.jobs.runner.run_job`.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from foodcatch.jobs.context import JobContext

type JobFunc = Callable[[JobContext], None]


class UnknownJobError(KeyError):
    """Raised when no job is registered under a name."""

    def __str__(self) -> str:
        return f"unknown job {self.args[0]!r}; see `foodcatch jobs list`"


class DuplicateJobError(ValueError):
    """Raised when two jobs register the same name."""


@dataclass(frozen=True, slots=True)
class JobSpec:
    """A registered job.

    Attributes:
        name: CLI name (``salling-food-waste``); also the ``fetch_run.job`` value.
        source: raw-store source name (``fetch_run.source``, ``raw_object.source``).
        func: the job body.
        description: one line for ``foodcatch jobs list``.
        quality_metric: ``fetch_run.stats`` key compared with the previous successful run
            (``None`` disables the drop check). Defaults to ``records``.
        post_fetch: run the post-fetch hooks (classify, deals) after the job body.
    """

    name: str
    source: str
    func: JobFunc
    description: str = ""
    quality_metric: str | None = "records"
    post_fetch: bool = True


_REGISTRY: dict[str, JobSpec] = {}


def register_job(
    name: str,
    *,
    source: str,
    description: str = "",
    quality_metric: str | None = "records",
    post_fetch: bool = True,
) -> Callable[[JobFunc], JobFunc]:
    """Decorator registering a job function under ``name`` (see :class:`JobSpec`)."""

    def decorator(func: JobFunc) -> JobFunc:
        if name in _REGISTRY:
            raise DuplicateJobError(f"job {name!r} is already registered")
        doc_lines = (func.__doc__ or "").strip().splitlines()
        _REGISTRY[name] = JobSpec(
            name=name,
            source=source,
            func=func,
            description=description or (doc_lines[0] if doc_lines else ""),
            quality_metric=quality_metric,
            post_fetch=post_fetch,
        )
        return func

    return decorator


def unregister_job(name: str) -> None:
    """Remove a job (intended for tests)."""
    _REGISTRY.pop(name, None)


def get_job(name: str) -> JobSpec:
    """Return the job registered under ``name``.

    Raises:
        UnknownJobError: if there is none.
    """
    try:
        return _REGISTRY[name]
    except KeyError as exc:
        raise UnknownJobError(name) from exc


def list_jobs() -> list[JobSpec]:
    """All registered jobs sorted by name."""
    return sorted(_REGISTRY.values(), key=lambda spec: spec.name)
