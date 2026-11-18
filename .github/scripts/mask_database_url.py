"""Mask the parts of $DATABASE_URL that error messages print in GitHub Actions logs.

GitHub masks a secret only as a whole. libpq/psycopg errors print the host name
("host: 'ep-xxx.eu-central-1.aws.neon.tech'") and the user ('user "neondb_owner"'), so a failed
connection would reveal them in the public logs of this repository. This prints an
`::add-mask::` workflow command for the host, the endpoint id (with and without Neon's
`-pooler` suffix) and the user; masks apply to every later step of the job.

Usage (in a step with DATABASE_URL in its environment): python3 .github/scripts/mask_database_url.py
"""

from __future__ import annotations

import os
import sys
from urllib.parse import unquote, urlsplit


def mask_values(url: str) -> list[str]:
    """The values to mask for ``url`` (longest first, no empties or duplicates)."""
    if not url:
        return []
    parts = urlsplit(url)
    host = parts.hostname or ""
    endpoint = host.split(".", 1)[0] if "." in host else ""
    values = {host, endpoint, endpoint.removesuffix("-pooler"), unquote(parts.username or "")}
    return sorted((v for v in values if len(v) >= 3), key=lambda v: (-len(v), v))


def main() -> int:
    for value in mask_values(os.environ.get("DATABASE_URL", "")):
        sys.stdout.write(f"::add-mask::{value}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
