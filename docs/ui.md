# FoodCatch – UI specification

Status: accepted for implementation (2026-11-18); all-chain offers, item price history and
food-waste sources added 2026-11-19 (§12). Owner of this document: the web app (`web/`).

This is the implementation-ready redesign of the web UI. It replaces the current layout; the
deal logic (architecture §6) and its conservative verdicts are unchanged. Everything a user sees
is Danish (exact copy below, in quotes); code, comments and this document are English.

The owner's request, in short: far less clutter; show clearly **in which store** something can
be bought; show stores **on a map**; a chosen address must be **saved** and never look cleared;
show **weight/size** of every offer and clearance; link to **where the price comes from** so it
can be checked.

The owner is a student who uses FoodCatch on a **phone** while deciding where to shop (one hand,
in the street, short glances) and on a **laptop** at home (planning the week). Mobile is the
primary design target; desktop uses the extra width for a map next to the list.

---

## 1. Facts this design rests on

All facts were collected on 2026-11-18. URLs were verified with real requests
(`User-Agent: foodcatch/0.1 (+https://github.com/toke-dk/foodcatch)`); the Salling API was not
called.

### 1.1 Source links (verified)

| Source | URL template | Verified with | Result |
|---|---|---|---|
| Tjek / eTilbudsavis offer | `https://etilbudsavis.dk/{slug}?publication={catalog_id}&offer={offer_id}` | `https://etilbudsavis.dk/Netto?publication=40K-WXWp&offer=quPV2BQEWPxpWQGWNTYwj` and `https://etilbudsavis.dk/fotex?publication=bhqFY_Gr&offer=F0TmTrjHQD0LXNiyxDDrg` | 200; `<title>Opbevaring til bamser fra Netto</title>` and `<title>O.P. Anderson eller The Famous Grouse fra føtex</title>`, i.e. the page opens the exact offer in its leaflet (the `og:image` is the offer's crop of leaflet page 36). |
| eTilbudsavis chain page (fallback) | `https://etilbudsavis.dk/{slug}` | all ten slugs below | 200, `<title>{Chain} tilbudsavis</title>` |
| eTilbudsavis store page | `https://etilbudsavis.dk/{slug}/butikker/{tjek_store_id}` | `https://etilbudsavis.dk/Netto/butikker/86d7kOL` | 200, `<title>Netto - Holbæk - Smedelundsgade 19-21 - …</title>` |
| REMA 1000 product | `https://shop.rema1000.dk/varer/{product_id}` | `/varer/100004`, `/varer/101394` | 200 after a redirect to the canonical page (`…/100004-jordbaermarmelade`); title `JORDBÆRMARMELADE \| REMA 1000`; the page embeds the same price data as our API (`23.95`, `285 GR`, compare price `84.04`). |
| Open Food Facts product (weight only) | `https://world.openfoodfacts.org/product/{ean}` | `/product/5710328002307` | 200 after redirect; title `Yoghurt – Løgismose – 1000g`. |
| Salling product image | `listing.extra.image` (`https://digitalassets.sallinggroup.com/image/upload/…/{hash}`) | one image URL | 200 `image/png`. 27 % of clearances (1,159 of 4,287 in the raw store) carry a placeholder URL ending in `/image` – those are not shown. |

How the Tjek template was found: eTilbudsavis is a client-rendered app. Its route table (in
`entry-client-*.js`) has no offer or publication path; offers open on the chain route
`/$businessSlug` with the search parameters `publication` and `offer`
(`validateSearch: {publication, offer, location, …}`), and `businessSlug` is
`business.slugs[0]`, the dealer's `markets[0].slug` in the Tjek API. The old formats
`/Netto/tilbudsaviser/{id}?page=N` and `/tilbud/{id}` return 404. A lower-case slug redirects to
the right case (`/netto` → `/Netto`).

eTilbudsavis slugs (from `dealer.markets[].slug` in the Tjek payloads, each verified with a 200 on
`https://etilbudsavis.dk/{slug}`):

| `chain_id` | slug |
|---|---|
| `netto` | `Netto` |
| `rema1000` | `REMA-1000` |
| `lidl` | `Lidl` |
| `foetex` | `fotex` |
| `bilka` | `Bilka` |
| `365discount` | `365discount` |
| `superbrugsen` | `SuperBrugsen` |
| `kvickly` | `Kvickly` |
| `meny` | `MENY` |
| `spar` | `SPAR` |
| `loevbjerg` | none (no Løvbjerg offer seen; no link until a slug is observed) |

The slug is not stored in the database; it is a static map in `web/src/lib/chains.ts`.

**Salling food waste has no public per-item page.** The best verifiable evidence we can show is
(1) Salling's own product photo (`extra.image`, the pack usually shows its weight), (2) the EAN,
(3) the exact store with address, and (4) when the weight comes from Open Food Facts, a link to
that product page. We do not invent a Salling link.

Not verified, therefore not used: expired eTilbudsavis offers (whether the page still resolves
after `valid_to`), Salling store pages, any Netto/føtex/Bilka web shop page.

### 1.2 Weight / size coverage

Production (`api` views via the read-only role, 2026-11-18):

* `api.current_netto_deals`: 41 rows; **all 41** have a unit price (so a size is known); 17 are
  ranges (`unit_price_min <> unit_price_max`, e.g. "250-400 g"); 2 are priced per `stk`.
* `api.food_waste_near`: 1,138 clearances in 233 stores (Netto, føtex, Bilka). Only **164
  (14 %)** have a unit price (size stated in the Salling name, e.g. `AGED HAVARTI 200G`);
  24 are variable-weight items (`stock_unit = 'kg'`); 1,114 (98 %) have an EAN.
* `api.class_price_history`: every Tjek offer and every REMA 1000 shelf price has a unit price;
  food-waste clearances mostly do not (Netto 132 of 1,062, føtex 32 of 393, Bilka 0 of 21).

Raw store (`data/raw`, payloads of 2026-11-18):

* Tjek offers: 6,820 offers; **100 %** carry `quantity.size` (`from`/`to`) with an SI unit:
  pieces 47 %, kg 35 %, l 18 %; 15 % are ranges. Ingest stores this as
  `listing.size_min/size_max/unit`. Every offer has `catalog_page`; none has `store_id` or a
  web-shop link.
* REMA 1000 catalogue: 3,955 products; 100 % have `compare_unit_price`; 96.5 % state the size in
  `underline` (stored as `listing.description`, e.g. `285 GR. / EASIS`); the rest are non-food
  (`MTR.`, `SÆT`, `PAR`). Ingest's `size = price / compare_unit_price` is approximate (Rema rounds
  the compare price), so the size shown comes from the description when it parses.
* Salling food waste: 4,287 clearances; the size parses from the name for only **202 (4.7 %)**;
  102 are variable weight (`stockUnit = kg`). The other weights can only come from Open Food
  Facts (`product.quantity_text`, `net_quantity`, `net_unit`). OFF coverage could not be measured
  today (the local database was not running); measure it with:

  ```sql
  SELECT count(*) AS clearances,
         count(p.net_quantity) AS with_off_size,
         count(*) FILTER (WHERE l.size_min IS NOT NULL) AS with_name_size
  FROM listing l LEFT JOIN product p ON p.id = l.product_id
  WHERE l.source = 'salling_food_waste' AND l.valid_to >= now();
  ```

  OFF quantities are crowd-sourced and can describe another pack size (the Løgismose yoghurt
  above is "1000g" on OFF, while the clearance's original price of 15 kr. suggests a smaller
  pack). They are therefore shown as "ifølge Open Food Facts" and **never** used for a unit
  price, a sort order or a verdict.

What to show when the weight is unknown: "Vægt ukendt" (muted) and no unit price
("Kilopris ukendt"). Never a guess.

### 1.3 Stores

* **Tjek catalogs are chain-wide**: all 51 catalogs in the raw store have `store_id = null`, and
  no offer has a `store_id`. A Netto leaflet price applies in every Netto; whether a given store
  has the item in stock is unknown.
* **REMA 1000 prices are national**; 16 % of the catalogue (623 of 3,955 products) is marked
  `is_available_in_all_stores = false` (not kept by ingest today; see §9 "Later").
* **Food waste is per store**: each clearance belongs to exactly one Salling store, with a stock
  snapshot from the latest food-waste run.
* `api.stores` lists Salling stores **and** Tjek stores, so Netto, føtex and Bilka appear twice
  (identical name and coordinates; e.g. "Netto Rådhuspladsen" ×2). Store names are inconsistent
  (Lidl: "Kbh., Vesterbro, Fisketorvet"; others include the chain name).

Honest answer to "where can I buy this":

* Chain-wide offer (Tjek, REMA 1000): "the chain" plus the **nearest stores of that chain**
  within the radius with distances – "Gælder i alle Netto-butikker. Nærmest: Netto Rådhuspladsen
  80 m". We never claim a particular store has it in stock.
* Food waste: **the exact store**, its address and distance, and the stock at the time of the
  last update ("3 stk. tilbage kl. 13.37").

### 1.4 Map stack (no API key)

* **MapLibre GL JS `maplibre-gl@6.16.0`** (BSD-3-Clause; published 2026-10-25 – the newest 6.x
  that is at least two weeks old; 6.19.0 is the latest). Lazy-loaded on the client only.
* **OpenFreeMap** vector tiles, styles `https://tiles.openfreemap.org/styles/positron` (light) and
  `https://tiles.openfreemap.org/styles/dark` (dark) – both return 200. openfreemap.org: "Using
  our public instance is completely free: there are no limits on the number of map views or
  requests. There's no registration, no user database, no API keys, and no cookies."
  Attribution is required; the TileJSON
  (`https://tiles.openfreemap.org/planet`) carries it and MapLibre shows it automatically:
  "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" (OSM data: ODbL).
* Rejected: Leaflet 1.9.4 + `tile.openstreetmap.org` raster tiles. Lighter, but the OSM tile
  usage policy discourages app use and the raster look is busy; Leaflet 2 is still beta.
  `react-map-gl` is not needed (one small imperative component).

---

## 2. What is wrong today (screenshots 390×844 and 1440×900, production data)

* **Nothing useful above the fold on a phone.** On `/` the first screen is the title, a lead
  paragraph, the location form (with hint text) and eight chain chips; the first offer starts
  below 900 px. The page is 4,876 px tall with the default filter and 16,478 px with "Alle".
* **No "where".** A deal card never says where it can be bought; "Kæder i nærheden" is a
  separate chip row that the cards do not refer to.
* **No weight.** A card shows "10,00 kr." and "33,33 kr./kg" but not "300 g"; food-waste cards
  show neither (86 % have no size at all).
* **The address looks cleared.** After "Opdater" React 19 resets the uncontrolled input, and the
  saved address only appears in a small sentence ("Viser butikker inden for 2 km af …").
* **Clutter and repetition.** Two heading levels per product (group + upper-case type), a
  status-count line with seven numbers, long explanation sentences on every card, a "Sådan
  vurderer vi" essay, inconsistent badge position (right, or wrapped under the title), one card
  per *variant* (the same Netto offer appears two or three times).
* **Tables overflow on mobile** (the comparison table inside a card and the price-history table
  are cut off at the right edge; the chart is cut off too).
* **Matcher internals leak**: class labels such as "Yoghurt, naturel, fedt?, økologisk".
* **Food waste is a 29,616 px flat list** of 124 cards, sorted by discount, without grouping by
  store; dates read "Tilbuddet gælder til: 18. nov. 2026 kl. 23.59".
* **No source links** anywhere.

---

## 3. Information architecture and navigation

| Route | Danish name | Purpose |
|---|---|---|
| `/` | "Tilbud" | This week's offers on healthy staples from **every chain with a store within the radius**, good buys first, each with where, size, verdict and source (§12.1). |
| `/madspild` | "Madspild" | Clearances in nearby stores, grouped by store, nearest first. Desktop: list + map. |
| `/kort` | "Kort" | **New.** All nearby stores on a map, coloured by chain; tap a store to see what to buy there. |
| `/soeg` | "Søg" | Find any item by name and open its price history (§16). |
| `/vare/[classKey]` | – | Price history of one product class across chains (reached from a comparison). |
| `/produkt/[productKey]` | – | **New.** Price history of one item (`product_key`, URL-encoded), §12.2. |
| `/status` | "Datastatus" | Pipeline health. Linked from the footer and from the stale-data banner, not from the main navigation. |

Query parameters (all optional, shareable):

* `/?vis=alle` – show all offers (default: only "Gode køb").
* `/?kaede=lidl,netto` – only offers of these chains (combinable with `vis=alle`).
* `/produkt/{key}?pris=enhed&periode=alt` – unit price instead of pack price; whole history.
* `/madspild?sorter=rabat` – sort by discount (default: nearest store first).
* `/soeg?q=faxe+kondi` – item search (§16).
* `/kort?kaede=netto,lidl&butik={store_id}` – chain filter and selected store.

**Mobile shell (< 768 px)**

* Top bar, 48 px, sticky: app mark "FoodCatch" (left), **location button** (right, see §5.1).
* Bottom tab bar, 56 px + `env(safe-area-inset-bottom)`, fixed: three tabs with icon + label:
  "Tilbud", "Madspild", "Kort". Active tab: brand colour, `aria-current="page"`.
* No page titles larger than 20 px; no lead paragraphs.

**Desktop shell (≥ 1024 px)**

* Header, 56 px: "FoodCatch" (left), nav links "Tilbud", "Madspild", "Kort" (centre-left),
  location button (right). Content max width 1200 px, 24 px gutters.
* Tablet (768–1023 px): desktop header, single-column content, map pages as on mobile.

**Footer (all pages):** "Priser fra Tjek (eTilbudsavis), REMA 1000, Salling Group og Open Food
Facts. Tjek altid prisen i butikken." · "Datastatus" · "Kildekode (MIT)". On mobile the footer sits
above the tab bar spacer.

**Stale-data banner (all pages)**, shown only when `overallTone(jobs) === "bad"` (same rule as
`/status`): warn tone, one line: "Priserne er måske forældede – data blev sidst hentet
{formatRelative}." + link "Se status". A job is "Forsinket" (warn, no banner) once one whole
scheduled run is missing and "Forældet" (bad, banner) once two are (`lib/status.ts` `JOBS`; GitHub
starts schedules up to ~10 hours late and sometimes skips one).

---

## 4. Visual system

Calm, mostly neutral surfaces; colour only for meaning (verdict, chain, member price).

### 4.1 Type scale (system font stack, unchanged)

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `text-title` | 20/28 | 700 | page title (one per page) |
| `text-heading` | 17/24 | 600 | card title, store name |
| `text-body` | 15/22 | 400 | default |
| `text-price` | 20/24 | 700, tabular | the price on a card |
| `text-meta` | 13/18 | 400 | size, distance, dates, source links |
| `text-micro` | 12/16 | 500 | badges, map labels |

Minimum 15 px for running text on mobile; `text-meta` only for secondary facts.

### 4.2 Spacing and shape

4 px grid: 4, 8, 12, 16, 24, 32, 48. Card padding 16 px (mobile) / 20 px (desktop); gap between
cards 12 px; between sections 32 px. Radius: cards 12 px, buttons 10 px, chips/badges full. One
1 px border (`--line`) per card, no shadows. Touch targets ≥ 44×44 px.

### 4.3 Colour tokens

Existing tokens in `globals.css` stay (`--page`, `--surface`, `--surface-2`, `--ink`, `--ink-2`,
`--ink-3`, `--line`, `--line-strong`, `--link`, `--focus`, `--brand`, `--good-*`, `--bad-*`,
`--warn-*`, `--neutral-*`, `--series-*`). Additions:

```css
:root {
  --map-user: #2a78d6;        /* user position dot and radius ring */
  --map-ring: rgba(42,120,214,.12);
  --overlay: rgba(11,11,11,.32); /* sheet backdrop */
}
@media (prefers-color-scheme: dark) {
  :root { --map-user: #5598e7; --map-ring: rgba(85,152,231,.16); --overlay: rgba(0,0,0,.5); }
}
```

**Verdict colours** (only two verdicts get colour):

| Verdict group | Tone | Glyph | Tokens |
|---|---|---|---|
| "Godt køb" | good | ✓ | `--good-fg/bg/line` |
| "Billigere andetsteds" | bad | ✕ | `--bad-fg/bg/line` |
| everything else | neutral | – | `--neutral-fg/bg/line` |
| member price badge | warn | ★ | `--warn-fg/bg/line` |

**Chain colours** (map markers, chain dots, filter chips). Brand colours collide (most chains are
blue, red or yellow), so this is a categorical palette loosely inspired by the brands, always
paired with a **monogram** so colour is never the only cue. Text colour on the fill meets 4.5:1.
Same fills in dark mode; markers get a 2 px `--surface` outline in both modes. Lidl and
365discount are darker than first proposed (`#0A84C6`, `#2E8B3A`), which gave white monograms only
4.1:1 and 4.3:1; `lib/chains.test.ts` checks every pair.

| `chain_id` | Fill | Text | Monogram |
|---|---|---|---|
| `netto` | `#F2C200` | `#1a1a1a` | `N` |
| `rema1000` | `#1B4F9C` | `#ffffff` | `R` |
| `lidl` | `#0A78B5` | `#ffffff` | `L` |
| `foetex` | `#5B3A9B` | `#ffffff` | `F` |
| `bilka` | `#0E7C7B` | `#ffffff` | `B` |
| `365discount` | `#287D33` | `#ffffff` | `365` |
| `superbrugsen` | `#D0262E` | `#ffffff` | `SB` |
| `kvickly` | `#8C1C13` | `#ffffff` | `K` |
| `meny` | `#1F1F1F` | `#ffffff` | `M` |
| `loevbjerg` | `#D9621A` | `#1a1a1a` | `LØ` |
| `spar` | `#5E7F2A` | `#ffffff` | `S` |

Defined once in `web/src/lib/chains.ts` (`CHAIN_STYLE: Record<chainId, {fill, text, monogram}>`),
unknown chains fall back to `--neutral-fg` with the first letter.

### 4.4 Dark mode

Follows `prefers-color-scheme` as today. The map switches style (`positron` ↔ `dark`) by the same
media query (listen to `matchMedia(...).change` and call `map.setStyle`, re-adding the user
layers on `style.load`).

### 4.5 Icons

Inline SVG, 20 px, `currentColor`, `aria-hidden` with a text label next to them: pin (location),
tag (Tilbud), clock-leaf (Madspild), map (Kort), external-link (↗ after source links), route,
crosshair (centre map). No icon font, no emoji.

---

## 5. Components

### 5.1 Location button, location sheet and persistence

**Location button** (top bar / header): pin icon + label + radius, e.g.
"Nørrebrogade 10 · 2 km". Truncates the label with an ellipsis (max 22 ch on mobile, 40 ch on
desktop); the full label is in `title` and in the accessible name: "Placering: {label}, radius
{r} km. Skift". When no address is saved: "Vælg adresse · 2 km" in `--link` colour.

**Location sheet** (mobile: bottom sheet, 90 % max height; desktop: popover anchored to the
button, 400 px wide). `role="dialog"`, `aria-modal="true"`, labelled "Din placering", focus moves
to the address input, Esc / backdrop / "Luk" closes, focus returns to the button.

Content, top to bottom:

1. Saved-address row (only when one is saved):
   "Gemt: **{label}**" and a small text button "Glem".
2. Input, label "Adresse", `defaultValue` = saved label (empty when default), placeholder
   "Vej og nummer, postnummer", `autoComplete="street-address"`, `enterKeyHint="search"`.
3. Button (secondary, full width on mobile): "Brug min position" – only rendered when
   `window.isSecureContext && "geolocation" in navigator` (true on `localhost`; false on plain
   http over the LAN).
4. Radius, label "Afstand": segmented control "1 km | 2 km | 3 km | 4 km | 5 km"
   (`RADIUS_OPTIONS_KM`), a radio group.
5. Primary button: "Gem" (pending: "Gemmer…", disabled).
6. Live region (`aria-live="polite"`) for messages.

Behaviour:

* Submitting with a changed address geocodes it (`saveLocation`, as today). Submitting with the
  unchanged saved label (or empty) only changes the radius – the action compares the submitted
  text with the cookie's label and skips geocoding when equal.
* **The input never appears cleared.** `saveLocation` returns
  `{status, message, address, location?}` where `address` is the submitted text. The input is
  rendered with `key={state.seq}` and `defaultValue={state.status === "error" ? state.address :
  savedLabel}`, so after React 19's automatic form reset it shows the typed text (error) or the
  saved label (success). `seq` increments on every action result.
* On success: the sheet closes, the location button shows the new label, and a toast-like line
  under the top bar shows "Gemt ✓" for 3 s (`role="status"`). The page re-renders with the new
  location (the server action already revalidates via the cookie; call `router.refresh()`).
* Errors (copy as today): "Vi kunne ikke finde “{address}”. Prøv med vejnavn, husnummer og
  postnummer." / "Adresseopslaget virker ikke lige nu. Prøv igen om lidt." Geolocation errors:
  "Vi fik ikke adgang til din position. Skriv en adresse i stedet." The sheet stays open.
* "Brug min position": `getCurrentPosition({enableHighAccuracy: false, timeout: 10000,
  maximumAge: 300000})` → new server action `saveCoordinates({lat, lon, accuracyM, radiusKm})`
  (validates with `isValidCoordinate`, no geocoding) → label "Min position". Pending text:
  "Finder din position…".
* "Glem": deletes cookie **and** localStorage entry (`resetLocation` + client removal), falls back
  to the default location, message "Adressen er glemt."

Persistence (three layers):

1. **Cookie** `fc_location` (unchanged format, `httpOnly`, `sameSite=lax`, `maxAge` one year) –
   the source of truth for server rendering. Re-set (sliding expiry) on every successful save.
2. **localStorage backup**, key `foodcatch.location.v1`, value
   `{"lat":…,"lon":…,"label":"…","r":2,"savedAt":"ISO"}`. Written by the client after every
   successful save (from `state.location`) and whenever the server renders a non-default
   location that differs from the stored one (server wins). Every access is in try/catch; the app
   works without it.
3. **Restore**: when the server renders the default location (`isDefault`) and localStorage holds
   a valid entry, the client calls the new server action `restoreLocation(entry)` (validated with
   the same rules as `parseLocationCookie`, no geocoding), then `router.refresh()`. While this
   runs the location button reads "Henter din gemte adresse…". It runs at most once per page
   load and never after "Glem".

The coordinates stay on the user's device and in the cookie; nothing new is sent anywhere.

### 5.2 Verdict badge

`<VerdictBadge status memberOnly />` – one pill, always in the same place (top right of the card
header, never wrapping under the title; on narrow cards the title wraps instead).

| `DealStatus` | Badge text | Tone | One-line reason (card) |
|---|---|---|---|
| `good_deal` | "Godt køb" | good | "Billigst i nærheden. Næstbedst: {chain} {unitPrice}" (the cheapest counted reference) |
| `cheaper_elsewhere` | "Billigere andetsteds" | bad | "{chain} har den til {unitPrice} ({distance})" |
| `undecided` | "Uafklaret" | neutral | "Afhænger af pakningen – {chain} har {unitPrice}" |
| `no_reference` | "Ingen sammenligning" | neutral | "Ingen butik i nærheden har præcis samme vare." |
| `not_exact` | "Ukendt egenskab" | neutral | "Tilbuddet oplyser ikke alle egenskaber (fx fedtprocent)." |
| `ambiguous_offer` | "Flere varer" | neutral | "Prisen dækker flere forskellige varer." |
| `no_price` | "Ingen kilopris" | neutral | "Kilden oplyser ikke vægten." |
| `pending` | "Beregnes" | neutral | "Sammenligningen er ikke beregnet endnu." |

Member prices: `deal.memberOnly` adds a second pill "★ Kræver Netto+" (`memberPriceLabel`) next to
the verdict, and a member-price `good_deal` reads "Godt køb med Netto+". The rule that a member
price is a good deal only when marked (architecture §6) is unchanged; the badge is the marking.

`{distance}` is the distance to the nearest store of that chain (§5.5). Reasons are built by a
pure function `verdictReason(deal, references, nearestByChain)` in `lib/deals.ts` replacing
`explainStatus`.

### 5.3 Pack size and unit price

Pure function `formatPackSize({unit, sizeMin, sizeMax, source, description})` in `lib/format.ts`:

| Case | Output |
|---|---|
| `unit = kg`, both < 1 | grams, no decimals: "300 g", "250–400 g" |
| `unit = kg`, max ≥ 1 | kg, up to 3 decimals, trailing zeros dropped: "1 kg", "0,8–1,45 kg" |
| `unit = l`, both < 1 | "500 ml", "250–330 ml" |
| `unit = l`, max ≥ 1 | "1 l", "1,5 l" |
| `unit = stk` | "8 stk.", "6–10 stk." |
| `source = 'rema'` | parse the leading token of `description` before " / " (`^(\d+(?:[.,]\d+)?)\s*(GR|KG|ML|CL|LTR|L|STK)\.?`), e.g. "400 GR." → "400 g", "1 LTR." → "1 l"; if it does not parse, the computed size with "ca. " ("ca. 400 g") |
| Food waste, size from name (`size`) | as above |
| Food waste, `stock_unit = 'kg'` | "Vægt varierer" (checked before OFF: a product sold by weight has no fixed pack size) |
| Food waste, no name size, OFF size known | "{formatted OFF size} ifølge Open Food Facts" (from `product_net_quantity`/`product_net_unit`; else `product_quantity_text` verbatim) |
| nothing known | "Vægt ukendt" |

Card price line (one line, wraps only at the dots):
**"10,00 kr."** · "300 g" · "33,33 kr./kg". Unknown: **"6,00 kr."** · "Vægt ukendt" (no unit
price). Ranges: "19,00 kr." · "250–400 g" · "47,50–76,00 kr./kg". Unit prices use the existing
`formatUnitPriceRange`. Food-waste unit prices are only shown when the size came from the Salling
name.

### 5.4 Source link

Pure function `sourceLink(row, now)` in `lib/sources.ts` → `{href, label} | null`, from §1.1 only:

| Row | `href` | `label` | Condition |
|---|---|---|---|
| `source = 'tjek'` | `https://etilbudsavis.dk/{slug}?publication={catalog_id}&offer={source_item_id}` | "Se tilbuddet i avisen" | slug known for `chain_id`; `catalog_id` and `source_item_id` non-empty; `valid_to` null or ≥ `now` |
| `source = 'tjek'`, expired | – | "Tilbuddet er udløbet" (plain text) | `valid_to < now` |
| `source = 'rema'` | `https://shop.rema1000.dk/varer/{source_item_id}` | "Se varen hos REMA 1000" | `source_item_id` matches `^\d+$`; for a closed price period the label is "Se varen hos REMA 1000 (viser dagens pris)" |
| `source = 'salling_food_waste'` | – | "Fra Salling Groups madspildsdata – ingen vareside" (details only) | always |
| OFF weight | `https://world.openfoodfacts.org/product/{ean}` | "Vægt ifølge Open Food Facts" | weight shown came from OFF and `ean` matches `^\d{8}$|^\d{12,14}$` |

All parameters are URL-encoded; links open in a new tab with `rel="noopener noreferrer"` and an
external-link icon plus visually hidden "(åbner i nyt vindue)". When no rule matches, nothing is
rendered (no dead links, no "Kilde: –").

### 5.5 "Where" line (stores)

Server query `getNearbyStores(area)` returns deduplicated stores within the radius with distance:
for chains with Salling stores (`netto`, `foetex`, `bilka`) only `source = 'salling'` rows (the
ids food waste refers to); for all other chains only `source = 'tjek'` rows. Display name
`storeDisplayName`: the store name if it starts with the chain name (case-insensitive), otherwise
"{chain} {name}" (→ "Lidl Kbh., Vesterbro, Fisketorvet").

`nearestByChain`: the stores of each chain sorted by distance.

* Deal card (chain-wide): chain dot + "**Netto** Rådhuspladsen · 80 m" and, if more,
  " · +7 andre" – one line at 390 px (the first version, "Netto · nærmest Rådhuspladsen 80 m ·
  +22 butikker", wrapped to two lines on every card). Screen readers hear "Nærmeste butik: Netto
  Rådhuspladsen · 80 m · +7 andre Netto-butikker i nærheden". The store name drops the chain
  prefix. Tapping the line opens `/kort?kaede=netto` (mobile) or filters the side map to Netto
  (desktop).
* No store of the offer's chain within the radius: the page shows the notice (§6.1); the card
  only says where the nearest one is, in the same form and in `--warn-fg`: "**Netto** Grenå ·
  52,9 km · uden for din afstand" (nearest outside the radius, from an unbounded nearest query
  limited to 1; screen readers hear "Ingen Netto inden for {r} km. Nærmeste butik: …").
* Comparison rows: chain + distance to its nearest store ("REMA 1000 · 330 m").
* Food waste: the exact store (store group header, §6.2).

One-time explanation (in "Sådan læser du tilbuddene", §6.1): "Tilbudsaviser gælder i hele
kæden. Vi viser de nærmeste butikker, men ved ikke, om de har varen på hylden."

### 5.6 Deal card (`/`)

One card per **listing** (offer), not per variant. Variants are rows inside.

```
┌──────────────────────────────────────────────┐
│ Hakket dansk grisekød 8-12 %     [✓ Godt køb] │  text-heading + badge
│ 10,00 kr. · 300 g · 33,33 kr./kg              │  text-price + meta
│ ● Netto Rådhuspladsen · 80 m · +7 andre       │  where line
│ lør. 14.–fre. 20. nov.                        │  period (meta)
│ Billigst i nærheden. Næstbedst: REMA 1000     │  reason (meta, ink-2)
│ 39,00 kr./kg                                  │
│ ─────────────────────────────────────────── │
│ Sammenlign (7)  ▾          Se tilbuddet i avisen ↗ │  footer row
└──────────────────────────────────────────────┘
```

* Title: the offer title (Tjek heading). The class label is **not** shown unless the offer has
  several recognised variants.
* Several variants with different verdicts: replace the single badge and reason with one row per
  variant – "{class label without unknown parts}" + badge – good ones first. A card is shown under
  "Gode køb" if any variant is a good deal; the other rows stay visible, so nothing is overstated.
* `max_per_customer`: meta text "Max {n} pr. kunde" appended to the period line.
* "Sammenlign ({n})" toggles the comparison list (a `<details>`; `n` = counted references).
  Inside, a **list** (no table):

  ```
  ● REMA 1000 · 330 m                    39,00 kr./kg
    Tilbud · 400 g · 15,60 kr. · tor. 20.–lør. 22. nov.
    Se varen hos REMA 1000 ↗
  ```
  Rows sorted by unit price; the cheapest counted row is bold with "billigst". Rows that do not
  count (chain not within the radius) are collapsed under "{k} tæller ikke med – ingen butik
  inden for {r} km" (a nested toggle). Reference kinds: "Tilbud", "Normalpris", "Tidligere
  Netto-tilbud", "EAN-pris". Member references carry "★ Medlemspris". Last line of the list:
  "Prishistorik →" (link to `/vare/[classKey]`).
* Reference details (size, price, source, catalog) come from `api.class_price_history` by
  `listing_id` (§8), fetched once per page for all references.

States: pending deal → neutral badge "Beregnes", no comparison toggle. No unit price → price line
without unit price and the `no_price` reason.

---

## 6. Pages

#### 6.1 `/` Tilbud

Mobile:

```
[FoodCatch]                [📍 Nørrebrogade 10 · 2 km]
──────────────────────────────────────────────────────
Ugens tilbud i Netto                    (text-title)
[ Gode køb (8) | Alle (41) ]            (segmented control)
Kød                                     (group heading, 13 px caps-free, ink-3)
┌ card ┐
┌ card ┐
Æg
┌ card ┐
…
▸ Sådan læser du tilbuddene              (details, collapsed)
footer
[ Tilbud | Madspild | Kort ]            (tab bar)
```

* Title "Ugens tilbud i Netto". No lead paragraph, no chain chips, no status-count line.
* Segmented control (links, `aria-current`): "Gode køb ({n})" / "Alle ({n})"; counts are listing
  counts.
* One heading level: the product group ("Kød", "Fisk", "Æg", "Mejeri", "Frugt og grønt",
  "Kolonial"). Within a group, cards are ordered by verdict rank, then title.
* With the default location, the first card must be visible above the fold at 390×844.
* Empty states (neutral notice):
  - no deals at all: title "Ingen tilbud lige nu", body "Vi har ingen aktuelle Netto-tilbud på
    sunde basisvarer. Se Datastatus for, hvornår data sidst blev hentet." (link)
  - no good deals: title "Ingen sikre gode køb i denne uge", body "Ingen af ugens {n} tilbud er
    dokumenteret billigere end samme vare i nærheden." + button-link "Se alle tilbud".
  - no Netto within the radius: warn notice "Der er ingen Netto inden for {r} km. Nærmeste er
    {name}, {distance}." with button "Skift afstand" (opens the location sheet).
* "Sådan læser du tilbuddene" (collapsed `<details>`), five short bullets:
  1. "**Godt køb** betyder, at Nettos pris er dokumenteret mindst lige så lav som præcis samme
     vare i butikkerne omkring dig."
  2. "Vi sammenligner kun præcis samme vare: type, fedtprocent, økologi, laktosefri og
     forarbejdning."
  3. "Nettos dyreste pakning sammenlignes med den billigste pris andre steder."
  4. "Andre kæders priser tæller kun, hvis kæden har en butik inden for din afstand."
  5. "Tilbudsaviser gælder i hele kæden. Vi viser de nærmeste butikker, men ved ikke, om de har
     varen på hylden."

Desktop (≥ 1024 px): two columns – list 640 px (cards single column), right column 480 px sticky
(`top: 72px`, height `calc(100dvh - 96px)`) with the store map (§7) showing all nearby stores.
"● Netto · nærmest …" on a card highlights that chain on the side map (others dimmed to 35 %
opacity) instead of navigating. Below the map: chain legend (dot + name + nearest distance), which
replaces today's "Kæder i nærheden" chips.

Loading (`app/loading.tsx`): title, segmented control and three skeleton cards (grey blocks at
card proportions, no shimmer when `prefers-reduced-motion`). Error (`error.tsx`): "Noget gik galt
– prøv igen." with a "Prøv igen" button (`reset()`), as today.

#### 6.2 `/madspild` Madspild

Default sort: nearest store first; within a store, largest discount first. Alternative:
`?sorter=rabat` – one flat list across stores, each item showing its store line.

Mobile:

```
Madspild nær dig                                   (text-title)
124 varer i 31 butikker · opdateret kl. 13.37      (meta; time = latest food-waste run)
[ Nærmest | Størst rabat ]
┌────────────────────────────────────────────────┐
│ (N) Netto Rådhuspladsen · 80 m          Rute ↗ │  store header (sticky within group)
│     Vestergade 39, 1456 København K · 5 varer  │
│ ────────────────────────────────────────────── │
│ [img] Øko yoghurt naturel Løgismose            │  item row (min 72 px)
│       3,00 kr.  før 15,00 kr.  −80 %           │
│       Vægt ukendt · 1 stk. tilbage · til i dag │
│ ────────────────────────────────────────────── │
│ [img] …                                        │
│ Vis 3 mere ▾                                   │  (groups show 4 items, then expand)
└────────────────────────────────────────────────┘
```

* Store header: chain monogram dot, `storeDisplayName`, distance, address + item count, "Rute"
  (`https://www.google.com/maps/dir/?api=1&destination={lat},{lon}`; documented Google Maps URLs
  API, a navigation aid, not a price source). On desktop also "Vis på kort" (pans the side map).
* Item row:
  - 56×56 product image (`image_url`, `loading="lazy"`, `referrerPolicy="no-referrer"`, empty
    `alt`; when null a neutral square with the type's first letter).
  - Title: the Salling name in sentence case (`displayTitle`: Danish lower-case, first letter
    upper-case; the original in `title`), e.g. "HK GRIS 3-7% MESTERHAKKET" → "Hk gris 3-7%
    mesterhakket".
  - Price line: **"3,00 kr."** "før ~~15,00 kr.~~" and a good-tone pill "−80 %" (discount
    rounded; shown when ≥ 1 %).
  - Meta line: pack size (§5.3) · stock ("1 stk. tilbage", "1,96 kg tilbage") · end
    ("til i dag", "til i morgen", else "til {formatDayDate}"; time added only if not 23.59).
  - Tap/click expands the row (`<details>`): larger image (240 px), class label without unknown
    parts, "EAN {ean}", the OFF weight link when applicable, "Sidst set {formatRelative
    (last_seen_at)}", and "Fra Salling Groups madspildsdata – ingen vareside".
* Footnote (meta, once, under the list): "Lageret er et øjebliksbillede fra seneste opdatering.
  Varen kan være udsolgt."
* Empty: "Ingen madspild inden for {r} km lige nu" / "Udvalget skifter i løbet af dagen. Prøv
  igen senere eller vælg en større afstand." + "Skift afstand".
* If the latest food-waste run is older than 24 h, the meta line reads "opdateret {formatRelative}"
  in `--warn-fg`.

Desktop: list column 560 px + sticky map (rest of the width) showing only stores that have
clearances, each marker with its item count; hovering a store group highlights its marker;
clicking a marker scrolls the list to that group and focuses its header.

#### 6.3 `/kort` Kort

Mobile: full-screen map between top bar and tab bar.

* Overlay at the top: horizontally scrollable chain filter chips (monogram dot + name, toggle
  buttons with `aria-pressed`), "Alle" first. Only chains with a store within the radius.
* Bottom sheet with three snap points: peek (88 px: "{n} butikker inden for {r} km"), half,
  full. It opens at half when a store is selected from the URL and when there is no store at
  all (header "Ingen butikker inden for {r} km", so "Skift afstand" is visible); the chain chips
  are hidden when there is no chain. In peek/half it lists stores nearest first (dot, name, distance, "{k} madspild",
  "{m} billigere end Netto"). Tap a row = select the store.
* Map controls (right, 44 px buttons): "Centrér på mig" (crosshair), zoom +/− only on desktop
  (pinch on mobile). Attribution: MapLibre's compact control at the top left below the chips on
  mobile (the bottom sheet would cover the bottom edge), the full control bottom-left on desktop.

Desktop: left sidebar 380 px (filters + store list), map fills the rest.

**Store sheet / sidebar detail** (when a store is selected; URL `?butik={id}`):

```
(N) Netto Rådhuspladsen                     ✕
    Vestergade 39, 1456 København K · 80 m
    [Rute ↗]  [Butikkens side ↗]
Madspild her (5)
    item rows as on /madspild (max 5, then "Se alle på Madspild →")
Ugens tilbud i Netto
    "8 gode køb gælder også her →"  (link to /)
```

* "Butikkens side" only for Tjek-sourced stores (`https://etilbudsavis.dk/{slug}/butikker/
  {source_store_id}`, §1.1).
* For a non-Netto chain the second section is "Billigere her end i Netto": the evaluated deals
  whose cheapest counted reference is this chain and whose status is `cheaper_elsewhere` or
  `undecided`: rows of three lines – the Netto offer's title; "**{chain}:** {reference title
  without the chain prefix} · {pack size} · {pack price} · {unitPrice}"; "Netto:
  {nettoUnitPrice}" (+ " · afhænger af pakningen" when undecided) – and the source link of the
  reference. The pack size follows §5.3 ("Vægt ukendt" when unknown). Empty: "Ingen af ugens sammenlignede varer er billigere her."
* Food-waste section only for Salling stores; nothing selected and nothing to show: "Ingen
  madspild eller sammenlignede tilbud her lige nu."

#### 6.4 `/vare/[classKey]` Prishistorik

* Title = class label without unknown parts; meta line "{n} priser registreret".
* Chart (existing SVG `PriceChart`) made responsive: `viewBox` with `width: 100%`, legend above
  the chart wrapping on mobile, y-axis labels inside the plot. No horizontal overflow.
* Below: a **list**, newest first, grouped by month heading ("november 2026"):
  "● {chain} · {kind}" / "{title}" / "{pack size} · {price} · {unit price}" / "{period}" and the
  source link (§5.4). Rows whose price does not apply are muted with "Gælder flere varer – ikke i
  grafen". Food-waste rows show the store name.
* Desktop: same single column, max width 760 px.

#### 6.5 `/status` Datastatus

Content unchanged; layout aligned with the new system (cards in one column on mobile, two on
desktop; `stats` shown as a definition list that wraps). Title "Datastatus".

---

## 7. Map component

`<StoreMap stores selectedId highlightChain filters onSelect user radiusKm mode />` – a client
component in `web/src/components/map/StoreMap.tsx`, loaded with `next/dynamic({ ssr: false })` so
MapLibre (~ 230 kB gzip JS + CSS) only loads on pages that show a map. Import
`maplibre-gl/dist/maplibre-gl.css` inside the component.

* Style: OpenFreeMap `positron` / `dark` (§1.4). `attributionControl: { compact: true }` on
  mobile and `{ compact: false }` on desktop; never hidden or covered.
* Initial view: `fitBounds` of the radius circle around the user (padding 24 px; on mobile the
  bottom padding is the bottom sheet's current height – peek, half or full – so a selected store
  is eased into the part of the map the sheet leaves free, with 24 px to spare). No animation when
  `prefers-reduced-motion: reduce`.
* User position: an HTML marker (18 px `--map-user` dot, 3 px white stroke, 6 px `--map-ring`
  halo, `pointer-events: none`) drawn **above** the store markers – a map layer was hidden under
  them, because the nearest store is usually next to the user – and a radius ring polygon
  (GeoJSON, 64-point circle, fill `--map-ring`, 1 px dashed outline). Title "Din placering".
* Stores: HTML markers (`maplibregl.Marker({ element })`), each a `<button>` 28 px (44 px hit
  area) with the chain fill, monogram and outline; `aria-label="{store name}, {chain},
  {distance}"` and, on `/madspild`, a count bubble ("5"). Selected: 36 px with a 3 px `--ink`
  ring; dimmed (filtered-out or not highlighted) markers 35 % opacity and `tabIndex=-1`.
  Stacking: nearer stores above farther ones (the DOM stays in distance order for the tab
  order), dimmed ones below, the selected one on top (above the user dot); the map container
  is `isolation: isolate`, so markers never cover the chips, the sheet or the map controls.
  Every chain dot and marker has a 1 px `--dot-ring` (dark in light mode, light in dark mode),
  so MENY's near-black and Netto's yellow stay visible on both map styles. The attribution has
  an opaque light background in both modes so it stays legible on the dark style.
  Expected counts are ≤ ~150 markers (5 km in central Copenhagen), well within HTML-marker
  performance.
* Interactions: tap/click marker → `onSelect(id)` (sheet/sidebar opens, URL `?butik=` updated
  with `router.replace`, map eases to keep the marker visible); tap empty map → deselect; Esc →
  deselect; "Centrér på mig" → refit the radius.
* Accessibility: the map container has `role="region"` and `aria-label="Kort over butikker"`;
  every marker is a focusable button in a logical (distance) order; the same stores are always
  available as a list (sheet/sidebar), which is the primary accessible path.
* States: loading – the container shows `--surface-2` with "Indlæser kort…"; style or tile
  error (`map.on('error')` before first `load`) – "Kortet kunne ikke indlæses. Butikkerne står i
  listen." and the list remains fully usable; no stores – "Ingen kendte butikker inden for {r}
  km." with "Skift afstand".
* Data: the page passes plain JSON (`{id, chainId, name, street, zip, city, lat, lon,
  distanceKm, foodWasteCount, cheaperCount, source, sourceStoreId}`) from server queries; the map
  never queries the database.

---

## 8. Data contract changes

One new migration (`0007`) recreates four `api` views with `CREATE OR REPLACE VIEW`, **appending**
columns at the end; all existing columns keep their names, types and order (Postgres requires
this for `CREATE OR REPLACE`). Grants are unchanged. The downgrade restores the 0001/0006
definitions (drop + create + grant, as in 0006). Architecture §7 must be updated in the same
change.

_Implemented by `pipeline/src/foodcatch/db/migrations/versions/0007_api_source_links_and_sizes.py`;
the column contract is pinned in `pipeline/tests/api_contract.py`._

### 8.1 `api.stores` (append after `lon`)

| Column | Type | Meaning | SQL source |
|---|---|---|---|
| `source` | `text` | where the store row comes from: `salling` or `tjek` (used to deduplicate chains present in both) | `s.source` |
| `source_store_id` | `text` | the store's id at that source (Tjek store id for the eTilbudsavis store page) | `s.source_store_id` |

### 8.2 `api.current_netto_deals` (append after `member_only`)

| Column | Type | Meaning | SQL source |
|---|---|---|---|
| `source` | `text` | listing source (`tjek` today) | `l.source` |
| `source_item_id` | `text` | Tjek offer id (eTilbudsavis `offer=` parameter) | `l.source_item_id` |
| `catalog_id` | `text` | Tjek catalog id (eTilbudsavis `publication=` parameter) | `l.catalog_id` |
| `size_min` | `numeric` | smallest pack size in `unit` | `l.size_min` |
| `size_max` | `numeric` | largest pack size in `unit` | `l.size_max` |
| `max_per_customer` | `integer` | purchase limit, if stated | `l.max_per_customer` |

### 8.3 `api.food_waste_near` (append after `is_exact`)

| Column | Type | Meaning | SQL source |
|---|---|---|---|
| `size` | `numeric` | net size parsed from the Salling name, in `unit`; null when the name states none | `l.size_min` |
| `image_url` | `text` | Salling product image; null for the placeholder and for any other host | `CASE WHEN l.extra ->> 'image' LIKE 'https://digitalassets.sallinggroup.com/%' AND l.extra ->> 'image' NOT LIKE '%/image' THEN l.extra ->> 'image' END` |
| `product_quantity_text` | `text` | pack size text from Open Food Facts | `p.quantity_text` |
| `product_net_quantity` | `numeric` | net quantity from Open Food Facts, in `product_net_unit` | `p.net_quantity` |
| `product_net_unit` | `text` | `kg`, `l` or `stk` | `p.net_unit` |
| `last_seen_at` | `timestamptz` | when the latest food-waste run last saw the clearance (stock snapshot time) | `l.last_seen_at` |

The view keeps `SELECT DISTINCT ON (l.id) … ORDER BY l.id, c.variant_index`; `p` is the existing
`LEFT JOIN public.product p`.

### 8.4 `api.class_price_history` (append after `member_only`)

| Column | Type | Meaning | SQL source |
|---|---|---|---|
| `source` | `text` | `tjek`, `rema` or `salling_food_waste` | `l.source` |
| `source_item_id` | `text` | Tjek offer id, Rema product id, or `{salling store}:{label ean}` | `l.source_item_id` |
| `catalog_id` | `text` | Tjek catalog id (null otherwise) | `l.catalog_id` |
| `store_id` | `uuid` | store of a food-waste clearance (null for chain-wide prices) | `l.store_id` |
| `price` | `numeric` | pack price | `l.price` |
| `description` | `text` | source description (Rema: size + brand, e.g. `400 GR. / REMA 1000`) | `l.description` |
| `size_min` | `numeric` | smallest pack size in `unit` | `l.size_min` |
| `size_max` | `numeric` | largest pack size in `unit` | `l.size_max` |

Reference details for deal cards are read from this view:
`SELECT DISTINCT ON (listing_id) listing_id, source, source_item_id, catalog_id, chain_id, price,
description, unit, size_min, size_max, valid_to FROM api.class_price_history WHERE listing_id =
ANY($1) ORDER BY listing_id`. `deal.references` (JSON) is unchanged.

No pipeline logic, table or verdict changes. Volume impact: none (views only).

---

## 9. Implementation notes

* New/changed pure modules (Vitest, Danish output asserted): `lib/format.ts`
  (`formatPackSize`, `displayTitle`, `formatEnd`), `lib/sources.ts` (`sourceLink`, slug map from
  `lib/chains.ts`), `lib/stores.ts` (`dedupeStores`, `storeDisplayName`, `nearestByChain`),
  `lib/deals.ts` (`groupByListing`, `verdictReason`, `cleanClassLabel` – drops attribute parts
  ending in "?"), `lib/location.ts` (`parseStoredLocation` for localStorage, shared with the
  restore action).
* New server queries: `getNearbyStores(area)`, `getNearestStoreOutside(area, chainId)`,
  `getReferenceDetails(listingIds)`, `getLatestRun(job)` (from `api.pipeline_status`).
* New server actions: `saveCoordinates` (not `useCoordinates`: a `use…` name reads as a React
  hook to readers and to the hooks lint rule), `restoreLocation`; `saveLocation` returns
  `{status, message, address, seq, location?}`.
* New dependency: `maplibre-gl@6.16.0` (exact version, as the other dependencies).
* Images: plain `<img>` (not `next/image`, which would proxy Salling's CDN). Requests go to
  Salling's image CDN, not the Salling API, so they do not touch the API quota.
* `vare` and `madspild` must have no horizontal page scroll at 390 px (tested with Playwright:
  `document.documentElement.scrollWidth <= innerWidth`).

**Later (not in this change):** keep Rema's `is_available_in_all_stores` in `listing.extra` and
show "Ikke i alle REMA 1000-butikker"; link Salling and Tjek ids of the same physical store in
the pipeline instead of deduplicating in the web; "Billigere her" for chains without a Netto
comparison.

---

## 10. Accessibility

* WCAG 2.2 AA: text contrast ≥ 4.5:1 (badges and chain monograms included), focus ring
  `--focus` 2 px on every interactive element, targets ≥ 44 px, no information by colour alone
  (glyphs on badges, monograms on chain dots).
* Landmarks: header, `nav` "Hovedmenu" (desktop) / "Faner" (tab bar), `main#indhold`, footer;
  skip link "Spring til indhold" (kept).
* Headings: one `h1` per page (the title), `h2` for groups/stores, `h3` for cards.
* Dialogs (location sheet, store sheet on mobile) trap focus, close on Esc, return focus.
* Live regions: location messages, "Gemt ✓", restore status.
* Prices: `tabular-nums`; struck-through "før"-prices also say "før" in text; the discount pill
  has a visually hidden "Rabat".
* `lang="da"`; `prefers-reduced-motion` disables map easing and sheet animations.

## 11. Acceptance checks

1. At 390×844 with the default location, `/` shows the location button, the segmented control
   and at least the first card's title, price, size and where-line without scrolling.
2. Every deal card shows a pack size or "Vægt ukendt", the nearest store of its chain with
   distance, and a working "Se tilbuddet i avisen" link that opens the exact offer.
3. Every Rema reference opens its product page; no food-waste item has a link other than the OFF
   weight link.
4. Save "Nørrebrogade 10, 2200 København N": the button shows it; reload – still shown; open the
   sheet – the input holds it; delete the cookie and reload – restored from localStorage within
   one refresh; "Glem" – gone in both.
5. `/kort` shows the user, the radius and coloured store markers with visible OpenFreeMap/OSM
   attribution; tapping a Netto store lists its food waste; tapping a REMA 1000 store lists
   "Billigere her end i Netto".
6. No horizontal page scroll on any page at 390 px; light and dark screenshots of every page at
   390×844 and 1440×900 reviewed.

---

## 12. All chains, item price history and food-waste sources (2026-11-19)

The owner asked for (1) "Ugens tilbud" from all chains, not only Netto, (2) a price history per
individual item and (3) for food waste an always-visible Open Food Facts link, a "Kilde" view and
a marker when a clearance also beats the other chains. Data: migration 0008 (architecture §7).
The visual system (§4) is unchanged.

### 12.1 `/` Tilbud for every chain

* Reads `api.current_deals` (`api.current_netto_deals` is no longer read by the web; `/kort`
  takes the Netto part of `api.current_deals` for "Billigere her end i Netto"). The verdict is
  the same function (`lib/verdict.ts`); the row's `target_unit_price_*` is passed as the
  verdict's `netto_*` input, which then means "the offer's own chain".
* Only offers of chains with a store within the radius are shown (`nearbyDeals`); a chain-wide
  leaflet is no use without a store nearby. The "no Netto nearby" notice is replaced by a warn
  notice when no chain with offers has a store within the radius: "Ingen af kæderne med tilbud
  har en butik inden for {r} km." + "Skift afstand".
* Title "Ugens tilbud". Under the segmented control: **chain chips** (`ChainChips`, links, so the
  view is shareable): "Alle kæder" then one chip per chain with offers in the current view
  (monogram dot + name + count, e.g. "Lidl 13"), nearest chain first, selected chains first.
  Each chip toggles its chain in `?kaede=`; selected chips are filled `--ink` and carry
  `aria-current="true"` and a hidden "(valgt)". Phones: one horizontally scrolling row (the chip
  is `position: relative`, so its hidden text cannot widen the page); desktop: wrapped.
* Groups as before; within a group: verdict, then unit price (per kg, then per l, then per piece,
  unknown last – prices in different units do not compare), then title.
* Card: the where line names the offer's chain and its nearest store; the member badge names
  that chain's membership ("Kræver Coop-medlem"; a marked good member price reads "Godt køb med
  Netto+" / "Godt køb for Coop-medlemmer" / "Godt køb for medlemmer"). The period line carries
  "**Prishistorik**" at the right (link to `/produkt/{product_key}`, 44 px target). History
  references read "Tidligere {chain}-tilbud" and reasons "Lidl havde den til … i et tidligere
  tilbud".
* "Sammenlign (n)" is a client component (`deals/Comparison.tsx`) that receives its rows as
  compact JSON and renders them only once opened: with ~250 offers the markup of every
  comparison would otherwise make the page several MB. Each comparison row ends with its source
  link and "Prishistorik" (the reference listing's `product_key`, from
  `api.class_price_history`); the list ends with "Prishistorik for varetypen →" (`/vare/…`).

### 12.2 `/produkt/[productKey]` Prishistorik for one item

* Data: `api.products` (label, chain, class, EAN) and `api.product_price_history` (every price
  of the item). The key is URL-encoded (`productPath`); `productKeyFromSegment` decodes it once
  (a decoded key always contains `:`).
* Header: title (the label, sentence case when the source shouts), meta "● {chain} · EAN {ean} ·
  {n} priser registreret", then links "Varetypen {class} i alle kæder →" (`/vare/…`) and, with an
  EAN, "Varen på Open Food Facts ↗".
* Segmented control "Pakkepris | Kilopris" (`?pris=enhed`; "Literpris"/"Stykpris" by unit),
  only when some row has a unit price. Default pack price: Salling's EAN normal price has a pack
  price only.
* Chart (`ProductPriceChart`, `lib/product.ts`): colour = chain (§4.3 fills, legend with
  monograms), shape = kind – regular shelf price a **step line** per chain (joined when the next
  price starts within two days), Salling's EAN normal price a **dashed step line**, offers
  **segments** over their period (a band for a unit-price range), clearances **points**. Every
  mark has a 1 px `--dot-ring` halo so Netto's yellow stays visible. A price without an end runs
  to the right edge; "i dag" is a dashed vertical line; the y axis has 8 % headroom. Default
  window one year; "Vis hele historikken (fra {date})" (`?periode=alt`) when older rows exist
  (REMA 1000 prices can go back years). `role="img"` with a summary (`chartSummary`) and a
  `<title>` per mark; the table is the accessible equivalent.
* Short history: except for `rema:` keys, when the history is under 60 days or has fewer than
  three prices: "Historik indsamles fra 18. nov. 2026." No chartable price: neutral notice "Ingen
  priser at vise i grafen".
* Table "Alle priser" (newest first; `<caption>` for screen readers), three columns that fit
  390 px: "Periode" · "Kæde og type" (chain, kind, store of a clearance, the listing title when it
  differs, source link) · "Pris" (pack price, size, unit price). A footnote explains "Normalpris
  ifølge Salling".
* `/vare/[classKey]` rows link "Prishistorik for varen" to `/produkt/…`, so the two pages link
  both ways.

### 12.3 Food waste: Open Food Facts, "Kilde" and competitor badge

* Below every item row, always visible (outside the `<details>`, so no link sits inside a
  `<summary>`): "Varen på Open Food Facts ↗" when the EAN is valid
  (`https://world.openfoodfacts.org/product/{ean}`, `openFoodFactsProductLink`) and
  "Prishistorik" (`/produkt/{product_key}`). Indented under the text from 640 px; on a phone the
  row starts at the image edge so both links fit on one line.
* Badge (good tone, ✓) under the meta line only when `beats_competitors` is true
  (`competitorBadge`): one chain and kind → "Billigere end REMA 1000s normalpris" / "Billigere end
  Lidls tilbud", one chain, several kinds → "Billigere end MENY", several chains → "Billigst
  blandt kæderne". Nothing when false or null.
* Expanded row, section "Kilde" (a definition list): "Pris nu" (newPrice), "Normalpris"
  (originalPrice), "Rabat" (Salling's percentDiscount, one decimal), "Hentet"
  (`source_fetched_at`), "Lager set" (`last_seen_at`), "EAN", "Varekode" (product code when it
  differs from the EAN), "Etiketkode" (`offer_ean`), "Butik" (name + Salling id), then "Fra
  Salling Groups madspildsdata – ingen vareside".
* Section "Sammenligning" when references exist and the clearance has a unit price: heading
  "Billigere end alle {n} priser på samme vare i andre kæder" (or "Samme vare i andre kæder"),
  "Her: {unit price}", and the references cheapest first (chain, kind, member tag, unit price).
  References count regardless of distance (architecture §6), the more conservative reading.

## 13. Meal ideas, "Madideer" (2026-11-19; replaced by §19 on 2026-11-20)

The owner's request: after choosing an address, suggest 2–5 lunches and 2–5 dinners from this
week's offers and the food waste nearby, what the cheap items cost and save, what the dish
costs, and the recipe on demand.

- Route `/madideer`, fourth tab "Madideer" (pot icon) between "Madspild" and "Kort". It uses the
  saved location like `/` and `/madspild`: offers of chains with a store within the radius
  (`nearbyDeals`) and clearances within the radius (`getFoodWasteNear`). Two sections,
  "Frokost" and "Aftensmad", with jump pills at the top. Breakfast is not a section: staples
  are on the offers page (§15).
- Ideas come from a **fixed catalogue** (`web/src/lib/recipes.ts`, ~30 dishes), not from a
  language model: deterministic, free, testable. Each dish has a meal, servings, ingredient
  slots (taxonomy type ids with the amount used, its unit and a rough normal-price estimate),
  pantry items (amount text and estimate) and the method. A **core** slot must be on offer or
  cleared for the dish to be suggested; other slots are filled when possible and otherwise
  listed under "Du skal også bruge".
- Which items may be used: clearances with a class; offers that are valid now, whose price
  applies (`price_applies`), that are not `cheaper_elsewhere`, and that are either `good_deal` or
  cheaper than the normal price. Per slot the item with the largest known saving wins (then the
  cheaper pack, then the nearer clearance); an item fills at most one slot of a dish.
- Saving per item, from our data only:
  - clearance: `reference_price − price` (Salling's price before the markdown);
  - offer: cheapest normal unit price of exactly the same class for this user (`regular` of a
    nearby chain, or `ean_reference`) × the offer's **smallest** pack − the offer price, at least
    0, in whole øre. No normal price → saving unknown (`null`), shown as "godt køb, normalpris
    ukendt" and as "+" after the dish total; it adds nothing to the total.
- Numbers per dish (a three-column summary): **"Indkøb"** – the cheap items as whole packs;
  **"Du sparer"** – the sum of known savings, and the percentage of the normal price of those
  items; **"Retten koster ca."** – an estimate: the used part of each cheap item (slot amount ×
  the item's unit price, at most the pack price; with an unknown unit price the slot's estimate,
  at most the pack price) plus the estimates of missing slots and pantry items, also per
  person. Estimates are never used for a saving.
- Selection per meal: dishes sorted by total known saving, then by filled slots, then by mixing
  offers and food waste; at most 5, each built around a **different main item** (its first core
  slot). Fewer than two in a section → a notice suggesting a larger radius; none at all → "Ingen
  madideer lige nu".
- Item rows: slot label, title, "Tilbud"/"Madspild" pill, price with the struck-through normal
  price ("normalt" / "før"), pack size, "spar X kr. (Y %)", the store as a Google Maps link
  (§14), member badge, the clearance's end, "Prishistorik" and the quiet leaflet link.
- "Vis opskrift" (`<details>`): ingredients with amounts ("billig nu" on the cheap ones) and
  numbered steps. A `<details>` at the bottom explains every number.

## 14. Categories, quiet sources and store links (2026-11-19)

- **Offers (`/`)**: when there is more than one product group, a row of pills
  (`CategoryOverview`) lists the groups with their counts and jumps to them; every group is a
  `<details open>` (`CollapsibleCategory`) that can be folded away.
- **Food waste (`/madspild`)**: pills "Alle" plus one per group filter the page
  (`?kategori=koed`, kept with `?sorter=`); the stores and the map follow the filter. In "Størst
  rabat" the list is split into foldable groups. Food-waste rows carry no group, so it comes from
  the taxonomy type of the class key (`lib/groups.ts`, a static map tested against the 39 types).
- **Leaflet link**: "Se tilbuddet i avisen" stays on every offer but is small and muted (micro
  text, muted ink, 14 px icon). It is there for the sceptical reader, not as a call to action.
- **Store → Google Maps**: a store opens in Google Maps in a new tab (`storeMapsLink`: the
  documented Maps URLs search, by name and address, or by coordinates without an address):
  "Maps ↗" next to the nearest store on offer cards, the store name on `/madspild` (next to the
  existing "Rute") and every store in a meal idea.

## 15. "Dine basisvarer" on the offers page (2026-11-19)

- At the top of `/`, under the title: the staples the user picked that are on offer or cleared
  nearby, per staple at most three offers (only `good_deal` and `undecided`, good deals
  first, then lowest unit price) and two clearances (largest discount), with "+N flere" and a line "Ikke på
  tilbud: …". The chain filter does not apply.
- Picker: "Vælg dine basisvarer" (open while nothing is picked) / "Skift basisvarer", a checkbox
  per staple and "Gem basisvarer". A server action (`saveStaples`) stores the ids in the cookie
  `fc_staples` for a year; no JavaScript needed.
- Suggested staples (`lib/staple-catalogue.ts`): æg, havregryn, mælk, skyr, yoghurt, A38/ymer,
  smør, ost, hytteost, kærnemælk. More through the search (§18).

## 16. "Søg vare" (2026-11-20)

- `/soeg` ("Søg" in the main navigation, the fifth tab on phones): a GET form (`q`, works without
  JavaScript). Every word (at most five, at least two characters in all) must occur in the
  item's name, case-insensitive (`lib/search.ts`).
- Hits are items (`api.products`, one per `product_key`) of every chain and kind, also outside
  the healthy staples: name, chain, latest price, pack size, unit price, kind and period, and
  "N priser →" linking to `/produkt/{key}`. Items with a current price come first, then the
  most recently priced; at most 60.
- Leaflet items with the same heading but another pack size are separate items (product key
  with size, migration 0010).

## 17. "Kommende tilbud" (2026-11-20)

- Offers whose leaflet is out but whose period starts later (`valid_from` after now; Tjek
  publishes catalogs days ahead, Rema campaigns are known in advance) leave the week's categories
  and get their own section "Kommende tilbud" at the end of `/`, one foldable group per
  Copenhagen start day ("Fra lør. 22. nov."), cheapest first (`groupUpcoming`).
- The filter applies: in "Gode køb" only upcoming good deals are listed, with the line "N af M er
  ikke dokumenteret gode køb (endnu). Se alle kommende" (verdicts of upcoming offers may still
  be pending). The counts on "Gode køb"/"Alle" are this week's offers only; the category
  overview gets a "Kommende (N)" link.

## 18. More staples through search (2026-11-20)

- Under the suggestions, "Find flere basisvarer" (client component `StapleSearch`) searches every
  other taxonomy type (`t:<type id>`, labels from `lib/taxonomy.json`, which a pipeline test keeps
  equal to `matching/taxonomy.py`) and offers "Følg “…” som fritekst" (`q:<text>`). A hit is a
  form posting to the `addStaple` server action; the picker stays open (`Disclosure`).
- Free-text staples match the names of **all** current and upcoming offers of nearby chains
  (`getOffersMatching`, `api.product_price_history`), also items the pipeline does not recognize
  (rugbrød, kaffe), shown with a neutral "Tilbud" badge and "uden prisdom". Type staples behave
  like the suggestions (verdicts, clearances).
- Staples added this way are listed first in the picker as ticked checkboxes; unticking and
  "Gem basisvarer" removes them. The cookie keeps the order, URI-encodes each id and holds at
  most 30 staples. Offers that have not started show "fra lør. 22. nov.".

## 19. Madideer as a catalogue and a meal plan (2026-11-20)

The owner's request: a clearer "Madideer" tab that starts with many dishes (name and price), lets
the user filter by time, money and store, opens a dish into its full shopping list with as many
prices as we have, marks basics expected at home, lets ingredients be ticked off, and saves
liked dishes. Then, inspired by meal-plan apps: pick days and dishes first, and only then ask
where to shop – the cheapest single store (recommended) or the cheapest total across stores.

### 19.1 Katalog (`/madideer`)

- Every recipe of `lib/recipes.ts` is shown (not only those with a cheap core item). Each recipe
  now has `minutes` (total time) and pantry items may be `basic` (oil, spices, onion, garlic,
  bouillon …).
- Filters (GET form, `lib/meal-filters.ts`, applied on change): "Måltid" (`maaltid`), "Tid"
  (`tid` ≤ 15/30/45/60 min), "Pris pr. person" (`pris` ≤ 10/15/20/30 kr.), "Butik du mest
  handler i" (`butik`, nearby chains: its items win a slot), "Alt fra én butik" (`kun=1`: only
  that chain, or without a chain the chain that saves the most per dish), "Kun gemte ♥"
  (`gemte=1`), "Sortér efter" (`sorter`: most saved, cheapest per person, quickest).
- Folded card: name, description, time · servings · meal, "ca. X kr. pr. pers.", "Spar Y kr.",
  chain dots and "n af m på tilbud", and a heart (cookie `fc_liked_recipes`, server action).
- Opened card: the three numbers, "Føj til madplan" (day select), "Indkøbsliste" with a
  checkbox per row ("Har jeg"): ingredients (chosen offer/clearance with all details, "Flere
  priser (n)" with every other cheap item, and the slot's normal-price estimate), "Også til
  retten", and "Basisvarer" pre-ticked. A live "Mangler n varer: ca. X kr." follows the ticks;
  ticks are kept per dish in localStorage (`fc_have:<id>`). Then "Sådan gør du".

### 19.2 Madplan (`/madideer/madplan`)

1. **Vælg dage** – chips for today and the next 13 days.
2. **Vælg retter** – per day a select of every dish with price per person and saving; dishes can
   be removed; at most four per day. Plan cookie `fc_meal_plan`
   (`YYYY-MM-DD=id.id|…`, past days dropped).
3. **Hvor vil du handle?** – every nearby chain with what the whole plan costs there, the
   cheapest marked "Anbefalet" and chosen by default; chains without a useful offer are one
   quiet line; and "Billigst i alt" across stores (`?butik=flere`).
4. **Indkøbsliste** – grouped by store, then "Ikke på tilbud", "Også til retterne" and
   "Basisvarer" (pre-ticked, not in the total), with the dishes each row is for.

Pricing (`lib/meal-plan.ts`): a cheap item is only used when the packs a dish needs cost no more
than the slot's normal-price estimate (otherwise buying it would raise the total); a cheap item
shared by dishes is bought in as many packs as their amounts need. Items not on offer are
priced with the same estimate in every chain, so the differences between stores come from
offers and food waste only.

## 20. Calmer pages, store popover, every chain (2026-11-20; structure replaced by §21)

The owner found the app too dense. Decisions, made for a student glancing at a phone in a shop:

* **One glance per card.** A deal card shows only the item, the price, size and unit price, the
  verdict badge and where to buy it. The reason, period, per-customer limit, variants,
  comparison, source and price-history links sit behind "Detaljer og sammenligning (n)". A
  clearance row keeps the price, discount, size, stock and end; the Open Food Facts and
  price-history links moved into its expanded panel.
* **Fewer controls before content.** The category pill row on `/` is gone (the category headings
  fold already). "Dine basisvarer" can be folded away, remembered in the `fc_staples_folded`
  cookie (so the server renders it folded, no flash), and a long list scrolls inside the box
  (max. 55 vh). With no staples picked it shows one sentence and a "Vælg dine basisvarer" button
  instead of the whole picker. On `/madideer` the filter form is folded into "Filtre og
  sortering" with the active count or current sort as its summary; a dish card shows its
  description only once opened.
* **The shelf-label voice.** The UI font is Archivo (variable, self-hosted in `app/fonts/`). Page
  titles and prices use the `shelf` utility: heavy (800) and condensed (72 % width), like the
  price on a shelf edge. It is the only display treatment; everything else stays quiet.
* **Store popover (`StoreInfo`).** Wherever an item is tied to a store or chain (deal cards,
  comparisons, staples, clearances, meal ideas, the meal-plan shopping list), the store name is
  a button: tap, long-press or hover shows the address and distance with "Åbn i Google Maps" and
  "Vis på kort"; for a chain-wide offer it lists the three nearest stores and links to all of
  them on the map. It uses the Popover API (top layer), so a scrolling list never clips it.
* **No chain is special.** `/kort` compares every chain's offers ("Billigere her end ugens
  tilbud", "Tilbud i {kæde}: …") and every store shows its own chain's good buys; the loading
  title, the price-history legend ("Tilbud", "Normalpris") and the badge defaults no longer
  assume Netto. Chain-specific facts (Netto+, Coop membership, eTilbudsavis slugs) stay as data.

## 21. Restructure around what the user wants (2026-11-20)

The owner's priorities, in order, and what each becomes:

| # | The user wants to … | Becomes |
|---|---|---|
| 1 | get a dinner idea fast by looking at cheap dinners | **Aftensmad** – the front page `/` |
| 2 | see cheap products to cook from | **Tilbud** – `/tilbud`, ingredients on offer, biggest saving first |
| 3 | keep an eye on their staples and save | **Mine varer** – `/mine-varer`, a watch list |
| 4 | search an item and see where it is cheapest | **Søg** – `/soeg`, cheapest current price first |

Navigation (phone tab bar and desktop header) follows that order: Aftensmad, Tilbud, Mine varer,
Søg, Kort. Food waste is a bonus, not a destination of its own: `/tilbud` shows the best
clearances nearby in a small "Madspild – en heldig bonus" block that links to `/madspild`.
Old addresses redirect (`/madideer` → `/`, `/madideer/madplan` → `/madplan`).

```
Phone, /                         Phone, /tilbud
┌──────────────────────────┐     ┌──────────────────────────┐
│ Aftensmad                │     │ Tilbud                   │
│ Billigst i aften         │     │ [Størst besparelse|Alle] │
│ ┌──────────────────────┐ │     │ [kæder …]                │
│ │ Lasagne      Spar 51 │ │     │ Kød                      │
│ │ 4 af 5 på tilbud     │ │     │ ┌──────────────────────┐ │
│ │ ● Netto  ● føtex     │ │     │ │ Hakket grisekød      │ │
│ └──────────────────────┘ │     │ │ 33,33 kr.  Spar 8,62 │ │
│ [Filtre og sortering ▾]  │     │ │ ● Netto Nørre V.     │ │
│ Alle retter …            │     │ └──────────────────────┘ │
│ Madplan for ugen →       │     │ Kommer snart …           │
└──────────────────────────┘     │ Madspild – heldig bonus  │
                                 └──────────────────────────┘
```

**Savings are the common language.** Every price the user can buy shows one `SavingTag`,
computed only from our data, never estimated:

* an offer: against the cheapest normal shelf price (`regular`, or Salling's `ean_reference`)
  of exactly the same product at a chain near the user, for the offer's smallest pack:
  "Spar 8,62 kr. (−20 %)"; "Ingen besparelse" when the normal price is not higher; "Normalpris
  ukendt" when we have none. The tag's tooltip/hidden text names the normal price and chain.
* a clearance: against Salling's price before the markdown.
* a dish: the sum of the known savings of the items on offer, "Spar 50,81 kr."; with no known
  saving it says so. The dish's price per person is an estimate (recipe amounts plus estimated
  normal prices for what is not on offer) and is always marked "skøn".

The verdict ("Godt køb", "Billigere andre steder") stays as the second, smaller signal: it
answers "is this the cheapest place near me", the saving answers "how much do I save".

**Upcoming offers are never hidden.** `/tilbud` ends with "Kommer snart", `/mine-varer` says
"På tilbud fra lør. 22. nov." for a staple, and search marks upcoming prices.

**Search compares like with like.** `/soeg` groups hits by exact class (items without an exact
class by name), so "Billigst nær dig" never compares hakket grisekød with hakket oksekød. Inside
a group, chains with a store near the user come first, then the lowest unit price; the unit
price is the big number (it is what "cheapest" compares) and the pack price sits next to the
size. A single price in a group is never called "cheapest". Upcoming offers come first ("Kommer
på tilbud"), expired prices are folded away.

On desktop the front page uses its side column for "Største besparelser lige nu": the offers
with the biggest known saving, to build a dish around.

## 23. Purchase price first, and real prices for every item (2026-11-21)

The owner: the purchase price matters most, then what the dish costs, especially for items the
dish does not use up. Extra items (potatoes, lasagne sheets, rice, basil …) must be priced like
the ingredients, from a shop, a leaflet or food waste, not estimated.

* **Two prices per item, from one real product** (`lib/pantry.ts`, `lib/dish-cost.ts`): the
  purchase price (the pack or packs that cover the amount; the smallest pack of a size range
  counts) and the portion price (the used amount at that product's unit price). A dish card shows
  "Indkøb …" first (what the items not expected at home cost at the till) and "Retten … · … pr.
  pers." below it. In the shopping list an item ticked as "har jeg" shows its portion price
  ("retten bruger") instead of the struck-through pack price; the sticky bar shows the purchase
  of what is left and the dish price.
* **Where prices come from**: an ingredient on offer or cleared keeps its item. Anything else is
  the cheapest current shelf price or offer of a chain with a store near the user
  (`api.product_price_history` / `api.class_price_history`, member prices excluded), or a
  clearance nearby. Ingredients are matched by taxonomy type; extra items by name with explicit
  words and exclusions per item (`PANTRY_SPECS`), so "ris" never finds "rismel" or "Paris" and
  "kartofler" never finds "kartoffelmos". Each found price links to its source (§22) and names
  the product, chain and pack.
* **Only when nothing is found** the recipe's estimate is used; the row says "Ingen pris i
  butikkerne nær dig – skøn" and every total that includes it says "ca.".
* **The meal plan** adds the amounts of all dishes before buying packs (2 × 300 g rice is one
  1 kg bag). A plan bought in one store only uses that chain's prices; otherwise the estimate.
* "Billigst indkøb" sorts by the real purchase price; the price filter uses the real price per
  person.

## 24. Every dish follows a real recipe (2026-11-21)

The owner: the linked recipe pages did not match the dishes shown. Now every dish in
`lib/recipes.ts` is taken from the one real recipe it links to:

* Ingredients and amounts, servings and time come from the source page (Valdemarsro, Arla,
  Mummum), read from the page's recipe markup (schema.org JSON-LD, microdata or Arla's recipe
  table). Nothing is added that the source does not list; water is left out; salt and pepper
  are one basic. Ingredients that are a known product type are slots in the type's unit
  (cans: 0,4 kg; tun: 0,185 kg per can); the rest are extra items, spelled like the price
  finder's items (`PANTRY_SPECS`) so their prices are found.
* The method keeps the source's order and content (times, temperatures, groups such as
  "Mornaysauce"), rewritten in our own words rather than copied.
* `minutes` is the realistic total: the source's time, or longer when its method says so
  (lasagne simmers at least 2 hours, pizza dough rises at least 6 hours).
* Where a link was a different dish, the dish now follows the link and takes its name
  ("Minestronesuppe", "Krydrede kyllingelår", "Alt i én gryde med kylling og rodfrugter",
  "Mørbradgryde med pølser, bacon og champignon"). Where it was a poor fit or missing, a real
  recipe was chosen: tacos → Valdemarsro "Tacoskåle med oksekød", pizza → "Pizza Margherita",
  and the four dishes without a source → "Røræg", "Kyllingesalat med æbler og bacon",
  "Hytteostsalat med blomkål" and "Marokkansk kyllingegryde". Ids are unchanged, so plans and
  likes keep working.
* Each dish has one core ingredient (the one it is built around).
* The meal plan's one-store choice now skips an item only when its unit price is above the
  normal estimate (a 500 g pack for a dish using 350 g is not "dearer": the normal price is a
  whole pack too).
