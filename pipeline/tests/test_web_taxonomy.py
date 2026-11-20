"""The web app's copy of the taxonomy (`web/src/lib/taxonomy.json`) equals the pipeline's.

The web app needs the type labels and groups (staples picker, categories) but cannot import
Python. Regenerate the file after a taxonomy change::

    uv run python -c "import json; from foodcatch.matching.taxonomy import PRODUCT_TYPES as T; \\
      print(json.dumps([{'id': t.id, 'label': t.label, 'group': t.group} for t in T], \\
      ensure_ascii=False, indent=2))" > ../web/src/lib/taxonomy.json
"""

from __future__ import annotations

import json
from pathlib import Path

from foodcatch.matching.taxonomy import PRODUCT_TYPES

WEB_TAXONOMY = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "taxonomy.json"


def test_web_taxonomy_matches_the_pipeline() -> None:
    expected = [{"id": t.id, "label": t.label, "group": t.group} for t in PRODUCT_TYPES]
    assert json.loads(WEB_TAXONOMY.read_text(encoding="utf-8")) == expected
