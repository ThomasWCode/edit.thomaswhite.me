import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// The audit's browser scenarios (findings 1 and 3), against the fake GitHub
// through the editor's own e2e support. Run from the repository root:
//   npx playwright test --config=docs/audits/2026-09-27-merge-safety/playwright.config.mjs
// CHROMIUM_PATH points at another Chromium when Playwright's own is missing.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: "node scripts/serve.mjs",
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    url: "http://127.0.0.1:4174/",
    reuseExistingServer: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 860 } } }],
});
