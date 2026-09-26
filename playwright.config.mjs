import { defineConfig, devices } from "@playwright/test";

// `npm run test:e2e` runs Chromium (as CI does); `npm run test:e2e:all` adds
// Firefox and WebKit, which check the editing behaviour the design depends on
// in every engine (docs/how-it-works.md, "Browser behaviour checked").
const viewport = { width: 1366, height: 860 };

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/serve.mjs",
    url: "http://127.0.0.1:4174/",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport } },
  ],
});
