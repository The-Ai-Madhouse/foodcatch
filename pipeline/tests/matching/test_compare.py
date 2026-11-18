"""Comparability ("same product") and the healthy-staple filter."""

from __future__ import annotations

import pytest

from foodcatch.matching import Match, classify, comparability, is_healthy_staple
from foodcatch.matching.compare import contains_staple_word


def _one(title: str, description: str = "") -> Match:
    matches = classify(title, description)
    assert len(matches) == 1, matches
    return matches[0]


@pytest.mark.parametrize(
    ("a", "b", "expected"),
    [
        # identical, fully known classes
        ("Hakket oksekød 8-12%", "Hakket oksekød 8-12 % fedt", "same"),
        ("Letmælk 1 l", "Arla letmælk", "same"),
        # unknown key attribute on one side: only similar
        ("Hakket oksekød", "Hakket oksekød 8-12%", "similar"),
        # contradicting key attribute: different products
        ("Hakket oksekød 3-7%", "Hakket oksekød 8-12%", None),
        ("Letmælk", "Sødmælk", None),
        ("Økologisk letmælk", "Letmælk", None),
        # different processing state
        ("Kyllingebryst 900 g", "Marineret kyllingebryst 900 g", None),
        # different type
        ("Letmælk", "Kærnemælk", None),
    ],
)
def test_comparability(a: str, b: str, expected: str | None) -> None:
    ma, mb = _one(a), _one(b)
    assert comparability(ma, mb) == expected
    assert comparability(mb, ma) == expected


def test_same_requires_exact_matches() -> None:
    m = _one("Hakket oksekød")
    assert not m.is_exact
    assert comparability(m, m) == "similar"


def test_healthy_staple_filter() -> None:
    assert is_healthy_staple(_one("Skyr naturel"))
    assert not is_healthy_staple(_one("Skyr jordbær"))
    assert not is_healthy_staple(_one("Marineret kyllingebryst"))
    assert is_healthy_staple(_one("Kyllingebryst 900 g"))


def test_staple_words() -> None:
    assert contains_staple_word("Kyllingevinger")
    assert contains_staple_word("Mammen OST 45+")
    assert not contains_staple_word("Coca-Cola 1,5 l")


def test_poc_aliases() -> None:
    m = _one("Økologisk letmælk")
    assert m.all_keys == m.key_attrs == ("mælketype", "øko", "laktosefri")
    assert m.label() == m.class_label == "Mælk, letmælk, økologisk"


def test_source_hint_and_variants() -> None:
    by_category = classify("ARLA LETMÆLK", category_hint="Mejeri & køl>Mælk>Letmælk")
    assert [m.source_hint for m in by_category] == ["category"]
    mixed = classify("Hakkede eller flåede tomater")
    assert [m.type_id for m in mixed] == ["hakkede_tomater", "flåede_tomater"]
    assert all(m.offer_variants == 2 and not m.offer_is_homogeneous for m in mixed)
