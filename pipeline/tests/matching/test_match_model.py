"""Contract tests of the Match data model against the gold-set representation."""

from __future__ import annotations

from foodcatch.matching import MATCHER_VERSION, Match


def _mørbrad(**attrs: str) -> Match:
    return Match(
        type_id="svinemørbrad",
        type_label="Svinemørbrad",
        group_name="Kød",
        attrs={"øko": "nej", "laktosefri": "nej", **attrs},
        key_attrs=("øko", "laktosefri"),
    )


def test_class_key_matches_gold_format() -> None:
    m = _mørbrad()
    assert m.class_key == "svinemørbrad|øko=nej|laktosefri=nej|forarbejdet=nej"
    assert m.is_exact
    assert m.class_label == "Svinemørbrad"
    assert m.offer_is_homogeneous


def test_unknown_key_attribute_is_inexact() -> None:
    m = Match(
        type_id="mælk",
        type_label="Mælk",
        group_name="Mejeri",
        attrs={"mælketype": "letmælk", "øko": "ja"},
        key_attrs=("mælketype", "øko", "laktosefri"),
    )
    assert m.class_key == "mælk|mælketype=letmælk|øko=ja|laktosefri=?|forarbejdet=nej"
    assert not m.is_exact
    assert m.class_label == "Mælk, letmælk, økologisk, laktosefri?"


def test_processing_and_variants() -> None:
    m = _mørbrad(forarbejdet="marineret")
    m.offer_variants, m.same_class_variants = 3, 1
    assert m.class_key.endswith("forarbejdet=marineret")
    assert m.class_label == "Svinemørbrad, [marineret]"
    assert not m.offer_is_homogeneous


def test_tilsat_vand_label() -> None:
    m = Match(
        type_id="kyllingebryst",
        type_label="Kyllingebryst(filet)",
        group_name="Kød",
        attrs={"tilsat_vand": "nej", "øko": "nej", "laktosefri": "nej"},
        key_attrs=("tilsat_vand", "øko", "laktosefri"),
    )
    assert m.class_label == "Kyllingebryst(filet), uden tilsat vand"


def test_matcher_version_matches_seeded_release() -> None:
    assert MATCHER_VERSION == "2026.11.1"
