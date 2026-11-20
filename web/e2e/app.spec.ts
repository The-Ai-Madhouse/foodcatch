import { expect, test, type Locator, type Page } from "@playwright/test";

const STORAGE_KEY = "foodcatch.location.v1";
const SIZE = /\d+(?:,\d+)? (?:g|kg|ml|l|stk\.)|Vægt (?:ukendt|varierer)/;

const locationButton = (page: Page) => page.locator("header button[aria-haspopup=dialog]");

test.describe("location", () => {
  test("a saved location persists across reloads and is restored from localStorage", async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "one viewport is enough");
    const label = "Nørrebrogade 10, 2200 København N";
    // A backup in localStorage and no cookie: the app restores it (no geocoding involved).
    await page.addInitScript(
      ({ key, value }) => {
        if (!sessionStorage.getItem("seeded")) {
          localStorage.setItem(key, value);
          sessionStorage.setItem("seeded", "1");
        }
      },
      {
        key: STORAGE_KEY,
        value: JSON.stringify({
          lat: 55.6894,
          lon: 12.5541,
          label,
          r: 3,
          savedAt: "2026-11-18T12:00:00.000Z",
        }),
      },
    );
    await page.goto("/");
    await expect(locationButton(page)).toHaveAccessibleName(
      `Placering: ${label}, radius 3 km. Skift`,
    );

    // The cookie now holds it: a reload shows it straight away.
    await page.reload();
    await expect(locationButton(page)).toHaveAccessibleName(new RegExp(label));

    // The sheet shows the saved address and an input that is not empty.
    await locationButton(page).click();
    const dialog = page.getByRole("dialog", { name: "Din placering" });
    await expect(dialog.getByText(`Gemt: ${label}`)).toBeVisible();
    await expect(dialog.getByLabel("Adresse")).toHaveValue(label);

    // Changing only the radius keeps the address (the input is not cleared).
    await dialog.getByText("5 km", { exact: true }).click();
    await dialog.getByRole("button", { name: "Gem" }).click();
    await expect(page.getByRole("status").getByText("Gemt ✓")).toBeVisible();
    await expect(locationButton(page)).toHaveAccessibleName(
      `Placering: ${label}, radius 5 km. Skift`,
    );
    await locationButton(page).click();
    await expect(dialog.getByLabel("Adresse")).toHaveValue(label);

    // Without the cookie the backup brings it back.
    await context.clearCookies();
    await page.reload();
    await expect(locationButton(page)).toHaveAccessibleName(new RegExp(`${label}, radius 5 km`));

    // "Glem" removes it from both.
    await locationButton(page).click();
    await dialog.getByRole("button", { name: "Glem" }).click();
    await expect(dialog.getByText("Adressen er glemt.")).toBeVisible();
    await expect(locationButton(page)).toHaveAccessibleName(/ingen adresse valgt/);
    expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    await page.reload();
    await expect(locationButton(page)).toHaveAccessibleName(/ingen adresse valgt/);
  });

  test("“Brug min position” saves the browser's position", async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "one viewport is enough");
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 55.6763, longitude: 12.5681 });
    await page.goto("/");
    await locationButton(page).click();
    await page.getByRole("button", { name: "Brug min position" }).click();
    await expect(locationButton(page)).toHaveAccessibleName(/Placering: Min position/);
    await page.reload();
    await expect(locationButton(page)).toHaveAccessibleName(/Placering: Min position/);
    const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    expect(JSON.parse(stored ?? "{}")).toMatchObject({ label: "Min position", lat: 55.6763 });
  });
});

test("home shows where to buy each offer, its size and its source", async ({ page }) => {
  await page.goto("/?vis=alle&kaede=netto");
  const card = page.locator("article").first();
  await expect(card).toBeVisible();
  await expect(card).toContainText(/Nærmeste butik: Netto .+ · \d+(?:,\d)?\u00a0(?:m|km)/);
  await expect(card).toContainText(SIZE);
  const source = card.getByRole("link", { name: /Se tilbuddet i avisen/ });
  if ((await source.count()) > 0) {
    await expect(source).toHaveAttribute(
      "href",
      /^https:\/\/etilbudsavis\.dk\/Netto\?publication=[^&]+&offer=.+/,
    );
    await expect(source).toHaveAttribute("target", "_blank");
  }
  // Every card states a size (or says it is unknown).
  const cards = await page.locator("article").allInnerTexts();
  for (const text of cards) expect(text).toMatch(SIZE);
});

test("offers of every chain can be filtered by chain", async ({ page }) => {
  await page.goto("/?vis=alle");
  const chips = page.getByRole("navigation", { name: "Kæder" }).getByRole("link");
  await expect(chips.first()).toHaveText("Alle kæder");
  expect(await chips.count()).toBeGreaterThan(2); // "Alle kæder" and at least two chains
  // Offers of more than one chain are listed.
  const chains = await page
    .locator('article a[href^="/kort?kaede="]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(new Set(chains).size).toBeGreaterThan(1);

  const chip = chips.filter({ hasNotText: /Alle kæder|Netto/ }).first();
  const kaede = new URL((await chip.getAttribute("href")) ?? "", "http://x").searchParams.get(
    "kaede",
  );
  expect(kaede).toMatch(/^[a-z0-9]+$/);
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`[?&]kaede=${kaede}`));
  await expect(chips.filter({ has: page.locator('[aria-current="true"]') })).toHaveCount(0);
  await expect(page.locator(`nav[aria-label="Kæder"] a[aria-current="true"]`)).toHaveCount(1);
  // Every card is an offer of that chain (its where line opens the map filtered to it).
  const where = page.locator('article a[href^="/kort?kaede="]');
  await expect(where.first()).toBeVisible();
  for (const href of await where.evaluateAll((els) => els.map((e) => e.getAttribute("href")))) {
    expect(href).toBe(`/kort?kaede=${kaede}`);
  }
});

test("an offer links to its item's price history with a chart and a table", async ({ page }) => {
  await page.goto("/?vis=alle");
  const link = page.locator("article").getByRole("link", { name: "Prishistorik" }).first();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/produkt\/[^/]+$/);
  await link.click();
  await expect(page).toHaveURL(/\/produkt\//);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const chart = page.locator("figure svg[role=img]:visible");
  await expect(chart).toHaveAttribute("aria-label", /over tid fra/);
  expect(await chart.locator("path, line, circle, rect").count()).toBeGreaterThan(3);
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "Pris" })).toBeVisible();
  expect(await table.locator("tbody tr").count()).toBeGreaterThan(0);
});

test("the map renders store markers with attribution", async ({ page }) => {
  await page.goto("/kort");
  await expect(page.locator(".store-marker").first()).toBeAttached();
  expect(await page.locator(".store-marker").count()).toBeGreaterThan(0);
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("OpenStreetMap");
});

test("the nearest store's marker can be clicked and the sheet does not cover it", async ({
  page,
}, testInfo) => {
  await page.goto("/kort");
  // DOM order is distance order: the first marker is the nearest store, often next to others.
  const nearest = page.locator(".store-marker").first();
  await expect(nearest).toBeVisible();
  await nearest.click(); // a real pointer click: fails if a farther marker lies on top
  await expect(page).toHaveURL(/[?&]butik=/);
  await expect(nearest).toHaveAttribute("aria-pressed", "true");
  if (testInfo.project.name !== "mobile") return;
  // Phones: the map eases the selected marker into the part the bottom sheet leaves free.
  const sheet = page.locator("[data-fullscreen-map] > div > section");
  const sheetTop = (await sheet.boundingBox())?.y ?? 0;
  await expect
    .poll(async () => {
      const box = await nearest.boundingBox();
      return box ? box.y + box.height : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(sheetTop);
});

test("a food-waste item shows its store, weight and source", async ({ page }) => {
  await page.goto("/madspild");
  const group = page.locator("section[aria-labelledby^=butik-]").first();
  await expect(group.getByRole("heading", { level: 2 })).toContainText(/Netto|føtex|Bilka/);
  await expect(group.getByRole("link", { name: /Rute/ })).toHaveAttribute(
    "href",
    /google\.com\/maps\/dir/,
  );
  const row = group.locator("li").first();
  const item = row.locator("details");
  await expect(item).toContainText(SIZE);
  // Visible without expanding: the item on Open Food Facts (by EAN) and its price history.
  const off = row.getByRole("link", { name: /Varen på Open Food Facts/ });
  await expect(off).toBeVisible();
  await expect(off).toHaveAttribute("href", /^https:\/\/world\.openfoodfacts\.org\/product\/\d+$/);
  await expect(row.getByRole("link", { name: "Prishistorik" })).toHaveAttribute(
    "href",
    /^\/produkt\//,
  );
  // Expanded: the "Kilde" facts.
  await item.locator("summary").click();
  const source = item.getByRole("region", { name: "Kilde" });
  await expect(source).toContainText("Fra Salling Groups madspildsdata – ingen vareside");
  await expect(source).toContainText(/Hentet\s*\d+\./);
  await expect(source).toContainText("EAN");
});

test("a clearance cheaper than the other chains says so", async ({ page }) => {
  await page.goto("/madspild?sorter=rabat");
  const summary = page
    .locator("summary")
    .filter({ hasText: /Billigere end|Billigst blandt kæderne/ })
    .first();
  test.skip((await summary.count()) === 0, "no clearance beats the other chains right now");
  await summary.click();
  const item = summary.locator("xpath=..");
  await expect(item.getByRole("region", { name: "Sammenligning" })).toContainText("Billigere end");
});

test("meal ideas: catalogue, filters, shopping list and meal plan", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Madideer" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Madideer" })).toBeVisible();
  const main = page.locator("main");
  // A catalogue of every dish, with filters.
  await expect(main.getByLabel("Tid")).toBeVisible();
  await expect(main.getByLabel("Butik du mest handler i")).toBeVisible();
  const cards = main.locator("article");
  expect(await cards.count()).toBeGreaterThanOrEqual(20);
  const card = cards.first();
  await expect(card.getByText(/pr\. pers\./).first()).toBeVisible();
  // Open a dish: shopping list with ticks and the method.
  await card.locator("summary").first().click();
  await expect(card.getByRole("heading", { name: "Indkøbsliste" })).toBeVisible();
  await expect(card.getByText(/^Mangler \d+/)).toBeVisible();
  const box = card.locator('input[type="checkbox"]').first();
  await box.check();
  await expect(box).toBeChecked();
  await expect(card.getByRole("heading", { name: "Sådan gør du" })).toBeVisible();
  // Filters narrow the list.
  await main.getByLabel("Tid").selectOption("15");
  await expect(page).toHaveURL(/tid=15/);
  // Meal plan: pick a day and a dish, then a store.
  await main.getByRole("link", { name: /^Madplan/ }).click();
  await main.getByRole("button", { name: /^I morgen/ }).click();
  await main.getByLabel("Vælg ret").first().selectOption({ index: 1 });
  await main.getByRole("button", { name: "Tilføj" }).first().click();
  await expect(main.getByRole("heading", { name: "3. Hvor vil du handle?" })).toBeVisible();
  await expect(main.getByText("Anbefalet")).toBeVisible();
  await expect(main.getByRole("heading", { name: "4. Indkøbsliste" })).toBeVisible();
  await main.getByRole("button", { name: "Ryd madplanen" }).click();
});

/** Open the staples picker unless it is open already (it starts open while nothing is picked). */
async function openPicker(staples: Locator) {
  const picker = staples.locator("details").first();
  if ((await picker.getAttribute("open")) === null) await picker.locator("summary").click();
  await expect(picker).toHaveAttribute("open", "");
}

test("offers: staples picker and foldable categories", async ({ page }) => {
  await page.goto("/");
  const staples = page.getByRole("region", { name: "Dine basisvarer" });
  await openPicker(staples);
  await staples.getByLabel("Æg", { exact: true }).check();
  await staples.getByRole("button", { name: "Gem basisvarer" }).click();
  await expect(staples.getByRole("heading", { level: 3, name: /^Æg/ })).toBeVisible();

  const categories = page.getByRole("navigation", { name: "Kategorier" });
  await expect(categories.getByRole("link").first()).toBeVisible();
  const group = page.locator("details[id^=gruppe-]").first();
  await expect(group).toHaveAttribute("open", "");
  await group.locator(":scope > summary").click();
  await expect(group).not.toHaveAttribute("open", "");
});

test("offers: add a staple through the search and as free text", async ({ page }) => {
  await page.goto("/");
  const staples = page.getByRole("region", { name: "Dine basisvarer" });
  await openPicker(staples);
  const search = staples.getByLabel("Find flere basisvarer");
  await search.fill("kylling");
  await staples.getByRole("button", { name: /Kyllingebryst/ }).click();
  await expect(staples.getByRole("checkbox", { name: /Kyllingebryst/ })).toBeChecked();
  await search.fill("danbo");
  await staples.getByRole("button", { name: /Følg “danbo” som fritekst/ }).click();
  await expect(
    staples.getByRole("heading", { level: 3, name: /^Danbo.*uden prisdom/ }),
  ).toBeVisible();
  // Unticking and saving removes it again.
  await staples.getByRole("checkbox", { name: /Danbo/ }).uncheck();
  await staples.getByRole("button", { name: "Gem basisvarer" }).click();
  await expect(staples.getByRole("heading", { level: 3, name: /^Danbo/ })).toHaveCount(0);
});

test("offers: upcoming offers have their own section", async ({ page }) => {
  await page.goto("/?vis=alle");
  const upcoming = page.getByRole("region", { name: "Kommende tilbud" });
  await expect(upcoming.locator("details[id^=kommende-]").first()).toBeVisible();
  await expect(upcoming.getByText(/^Fra /).first()).toBeVisible();
});

test("search: find an item and open its price history", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Søg" }).first().click();
  await expect(page).toHaveURL(/\/soeg$/);
  await page.getByRole("searchbox", { name: "Varenavn" }).fill("hakket grisekød");
  await page.getByRole("button", { name: "Søg", exact: true }).click();
  await expect(page).toHaveURL(/q=hakket\+grisek/);
  const first = page.locator('a[href^="/produkt/"]').first();
  await expect(first).toContainText(/pris(er)? →/);
  await first.click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Hakket grisekød/i);
});

test("food waste: filter by category", async ({ page }) => {
  await page.goto("/madspild");
  const categories = page.getByRole("navigation", { name: "Kategorier" });
  await categories.getByRole("link", { name: /^Mejeri/ }).click();
  await expect(page).toHaveURL(/kategori=mejeri/);
  await expect(categories.getByRole("link", { name: /^Mejeri/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("no horizontal page scroll on phones", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "phone layout only");
  await page.goto("/");
  const productHref = await page.locator('a[href^="/produkt/"]').first().getAttribute("href");
  await page.locator("summary", { hasText: "Sammenlign" }).first().click();
  const classLink = page.locator('a[href^="/vare/"]').first();
  const href = await classLink.getAttribute("href");
  for (const path of [
    "/",
    "/madspild",
    "/madspild?sorter=rabat",
    "/madideer",
    "/kort",
    "/soeg?q=hakket",
    "/status",
    href ?? "/",
    productHref ?? "/",
  ]) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
