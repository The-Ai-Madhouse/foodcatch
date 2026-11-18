"""
Varegenkendelse for FoodCatch.

To lag:
  1. Genkendelse: tekst (+ evt. kildens kategori) -> én eller flere `Match`
     med varetype og prisrelevante egenskaber (fedt %, øko, laktosefri, ...).
  2. Sammenlignelighed: to matches er kun "samme vare" hvis typen og ALLE
     typens nøgle-egenskaber er kendte og ens. Ukendte egenskaber giver højst
     "lignende vare" og må ikke bruges til at kalde noget et godt køb.

Sundhedsfilteret (`is_healthy_staple`) er bevidst adskilt fra genkendelsen:
en marineret kyllingebryst genkendes stadig som kyllingebryst, men med
egenskaben forarbejdet=marineret, og bliver derfor hverken sammenlignet med
naturel kyllingebryst eller vist som sund basisvare.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Normalisering (forkortelser fra bl.a. Salling madspild: "KYL.BRYST", "HK.")
# ---------------------------------------------------------------------------
_ABBREV = [
    (r"\bkyl\.\s*", "kylling"),
    (r"\bhk\.?\s+", "hakket "),
    (r"\bmadl\.\s*", "madlavnings"),
    (r"\bmar\.\s*", "marineret "),
    (r"\bpan\.\s*", "paneret "),
    (r"\bkot\.", "koteletter"),
    (r"\bched\.", "cheddar"),
    (r"\brev\.?\s+", "revet "),
    (r"\bøko\.?\s+", "økologisk "),
    (r"\bøko$", "økologisk"),
    (r"\bml\s+(\d\d\+)", r"mellemlagret \1"),
    (r"\bcreme f\b", "creme fraiche"),
    (r"crème", "creme"),
    (r"fraîche", "fraiche"),
    (r"’", "'"),
    (r"\bm\.\s*", "med "),
    (r"\bm/\s*", "med "),
    (r"\bsandw(i)?\.", "sandwich"),
]


def normalize(text: str) -> str:
    t = " " + text.lower().replace("\n", " ") + " "
    for pat, rep in _ABBREV:
        t = re.sub(pat, rep, t)
    return re.sub(r"\s+", " ", t).strip()


# ---------------------------------------------------------------------------
# Varetyper. Rækkefølgen betyder noget: specifikke typer før generelle.
# key: egenskaber der skal være kendte og ens for at to varer er "samme vare".
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class VareType:
    id: str
    label: str
    group: str
    include: str
    exclude: str = r"(?!x)x"  # matcher aldrig
    key: tuple[str, ...] = ()
    unit: str = "kg"


_FLAVOURS_RAW = (r"jordbær|blåbær|hindbær|kirsebær|vanilje|mango|passion|banan|fersken|ananas|æble|rabarber|"
             r"citron|lemon|skovbær|hyldeblomst|kokos|müsli|granola|honning|karamel|stracciatella|frugt|"
             r"smag|bær\b|pære|abrikos|mynte|kaffe|choko|appelsin|melba|peach|lime|tropisk|multifrugt|blåbær|solbær")
_FLAVOURS = _FLAVOURS_RAW

# Mærker der kun laver færdigretter/convenience (gælder alle typer)
_CONVENIENCE_BRANDS = r"godt begyndt|\bgb\b|næmt|salling nu|\bnu\b$"
# Mærker der (i køledisken) kun laver pålæg. Gælder kun kødtyper.
_COLD_CUT_BRANDS = (r"pålækker|3[- ]?stjernet|\bminimum\b|d\.?g\.? slagter|\bbudget\b|gøl\b|tulip|steff houlberg|"
                    r"pålægsslagteren|defco|egelykke|\b1h\b")

# "45+" er kun ost-fedt i ost-kontekst (ikke "45+ lyde", "Livol 50+", "12+ kg")
_CHEESE_FAT = (r"\b(13|20|30|40|45|50|60)\+\s*(ml\b|mk\b|mild|mellemlagret|lagret|ekstra|ost|kommen|skiver)|"
               r"(mild|mellemlagret|lagret|\bml|ekstralagret)\s*(13|20|30|40|45|50|60)\+")

TYPES: list[VareType] = [
    # ---------------- Kød ----------------
    VareType("hakket_gris_kalv", "Hakket grise- og kalvekød", "Kød",
             r"(hakket|fars).{0,12}gris[e]?[- ]*(og|&|/)\s*kalv|gris[e]?\s*(&|/|og)\s*kalv", key=("fedt",)),
    VareType("hakket_okse_gris", "Hakket okse- og grisekød", "Kød",
             r"okse-?\s*(og|&|/)\s*grise?|grise-?\s*(og|&|/)\s*okse", key=("fedt",)),
    VareType("hakket_oksekød", "Hakket oksekød", "Kød",
             r"hakket( \w+){0,2} (oksekød|kødkvæg)|hakket okse\b|oksefars",
             exclude=r"grøn|grøntsager|okse/grøn|okse-?\s*(og|&)\s*gris", key=("fedt",)),
    VareType("hakket_grisekød", "Hakket grisekød", "Kød",
             r"hakket( \w+){0,2} (grise|svine)kød|hakket gris\b|grisefars|svinefars|gris.{0,12}hakkekød|hakkekød.{0,12}gris", key=("fedt",)),
    VareType("hakket_kylling", "Hakket kylling", "Kød",
             r"hakket( \w+){0,2} kylling|kyllingefars", key=("fedt",)),
    VareType("hakket_kalkun", "Hakket kalkun", "Kød", r"hakket kalkun", key=("fedt",)),
    VareType("kyllingeinderfilet", "Kyllingeinderfilet", "Kød",
             r"kyllinge?\s*-?\s*inderfilet|inderfilet af kylling", key=("tilsat_vand",)),
    VareType("kyllingebryst", "Kyllingebryst(filet)", "Kød",
             r"kyllinge?\s*-?\s*bryst|kyllingfilet|kyllingefilet", key=("tilsat_vand",)),
    VareType("kyllingelår", "Kyllingelår", "Kød",
             r"kyllinge?\s*-?\s*(under|over|hele\s*)?lår|kylling hele lår|(under|over)lår", key=("udskæring",)),
    VareType("hel_kylling", "Hel kylling", "Kød", r"hel(e)? kylling|helkylling"),
    VareType("svinekoteletter", "Svinekoteletter", "Kød", r"\bkoteletter|svinekotelet"),
    VareType("svinemørbrad", "Svinemørbrad", "Kød", r"(svine|grise)?mørbrad", exclude=r"a ?la|ala\b|bøffer"),
    # ---------------- Æg ----------------
    VareType("æg", "Æg", "Æg",
             r"(^|\W)æg(\W|$)|skrabeæg|frilandsæg|buræg|økologiske æg",
             exclude=r"påske|chokolade|kinder|overrask|dino|ægge(salat|nudler)|nudler|pasta|æggehvide|smadr|spejle|spil\b|æggeur",
             key=("produktion",), unit="stk"),
    # ---------------- Mejeri ----------------
    VareType("kærnemælk", "Kærnemælk", "Mejeri", r"kærnemælk", key=("øko",), unit="l"),
    VareType("mælk", "Mælk", "Mejeri",
             r"skummetmælk|minimælk|letmælk|sødmælk|jerseymælk|(^|\W)mælk(\W|$)",
             exclude=r"kakao|choko|kaffe|barista|havre|mandel|soja|ris(drik|mælk)|mælkesnitte|mælkechokolade|kondens|drikke|protein|brød|kiks|nød|ritter|med (" + _FLAVOURS_RAW + ")",
             key=("mælketype", "øko", "laktosefri"), unit="l"),
    VareType("piskefløde", "Piskefløde", "Mejeri", r"piskefløde|fløde 3[68]\s*%|pisk\.?\s*fløde",
             exclude=r"cremefine|plante|piskbar", key=("øko", "laktosefri"), unit="l"),
    VareType("madlavningsfløde", "Madlavningsfløde", "Mejeri", r"madlavningsfløde|madfløde|kogefløde",
             exclude=r"jævner|cremefine", key=("fedt",), unit="l"),
    VareType("creme_fraiche", "Creme fraiche", "Mejeri", r"creme ?fraiche|cremefraiche|fraiche",
             exclude=r"plante|frisk", key=("fedt",)),
    VareType("smørbar", "Smørbar (blandingsprodukt)", "Mejeri", r"smørbar|smørbart|blandingsprodukt|smør\s*(&|og)\s*(raps|olie)|kærgården",
             exclude=r"plante", key=("øko",)),
    VareType("smør", "Smør", "Mejeri", r"(^|\W)smør(\W|$)",
             exclude=r"jordnødde|peanut|smørrebrød|smørbagt|smørcroissant|hvidløg|kryddersmør|plante|citron", key=("øko",)),
    VareType("hytteost", "Hytteost", "Mejeri", r"hytteost", exclude=r"salat|frugt"),
    VareType("mozzarella", "Mozzarella", "Mejeri", r"mozzarella", exclude=r"revet|stick|panere", key=("øko",)),
    VareType("feta", "Feta/salatost", "Mejeri", r"\bfeta\b|salatost", exclude=r"oliven|peber|tapas"),
    VareType("fast_ost", "Fast ost", "Mejeri",
             r"skæreost|skiveost|danbo|havarti|samsø|gouda|cheddar|revet ost|ost i skiver|" + _CHEESE_FAT + "|"
             r"revet (mozzarella|pizzaost|emmentaler)",
             exclude=r"smøreost|flødeost|ostehaps|hapser|snack|ostepops|ostestænger|kage|pizza|kiks|chips|dipper|cubes|"
                     r"grillost|brie|camembert|skimmel|gedeost|parmesan|peber|oliven|peppadew|pesto|"
                     r"kartof|agurk|gulerod|salat\b|grøntsag|kål\b",
             key=("form",)),
    VareType("skyr", "Skyr", "Mejeri", r"skyr", exclude=r"drikke|drik\b|bar\b|is\b", key=("smag",)),
    VareType("græsk_yoghurt", "Græsk yoghurt", "Mejeri", r"græsk(-inspireret)? yoghurt", key=("smag",)),
    VareType("a38_ymer", "A38/ymer/tykmælk", "Mejeri", r"\ba38\b|\bymer\b|tykmælk", key=("smag",)),
    VareType("yoghurt", "Yoghurt", "Mejeri", r"yoghurt",
             exclude=r"drik|actimel|kefir|plante|gurt\b|bar\b|is\b|frossen", key=("smag", "fedt")),
    # ---------------- Kolonial ----------------
    VareType("hakkede_tomater", "Hakkede tomater (dåse)", "Kolonial",
             r"(fint?)?hakkede tomater|polpa|tomater.{0,10}hakkede|hakkede.{0,10}tomater"),
    VareType("flåede_tomater", "Flåede tomater (dåse)", "Kolonial", r"flåede tomater|pelati|hele flåede"),
    VareType("passata", "Passata", "Kolonial", r"passata|tomatpassata"),
    VareType("tomatpuré", "Tomatpuré", "Kolonial", r"tomatpur[eé]|tomatkoncentrat", exclude=r"ketchup"),
    VareType("kikærter", "Kikærter", "Kolonial", r"kikærter", exclude=r"snack|chips|ristede|hummus", key=("form",)),
    VareType("kidneybønner", "Kidneybønner", "Kolonial", r"kidney", key=("form",)),
    VareType("sorte_bønner", "Sorte bønner", "Kolonial", r"sorte bønner", key=("form",)),
    VareType("hvide_bønner", "Hvide bønner", "Kolonial", r"hvide bønner|butter\s*beans|cannellini|borlotti",
             exclude=r"tomat|baked", key=("form",)),
    VareType("linser", "Linser", "Kolonial", r"linser", exclude=r"chips|snack|pasta|kontakt", key=("form",)),
    VareType("tun", "Tun (dåse)", "Kolonial", r"(^|\W)tun(\W|$)|tunfisk|yellowfin",
             exclude=r"salat|mousse|tunge|tunnel", key=("medium",)),
    VareType("havregryn", "Havregryn", "Kolonial", r"havregryn|grovvalsede|finvalsede",
             exclude=r"kugler|bar\b|cookies|granola|müsli|drik|kiks", key=("øko",)),
]
TYPE_BY_ID = {t.id: t for t in TYPES}

# Mærker der IKKE er en varetype men indikerer forarbejdning -> egenskab "forarbejdet"
_PROCESSED = [
    ("marineret", r"marineret|marinade|\bbbq\b|krydret|med (citron|rosmarin|urter|hvidløg|timian|chili)|\bchili\b|teriyaki|tandoori|"
                  r"med (peber|paprika|karry|krydder|gyros|ramsløg|pesto)|ramsløg|gyros"),
    ("paneret", r"paneret|panko|nugget|schnitzel|cordon"),
    ("tilberedt", r"stegt|grillet|røget|pulled|kogt skinke|sous vide|færdigret|gryde|kebab|spyd|sandwich|panini|wrap|"
                  r"gratin|godt begyndt|næmt|salling nu|med (kartofler|ris|sauce|svampe)|a ?la creme|salat\b|\bi tern\b"),
    ("pålæg", r"pålæg|postej|salami|\bskiver\b.*(kylling|kalkun)|kyllingepålæg|topping"),
    ("pølse/fars", r"pølse|medister|frikadelle|burger|cevapcici|kødboller"),
    ("i sauce", r"i (tomat)?sauce|baked beans|chili sin carne|i tomat\b|bønnemos"),
    ("snack/dessert", r"\bsnack|dessert|\bis\b|kage|chips|slik|chokolade|drik\b|drikke"),
]




# ---------------------------------------------------------------------------
# Egenskaber
# ---------------------------------------------------------------------------
_NUM = r"(\d+(?:[.,]\d+)?)"


def fat_ranges(text: str) -> list[tuple[float, float]]:
    """Alle fedt-angivelser i teksten som (lav, høj) i %."""
    t = text.lower()
    out: list[tuple[float, float]] = []
    for m in re.finditer(rf"{_NUM}\s*-\s*{_NUM}\s*%", t):
        out.append((float(m[1].replace(",", ".")), float(m[2].replace(",", "."))))
    for m in re.finditer(rf"max\.?\s*{_NUM}\s*%", t):
        hi = float(m[1].replace(",", "."))
        out.append((max(0.0, hi - 4), hi))
    if not out:
        for m in re.finditer(rf"(?<![\d,.\-]){_NUM}\s*%", t):
            v = float(m[1].replace(",", "."))
            out.append((v, v))
    return out


def fat_bucket(type_id: str, rng: tuple[float, float]) -> str:
    lo, hi = rng
    mid = (lo + hi) / 2
    if type_id.startswith("hakket_"):
        if mid < 7.5:
            return "≤7%"
        if mid < 12.5:
            return "8-12%"
        if mid <= 20:
            return "13-20%"
        return ">20%"
    if type_id == "madlavningsfløde":
        return "≤10%" if mid <= 10 else "11-20%"
    if type_id == "creme_fraiche":
        return "≤9%" if mid <= 9 else ("18%" if mid <= 20 else "38%")
    if type_id == "yoghurt":
        return "≤1%" if mid <= 1 else ("1,5-3,5%" if mid <= 4 else ">4%")
    return f"{lo:g}-{hi:g}%"


def extract_attrs(type_id: str, t: str, extra: str, whole: str = "") -> dict[str, str]:
    """Udtræk egenskaber.

    t:     variantens egen tekst
    extra: fx beskrivelse (gælder kun hvis tilbuddet har én variant)
    whole: hele overskriften – mærker (pålæg/færdigret) gælder alle varianter
    """
    whole = whole or t
    both = f"{t} {extra}"
    a: dict[str, str] = {}

    # "Økologiske hakkede eller flåede tomater": gælder øko også for de flåede? Ukendt -> "?"
    for key, pat in (("øko", r"økologisk|\bøko\b|\bøgo\b|änglamark|salling øko|naturmælk"),
                     ("laktosefri", r"laktosefri|lactofree|\blf\b")):
        if re.search(pat, both):
            a[key] = "ja"
        elif re.search(pat, whole):
            a[key] = "?"
        else:
            a[key] = "nej"

    # forarbejdning: variantens tekst + beskrivelsen (kun når den gælder entydigt)
    proc = [name for name, pat in _PROCESSED if re.search(pat, t) or (extra and re.search(pat, extra))]
    if re.search(_CONVENIENCE_BRANDS, f"{whole} {extra}") and "tilberedt" not in proc:
        proc.append("tilberedt")
    is_meat = TYPE_BY_ID[type_id].group == "Kød"
    if is_meat and re.search(_COLD_CUT_BRANDS, f"{whole} {extra}") and "pålæg" not in proc:
        proc.append("pålæg")
    if type_id in ("kyllingebryst", "kyllingeinderfilet") and "pålæg" not in proc:
        grams = [float(g) for g in re.findall(r"(\d+)\s*(?:g|gr)\b", both)]
        if grams and max(grams) <= 200:  # ≤200 g kyllingebryst er i praksis pålæg
            proc.append("pålæg")
    if proc:
        a["forarbejdet"] = ",".join(proc)

    vt = TYPE_BY_ID[type_id]
    if "fedt" in vt.key:
        rs = fat_ranges(t) or fat_ranges(extra)
        buckets = {fat_bucket(type_id, r) for r in rs}
        if len(buckets) == 1:
            a["fedt"] = buckets.pop()

    if type_id == "mælk":
        for word, val in [("skummet", "skummetmælk"), ("mini", "minimælk"), ("let", "letmælk"),
                          ("sød", "sødmælk"), ("jersey", "jerseymælk")]:
            if re.search(rf"{word}\s*-?\s*mælk", t):
                a["mælketype"] = val
                break
        if "mælketype" not in a:
            m = fat_ranges(t)
            if m:
                v = m[0][1]
                a["mælketype"] = ("skummetmælk" if v <= 0.1 else "minimælk" if v <= 0.5
                                  else "letmælk" if v <= 1.5 else "sødmælk")

    if type_id in ("kyllingebryst", "kyllingeinderfilet"):
        if re.search(r"med lage|tilsat (vand|lage)|injiceret", both):
            a["tilsat_vand"] = "ja"
        elif re.search(r"uden (vand|lage)|ikke tilsat|100\s*%\s*kød", both):
            a["tilsat_vand"] = "nej"
        else:
            a["tilsat_vand"] = "nej" if re.search(r"frisk|økologisk|friland", both) else "?"

    if type_id == "kyllingelår":
        if re.search(r"lårfilet|filet af lår|udbenet", t):
            a["udskæring"] = "lårfilet"
        elif "underlår" in t and "overlår" not in t:
            a["udskæring"] = "underlår"
        elif "overlår" in t and "underlår" not in t:
            a["udskæring"] = "overlår"
        elif re.search(r"hele\s*-?\s*lår|hele kyllingelår|lår med ryg", t):
            a["udskæring"] = "hele lår"
        elif "lårmix" in t or ("underlår" in t and "overlår" in t):
            a["udskæring"] = "blandet"

    if type_id == "fast_ost":
        grams = [float(g) for g in re.findall(r"(\d+)\s*(?:g|gr)\b", both)]
        if re.search(r"revet|reven", both):
            a["form"] = "revet"
        elif re.search(r"skive|\bskiver\b", both):
            a["form"] = "skiver"
        elif re.search(r"skæreost|\bblok\b", both) or (grams and min(grams) >= 400):
            a["form"] = "blok"  # skiver/revet sælges næsten altid i < 400 g og står på pakken

    if type_id == "æg":
        if a["øko"] == "ja":
            a["produktion"] = "økologisk"
        elif re.search(r"friland", both):
            a["produktion"] = "frilands"
        elif re.search(r"skrabe", both):
            a["produktion"] = "skrabe"
        elif re.search(r"\bbur", both):
            a["produktion"] = "bur"

    if type_id in ("skyr", "græsk_yoghurt", "a38_ymer", "yoghurt"):
        if re.search(r"naturel|natural|\bplain\b|neutral", t):
            a["smag"] = "naturel"
        elif re.search(_FLAVOURS, t):
            a["smag"] = "med smag"
        elif re.search(r"naturel|natural", extra):
            a["smag"] = "naturel"
        elif re.search(_FLAVOURS + r"|flere varianter|variant", extra):
            a["smag"] = "med smag"

    if type_id in ("kikærter", "kidneybønner", "sorte_bønner", "hvide_bønner", "linser"):
        if re.search(r"tørre(de|t)", both):
            a["form"] = "tørret"
        elif re.search(r"i lage|i vand|dåse|kogte|drænet|\bglas\b|tetra", both):
            a["form"] = "kogt (dåse)"
        elif re.search(r"\b(2[0-9]{2}|3[0-9]{2}|4[0-4][0-9])\s*(g|gr)\b", both):
            # 200-449 g er i praksis altid dåse/tetra; tørrede sælges i 500 g+
            a["form"] = "kogt (dåse)"

    if type_id == "tun":
        if re.search(r"i (vand|lage|saltlage|eget)", both):
            a["medium"] = "i vand"
        elif re.search(r"i (olie|solsikke|oliven|rapsolie)", both):
            a["medium"] = "i olie"

    return a


# ---------------------------------------------------------------------------
# Opdeling af tilbud med flere varianter
# ---------------------------------------------------------------------------
_STEMS = r"(kyllinge?|okse|grise?|svine|kalve?|lamme|kalkun)"


def _expand_hyphen_prefixes(t: str) -> str:
    """'kyllingevinger, -lårfilet eller -underlår' -> 'kyllingevinger, kyllingelårfilet ...'"""
    out, last_stem = [], None
    for tok in re.split(r"(\s+)", t):
        if tok.startswith("-") and len(tok) > 2 and tok[1].isalpha() and last_stem:
            tok = last_stem + tok[1:]
        m = list(re.finditer(_STEMS, tok))
        if m:
            last_stem = m[-1].group(1)
        out.append(tok)
    return "".join(out)


def split_variants(heading: str) -> list[str]:
    t = _expand_hyphen_prefixes(normalize(heading))
    # punktum splitter kun efter hele ord (5+ bogstaver), ikke forkortelser som "kar." / "d.g."
    parts = re.split(r",\s*|\s+eller\s+|(?<=[a-zæøå]{5})\.\s+|\s+samt\s+", t)
    merged: list[str] = []
    for p in parts:
        p = p.strip(" .")
        if not p:
            continue
        if merged and merged[-1].endswith("-"):
            merged[-1] = merged[-1] + " eller " + p  # 'kyllingeover- eller underlår'
        else:
            merged.append(p)
    # Bær mærke/forled fra første variant ikke videre – men bær variant-løse
    # efterled ("8-12%") tilbage til forrige variant
    final: list[str] = []
    for p in merged:
        if final and re.fullmatch(r"[\d\s,.\-%+]+(fedt)?", p):
            final[-1] += " " + p
        else:
            final.append(p)
    return final


# ---------------------------------------------------------------------------
# Offentligt API
# ---------------------------------------------------------------------------
@dataclass
class Match:
    type_id: str
    attrs: dict[str, str]
    variant_text: str
    source_hint: str = "tekst"  # "tekst" eller "kategori"
    notes: list[str] = field(default_factory=list)
    offer_variants: int = 1  # antal varianter i hele tilbuddet (inkl. ikke-genkendte)
    same_class_variants: int = 1  # heraf varianter med samme vareklasse som denne

    @property
    def offer_is_homogeneous(self) -> bool:
        """Alle varianter i tilbuddet er samme vareklasse -> kiloprisen gælder denne vare."""
        return self.same_class_variants >= self.offer_variants

    @property
    def vtype(self) -> VareType:
        return TYPE_BY_ID[self.type_id]

    def class_key(self) -> str:
        """Nøgle for 'samme vare'. Indeholder '?' hvis en nøgle-egenskab er ukendt."""
        parts = [self.type_id]
        for k in self.all_keys:
            parts.append(f"{k}={self.attrs.get(k, '?')}")
        parts.append(f"forarbejdet={self.attrs.get('forarbejdet', 'nej')}")
        return "|".join(parts)

    @property
    def all_keys(self) -> tuple[str, ...]:
        # økologi og laktosefri ændrer altid prisen -> altid nøgle-egenskaber
        extra = tuple(k for k in ("øko", "laktosefri") if k not in self.vtype.key)
        if self.type_id == "æg":
            extra = tuple(k for k in extra if k != "øko")  # indgår i 'produktion'
        return self.vtype.key + extra

    @property
    def is_exact(self) -> bool:
        return "?" not in self.class_key()

    def label(self) -> str:
        bits = [self.vtype.label]
        for k in self.all_keys:
            v = self.attrs.get(k, "?")
            if k in ("øko", "laktosefri"):
                word = "økologisk" if k == "øko" else "laktosefri"
                if v != "nej":
                    bits.append(word if v == "ja" else f"{word}?")
            elif k == "tilsat_vand":
                bits.append({"ja": "tilsat vand", "nej": "uden tilsat vand", "?": "tilsat vand?"}[v])
            else:
                bits.append(v if v != "?" else f"{k}?")
        if self.attrs.get("forarbejdet"):
            bits.append(f"[{self.attrs['forarbejdet']}]")
        return ", ".join(bits)


def _type_for(t: str) -> VareType | None:
    for vt in TYPES:
        if re.search(vt.include, t) and not re.search(vt.exclude, t):
            return vt
    return None


def classify(heading: str, description: str = "", category_hint: str | None = None) -> list[Match]:
    """Genkend varen/varerne i et tilbud eller produktnavn.

    category_hint: kildens egen kategori-sti (fx Sallings), bruges før teksten.
    """
    desc = normalize(description or "")
    hint_type = SALLING_CATEGORY_MAP.get(_cat_leaf(category_hint)) if category_hint else None
    if category_hint and hint_type is None and _cat_leaf(category_hint) in SALLING_NON_STAPLE:
        return []

    whole = normalize(heading)
    variants = split_variants(heading) or [whole]
    # Dansk udelader det fælles navneord: "Grønnelund eller Mammen skæreost",
    # "hakkede eller flåede tomater" -> lån sidste navneord fra sidste variant.
    head_noun = (re.findall(r"[a-zæøå]{3,}", variants[-1]) or [""])[-1]
    typed: list[tuple[str, VareType | None]] = []
    for i, v in enumerate(variants):
        vt = TYPE_BY_ID[hint_type] if hint_type else _type_for(v)
        if not vt and i < len(variants) - 1 and head_noun:
            vt = _type_for(f"{v} {head_noun}")
            if vt:
                v = f"{v} {head_noun}"
        typed.append((v, vt))

    matches: list[Match] = []
    for v, vt in typed:
        if not vt:
            continue
        # Lidl m.fl.: "Hakket grise- og kalvekød" + beskrivelse "4-7 % eller 8-12 % fedt"
        # -> samme pris gælder to varianter, én pr. fedt-interval.
        desc_fats = fat_ranges(desc) if "fedt" in vt.key and not fat_ranges(v) else []
        fat_options = {fat_bucket(vt.id, r) for r in desc_fats}
        if len(variants) == 1 and len(fat_options) > 1:
            for r in desc_fats:
                a = extract_attrs(vt.id, f"{v} {r[0]:g}-{r[1]:g}%", desc, whole)
                matches.append(Match(vt.id, a, v, "kategori" if hint_type else "tekst"))
            continue
        # beskrivelsen gælder kun entydigt hvis der er én variant
        a = extract_attrs(vt.id, v, desc if len(variants) == 1 else "", whole)
        if hint_type:
            for k, val in SALLING_CATEGORY_ATTRS.get(_cat_leaf(category_hint), {}).items():
                a.setdefault(k, val)
        matches.append(Match(vt.id, a, v, "kategori" if hint_type else "tekst"))
    if not matches and description and not category_hint:
        # Varetypen står kun i beskrivelsen ("Mutti tomater" / "Polpa hakkede eller Pelati flåede")
        # Kun kolonialvarer – for kød/mejeri gav det for mange fejl (menuer, legetøj ...)
        everything = classify(f"{heading} {description}")
        fallback = [m for m in everything if m.vtype.group == "Kolonial"]
        for m in fallback:
            m.notes.append("type fundet i beskrivelse")
            m.offer_variants = max(m.offer_variants, len(everything))
        return fallback
    # dedup på klasse + tæl varianter (ikke-genkendte varianter tæller med i totalen)
    n_unmatched = sum(1 for _, vt in typed if vt is None)
    total = len(matches) + n_unmatched
    per_class: dict[str, int] = {}
    for m in matches:
        per_class[m.class_key()] = per_class.get(m.class_key(), 0) + 1
    seen, out = set(), []
    for m in matches:
        if m.class_key() not in seen:
            seen.add(m.class_key())
            m.offer_variants, m.same_class_variants = total, per_class[m.class_key()]
            out.append(m)
    return out


def comparability(a: Match, b: Match) -> str | None:
    """'samme' (må bruges til prisdom), 'lignende' (kun til orientering) eller None."""
    if a.type_id != b.type_id:
        return None
    if a.attrs.get("forarbejdet") != b.attrs.get("forarbejdet"):
        return None
    if a.is_exact and b.is_exact and a.class_key() == b.class_key():
        return "samme"
    # nøgle-egenskaber der er kendte på begge sider må ikke modsige hinanden
    for k in a.all_keys:
        va, vb = a.attrs.get(k, "?"), b.attrs.get(k, "?")
        if "?" not in (va, vb) and va != vb:
            return None
    return "lignende"


def is_healthy_staple(m: Match) -> bool:
    if m.attrs.get("forarbejdet"):
        return False
    if m.type_id in ("skyr", "græsk_yoghurt", "a38_ymer", "yoghurt") and m.attrs.get("smag") == "med smag":
        return False
    return True


# ---------------------------------------------------------------------------
# Salling kategori-sti (sidste led) -> vores type. Bruges for EAN-varer.
# ---------------------------------------------------------------------------
def _cat_leaf(path: str | None) -> str:
    return (path or "").split(">")[-1].strip()


SALLING_CATEGORY_MAP: dict[str, str] = {
    "Hakket grise- & kalvekød": "hakket_gris_kalv",
    "Hakket grisekød": "hakket_grisekød",
    "Hakket oksekød": "hakket_oksekød",
    "Hakket kylling": "hakket_kylling",
    "Svinemørbrad": "svinemørbrad",
    "Letmælk": "mælk", "Minimælk": "mælk", "Skummetmælk": "mælk", "Sødmælk": "mælk",
    "Kærnemælk": "kærnemælk",
    "Piskefløde": "piskefløde",
    "Madlavningsfløde": "madlavningsfløde",
    "Smør": "smør",
    "Smørbart": "smørbar",
    "Hytteost": "hytteost",
    "Mozzarella": "mozzarella",
    "Feta & salatost": "feta",
    "Revet ost & topping": "fast_ost",
    "Ost i skiver": "fast_ost",
    "Skæreost": "fast_ost",
    "Skyr": "skyr",
    "A38, tykmælk & ymer": "a38_ymer",
}
# Egenskaber som Sallings kategori fastlægger, hvis navnet ikke selv siger det
SALLING_CATEGORY_ATTRS: dict[str, dict[str, str]] = {
    "Revet ost & topping": {"form": "revet"},
    "Ost i skiver": {"form": "skiver"},
    "Skæreost": {"form": "blok"},
    "Letmælk": {"mælketype": "letmælk"},
    "Minimælk": {"mælketype": "minimælk"},
    "Skummetmælk": {"mælketype": "skummetmælk"},
    "Sødmælk": {"mælketype": "sødmælk"},
}
# Salling-kategorier der med sikkerhed ikke er basisvarer
SALLING_NON_STAPLE = {
    "Kyllingepålæg", "Tilberedt kylling", "Grisepølser", "Kyllingepølser", "Medister",
    "Smøreost", "Snackost", "Dessert & snacks", "Kolde kaffedrikke & kakao", "Koldskål",
    "Mælkedrikke", "Drikke- & børneyoghurt", "Margarine", "Fedt", "Spareribs & barbecuekød",
    "Hønse- & kyllingesalat", "Middagsretter", "Sandwiches & wraps", "Oliven & andet tilbehør",
    "Naan- & fladbrød",
}
