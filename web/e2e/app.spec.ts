import { expect, test, type Page } from "@playwright/test";

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
  await page.goto("/?vis=alle");
  const card = page.locator("article").first();
  await expect(card).toBeVisible();
  await expect(card).toContainText(/Netto · nærmest .+ \d+(?:,\d)? (?:m|km)/);
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

test("the map renders store markers with attribution", async ({ page }) => {
  await page.goto("/kort");
  await expect(page.locator(".store-marker").first()).toBeAttached();
  expect(await page.locator(".store-marker").count()).toBeGreaterThan(0);
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("OpenStreetMap");
});

test("a food-waste item shows its store, weight and source", async ({ page }) => {
  await page.goto("/madspild");
  const group = page.locator("section[aria-labelledby^=butik-]").first();
  await expect(group.getByRole("heading", { level: 2 })).toContainText(/Netto|føtex|Bilka/);
  await expect(group.getByRole("link", { name: /Rute/ })).toHaveAttribute(
    "href",
    /google\.com\/maps\/dir/,
  );
  const item = group.locator("details").first();
  await expect(item).toContainText(SIZE);
  await item.locator("summary").click();
  await expect(item).toContainText("Fra Salling Groups madspildsdata – ingen vareside");
  const off = item.getByRole("link", { name: /Open Food Facts/ });
  if ((await off.count()) > 0) {
    await expect(off).toHaveAttribute("href", /^https:\/\/world\.openfoodfacts\.org\/product\//);
  }
});

test("no horizontal page scroll on phones", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "phone layout only");
  await page.goto("/");
  const classLink = page.locator('a[href^="/vare/"]').first();
  const href = await classLink.getAttribute("href");
  for (const path of [
    "/",
    "/madspild",
    "/madspild?sorter=rabat",
    "/kort",
    "/status",
    href ?? "/",
  ]) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
