import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The app runs locally against production data (ADR 0003); it must not listen on the network.
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

describe("package scripts", () => {
  it.each(["dev", "start"])("%s binds to the loopback interface only", (name) => {
    expect(pkg.scripts[name]).toMatch(/\s-H 127\.0\.0\.1(\s|$)/);
  });
});
