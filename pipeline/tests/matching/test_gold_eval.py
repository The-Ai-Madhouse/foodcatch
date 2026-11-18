"""Gold-set evaluation against Salling's own categories (port of ``poc/eval_matching.py``).

Salling food-waste products carry an EAN and Salling's category. Recognition runs on the
(abbreviated) product **name only** and is compared with the category:

* type recall on staples whose category maps to one of our types,
* wrong type (a different type than the category says) - dangerous,
* wrong key attributes fixed by the category (milk type, cheese form) - dangerous; unknown is
  harmless because it only makes a match inexact,
* false positives: products in certainly-not-staple categories shown as healthy staples.

The thresholds pin the current quality so regressions fail CI. Improve them when the matcher
improves; never loosen them without a reviewed reason.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from foodcatch.matching import classify, is_healthy_staple
from foodcatch.matching.salling_categories import (
    SALLING_CATEGORY_ATTRS,
    SALLING_CATEGORY_MAP,
    SALLING_NON_STAPLE,
    category_leaf,
)
from matching.gold import salling_products

MIN_TYPE_RECALL = 0.76
MAX_WRONG_TYPE = 2
MAX_WRONG_KEY_ATTRIBUTES = 1
MAX_FALSE_POSITIVES = 3


@dataclass
class GoldReport:
    """Results of the evaluation, with examples for failure messages."""

    staple_total: int = 0
    staple_ok: int = 0
    wrong_type: list[tuple[str, str, list[str]]] = field(default_factory=list)
    missed: list[tuple[str, str]] = field(default_factory=list)
    attr_checks: int = 0
    attr_ok: int = 0
    attr_unknown: list[tuple[str, str, str]] = field(default_factory=list)
    attr_wrong: list[tuple[str, str, str]] = field(default_factory=list)
    non_staple_total: int = 0
    false_positives: list[tuple[str, str, list[str]]] = field(default_factory=list)

    @property
    def type_recall(self) -> float:
        return self.staple_ok / self.staple_total


def _evaluate() -> GoldReport:
    report = GoldReport()
    for product in salling_products():
        name = product["name"]
        leaf = category_leaf(product["category"] or "")
        expected = SALLING_CATEGORY_MAP.get(leaf)
        predicted = classify(name)
        predicted_types = {m.type_id for m in predicted}
        if expected:
            report.staple_total += 1
            if expected in predicted_types:
                report.staple_ok += 1
            elif predicted_types:
                report.wrong_type.append((name, leaf, sorted(predicted_types)))
            else:
                report.missed.append((name, leaf))
            for key, want in SALLING_CATEGORY_ATTRS.get(leaf, {}).items():
                got = next((m.attrs.get(key) for m in predicted if m.type_id == expected), None)
                report.attr_checks += 1
                if got == want:
                    report.attr_ok += 1
                elif got is None:
                    report.attr_unknown.append((name, key, want))
                else:
                    report.attr_wrong.append((name, f"{key}={want}", got))
        elif leaf in SALLING_NON_STAPLE:
            report.non_staple_total += 1
            healthy = [m.class_label for m in predicted if is_healthy_staple(m)]
            if healthy:
                report.false_positives.append((name, leaf, healthy))
    return report


@pytest.fixture(scope="module")
def report() -> GoldReport:
    return _evaluate()


def test_gold_set_has_enough_cases(report: GoldReport) -> None:
    assert report.staple_total >= 150
    assert report.attr_checks >= 50
    assert report.non_staple_total >= 50


def test_type_recall(report: GoldReport) -> None:
    assert report.type_recall >= MIN_TYPE_RECALL, report.missed


def test_wrong_type(report: GoldReport) -> None:
    assert len(report.wrong_type) <= MAX_WRONG_TYPE, report.wrong_type


def test_wrong_key_attributes(report: GoldReport) -> None:
    assert len(report.attr_wrong) <= MAX_WRONG_KEY_ATTRIBUTES, report.attr_wrong


def test_false_positives_on_non_staples(report: GoldReport) -> None:
    assert len(report.false_positives) <= MAX_FALSE_POSITIVES, report.false_positives


def test_report_numbers(report: GoldReport) -> None:
    """Print the evaluation (shown with ``pytest -rP``) and check its internal consistency."""
    assert report.staple_ok + len(report.wrong_type) + len(report.missed) == report.staple_total
    assert report.attr_ok + len(report.attr_unknown) + len(report.attr_wrong) == (
        report.attr_checks
    )
    print(  # noqa: T201
        f"staples={report.staple_total} recall={report.type_recall:.3f} "
        f"wrong_type={len(report.wrong_type)} missed={len(report.missed)} "
        f"attr_checks={report.attr_checks} attr_ok={report.attr_ok} "
        f"attr_unknown={len(report.attr_unknown)} attr_wrong={len(report.attr_wrong)} "
        f"false_positives={len(report.false_positives)}/{report.non_staple_total}"
    )
