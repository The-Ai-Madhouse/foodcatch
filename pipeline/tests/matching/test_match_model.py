"""Contract tests of the Match data model against the gold-set representation."""

from __future__ import annotations

import pytest

from foodcatch.matching import MATCHER_VERSION, Match, classify


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


def test_matcher_version_is_pinned() -> None:
    """Bump deliberately (and update this pin) on every behaviour change of the matcher.

    2026.11.1 is the release seeded by migration 0001; the post-fetch hook promotes newer ones.
    2026.11.2: pork tenderloin/chops no longer match cuts of other animals.
    """
    assert MATCHER_VERSION == "2026.11.2"


@pytest.mark.parametrize(
    "title",
    [
        "Kalvemørbrad",
        "Oksemørbrad",
        "Lammemørbrad",
        "Mørbrad af kalv",
        "Kalkunmørbrad",
        "Kyllingemørbrad",
        "Hjortemørbrad",
        "Vildsvinemørbrad",
        "Andemørbrad",
        "Koteletter af lam",
        "Lamme koteletter",
        "Kalve koteletter",
    ],
)
def test_cuts_of_other_animals_are_not_pork(title: str) -> None:
    """Regression (finding C3): a veal or lamb cut must not become a pork reference."""
    assert [m.type_id for m in classify(title)] == []


@pytest.mark.parametrize(
    ("title", "type_id"),
    [
        ("Mørbrad af dansk gris", "svinemørbrad"),
        ("Grisemørbrad", "svinemørbrad"),
        ("Dansk svinemørbrad", "svinemørbrad"),
        ("Flammegrillet mørbrad", "svinemørbrad"),
        ("Danske koteletter", "svinekoteletter"),
        ("Svinekoteletter med ben", "svinekoteletter"),
    ],
)
def test_pork_cuts_are_still_recognized(title: str, type_id: str) -> None:
    assert [m.type_id for m in classify(title)] == [type_id]
