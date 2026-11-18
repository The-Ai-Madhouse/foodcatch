"""Structured logging (structlog).

JSON lines when running in CI (``CI`` env var) or with ``LOG_FORMAT=json``; human-friendly console
output otherwise. Logs go to stderr so stdout stays free for CLI output.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Literal, TextIO, cast

import structlog
from structlog.typing import FilteringBoundLogger, Processor


class _CurrentStderr:
    """File-like object writing to the *current* ``sys.stderr`` (test runners swap it)."""

    def write(self, text: str) -> int:
        return sys.stderr.write(text)

    def flush(self) -> None:
        sys.stderr.flush()


def _use_json(fmt: Literal["auto", "json", "console"]) -> bool:
    if fmt == "auto":
        return bool(os.environ.get("CI")) or not sys.stderr.isatty()
    return fmt == "json"


def configure_logging(
    level: str = "INFO", fmt: Literal["auto", "json", "console"] = "auto"
) -> None:
    """Configure structlog (and the stdlib root logger used by libraries)."""
    numeric_level = logging.getLevelNamesMapping().get(level.upper(), logging.INFO)
    shared: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
    ]
    renderer: Processor
    if _use_json(fmt):
        renderer = structlog.processors.JSONRenderer()
        shared.append(structlog.processors.format_exc_info)
    else:
        renderer = structlog.dev.ConsoleRenderer()
    structlog.configure(
        processors=[*shared, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(numeric_level),
        logger_factory=structlog.PrintLoggerFactory(file=cast(TextIO, _CurrentStderr())),
        cache_logger_on_first_use=False,
    )
    logging.basicConfig(level=max(numeric_level, logging.WARNING), stream=sys.stderr, force=True)


def get_logger(name: str | None = None, **initial: object) -> FilteringBoundLogger:
    """Return a lazily configured structlog logger; ``name`` is added as the ``component`` field.

    Safe to call at import time: configuration is resolved when the logger is used.
    """
    if name:
        initial = {"component": name, **initial}
    logger: FilteringBoundLogger = structlog.get_logger(**initial)
    return logger
