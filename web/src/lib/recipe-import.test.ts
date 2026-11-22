import { describe, expect, it } from "vitest";
import { matchIngredient, parseIngredientLine, usuallyAtHome } from "./ingredient-match";
import type { BuyableProduct } from "./pantry";
import { isPrivateAddress } from "./private-address";
import { decodeEntities, extractRecipe, looksLikeBotCheck } from "./recipe-import";
import { quoteRecipe, type RecipeItem } from "./recipe-pricing";

describe("extractRecipe", () => {
  it("reads schema.org JSON-LD, also inside @graph", () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"WebPage"},{"@type":"Recipe","name":"Kulmule med ris","recipeYield":"2 portioner",
      "recipeIngredient":["250 g Kulmule","1 pose Koriander","½ stk Mango"]}]}</script>`;
    expect(extractRecipe(html)).toEqual({
      title: "Kulmule med ris",
      servings: 2,
      ingredients: ["250 g Kulmule", "1 pose Koriander", "½ stk Mango"],
      via: "json-ld",
    });
  });

  it("reads microdata and WP Recipe Maker lists", () => {
    const micro = `<title>Lasagne - opskrift | Site</title><span itemprop="recipeYield">4</span>
      <ul><li itemprop="recipeIngredient">400 g hakket oksekød</li><li itemprop="recipeIngredient">2 løg, finthakket</li></ul>`;
    expect(extractRecipe(micro)).toMatchObject({
      title: "Lasagne",
      servings: 4,
      ingredients: ["400 g hakket oksekød", "2 løg, finthakket"],
      via: "microdata",
    });
    const wprm = `<h1>Boller</h1><li class="wprm-recipe-ingredient"><span>50</span> <span>g</span> gær</li>
      <li class="wprm-recipe-ingredient">5 dl vand</li>`;
    expect(extractRecipe(wprm)).toMatchObject({
      ingredients: ["50 g gær", "5 dl vand"],
      via: "plugin",
    });
  });

  it("finds the list under an 'Ingredienser' heading on any page, up to the method", () => {
    const html = `<h1>Lasagne</h1><p>Til 4 personer</p><h2>Ingredienser</h2><ul><li>500 g hakket oksekød</li>
      <li>1 &frac12; dl m&aelig;lk</li></ul><h2>Fremgangsmåde</h2><ul><li>Brun kødet</li></ul>`;
    expect(extractRecipe(html)).toEqual({
      title: "Lasagne",
      servings: 4,
      ingredients: ["500 g hakket oksekød", "1 ½ dl mælk"],
      via: "list",
    });
  });

  it("returns null without an ingredient list, and spots bot checks", () => {
    expect(extractRecipe("<html><h1>Om os</h1><p>Hej</p></html>")).toBeNull();
    expect(looksLikeBotCheck("<title>Making sure you're not a bot!</title>")).toBe(true);
    expect(decodeEntities("K&#xF8;d &amp; &#248;l")).toBe("Kød & øl");
  });
});

describe("parseIngredientLine and matchIngredient", () => {
  const read = (line: string) => {
    const p = parseIngredientLine(line);
    return { ...p, match: matchIngredient(p.name, p.phrase) };
  };
  it("reads amounts, units and names", () => {
    expect(read("400 g hakket oksekød")).toMatchObject({
      amountText: "400 g",
      need: { amount: 0.4, unit: "kg" },
      match: { kind: "type", types: ["hakket_oksekød"] },
    });
    expect(read("2 dåser Hakkede tomater (ca. 800 g)")).toMatchObject({
      need: { amount: 0.8, unit: "kg" },
      match: { kind: "type", types: ["hakkede_tomater"] },
    });
    expect(read("1½ dl mælk")).toMatchObject({
      need: { amount: 0.15, unit: "l" },
      match: { kind: "type" },
    });
    expect(read("2 løg, finthakket")).toMatchObject({
      name: "løg",
      match: { kind: "spec", specName: "løg" },
    });
    expect(read("300 g basmatiris").match).toMatchObject({ kind: "spec", specName: "ris" });
    expect(read("250 g Kulmule").match).toMatchObject({ kind: "text", label: "kulmule" });
    expect(read("400 ml kokosmælk").match.kind).toBe("text");
    expect(read("salt og friskkværnet peber")).toMatchObject({ amountText: null, need: null });
    expect(usuallyAtHome(read("2 spsk. olivenolie").name)).toBe(true);
    expect(usuallyAtHome(read("250 g Kulmule").name)).toBe(false);
  });
});

describe("quoteRecipe", () => {
  const product = (o: Partial<BuyableProduct>): BuyableProduct => ({
    key: o.key ?? "k",
    label: "X",
    chainId: "netto",
    classKey: null,
    kind: "regular",
    price: 10,
    unit: "kg",
    sizeMin: 1,
    sizeMax: 1,
    source: "tjek",
    sourceItemId: null,
    catalogId: null,
    validTo: null,
    ean: null,
    ...o,
  });
  const item = (id: string, line: string): RecipeItem => {
    const parsed = parseIngredientLine(line);
    return { id, parsed, match: matchIngredient(parsed.name, parsed.phrase) };
  };
  it("prices each store, orders by coverage then price, and combines the cheapest", () => {
    const items = [
      item("a", "500 g hakket oksekød"),
      item("b", "1 kg kartofler"),
      item("c", "250 g kulmule"),
    ];
    const products = [
      product({
        key: "n1",
        chainId: "netto",
        label: "Hakket oksekød 8-12%",
        classKey: "hakket_oksekød|x",
        price: 35,
        sizeMin: 0.5,
        sizeMax: 0.5,
      }),
      product({
        key: "n2",
        chainId: "netto",
        label: "Kartofler 2 kg",
        price: 20,
        sizeMin: 2,
        sizeMax: 2,
      }),
      product({
        key: "r1",
        chainId: "rema1000",
        label: "Hakket oksekød 8-12%",
        classKey: "hakket_oksekød|x",
        price: 30,
        sizeMin: 0.5,
        sizeMax: 0.5,
      }),
      product({ key: "r2", chainId: "rema1000", label: "Kartofler", price: 12 }),
      product({
        key: "r3",
        chainId: "rema1000",
        label: "Kulmule filet",
        price: 40,
        sizeMin: 0.4,
        sizeMax: 0.4,
      }),
    ];
    const { stores, combined } = quoteRecipe(items, products, ["netto", "rema1000"]);
    expect(stores.map((s) => [s.chainId, s.totalKr, s.missing])).toEqual([
      ["rema1000", 82, 0],
      ["netto", 55, 1],
    ]);
    expect(combined.totalKr).toBe(82);
    expect(combined.chains).toEqual(["rema1000"]);
  });
});

describe("isPrivateAddress", () => {
  it("blocks this machine and private networks", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.10",
      "172.20.0.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("185.21.42.131")).toBe(false);
  });
});
