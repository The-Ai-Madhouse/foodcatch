"""FoodCatch data pipeline.

Fetches grocery prices from public sources, stores every response unchanged in the raw store,
normalizes it into Postgres, recognizes products and precomputes deal verdict inputs.
See ``docs/architecture.md`` at the repository root.
"""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("foodcatch")
except PackageNotFoundError:  # pragma: no cover - only when running from a source tree
    __version__ = "0.0.0"

PROJECT_URL = "https://github.com/toke-dk/foodcatch"
USER_AGENT = f"foodcatch/{__version__} (+{PROJECT_URL})"
"""Sent with every external request (architecture §3). Contains no personal data."""

__all__ = ["PROJECT_URL", "USER_AGENT", "__version__"]
