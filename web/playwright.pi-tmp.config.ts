import base from "./playwright.config";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  ...base,
  timeout: 240_000,
  expect: { timeout: 60_000 },
  use: { ...base.use, channel: undefined, launchOptions: { executablePath: "/usr/bin/chromium" } },
  projects: base.projects?.map((p) => ({ ...p, use: { ...p.use, channel: undefined } })),
});
