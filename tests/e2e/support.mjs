// The editor under test signs in for real (auth.js reads a Worker-style
// fragment) and talks to "GitHub" and "the Worker", both answered here by
// page.route: GitHub by the in-memory fake (dev/fake-github.js) seeded with
// the fixtures, the Worker by a small stand-in that rotates tokens.
import { expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createFakeGitHub } from "../../dev/fake-github.js";

const FIXTURES = new URL("../fixtures/site/", import.meta.url);
const WORKER = "https://site-editor-auth.thomaswhite.workers.dev";
export const USER = { login: "ThomasWCode", id: 172206513 };

function fixtureOrPlaceholder(path) {
  try {
    return readFileSync(new URL(path, FIXTURES), "utf8");
  } catch {
    return `(placeholder for ${path})\n`;
  }
}

export function readFixture(path) {
  return readFileSync(new URL(path, FIXTURES), "utf8");
}

export async function createFake(options = {}) {
  const files = new Map(
    readFileSync(new URL("FILES.txt", FIXTURES), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((path) => [path, fixtureOrPlaceholder(path)]),
  );
  return createFakeGitHub({ files, tokens: ["ghu_test"], ciReads: 1, workflowReads: 1, ...options });
}

const cors = (origin) => ({
  "access-control-allow-origin": origin || "*",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-github-api-version, accept",
  "access-control-expose-headers": "etag, x-ratelimit-remaining, x-ratelimit-reset, retry-after",
  vary: "Origin",
});

// The Worker's AI suggestions, as the stand-in answers them.
export const SUGGESTIONS = {
  commit: { title: "Add “Really.” to the homepage", body: "Home gains one word." },
  pr: { title: "Publish a word on Home and a Record fact", body: "One word on Home and a fact in the Record." },
};

// Routes GitHub and the Worker for one page. Returns the Worker's call log.
export async function connect(page, fake) {
  const worker = { refreshes: [], logouts: [], describes: [], nextToken: 2 };
  await page.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const origin = request.headers().origin;
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(origin) });
    const response = await fake.fetch(
      new Request(request.url(), { method: request.method(), headers: request.headers(), body: request.postData() ?? undefined }),
    );
    const headers = Object.fromEntries(response.headers);
    return route.fulfill({ status: response.status, headers: { ...headers, ...cors(origin) }, body: Buffer.from(await response.arrayBuffer()) });
  });
  await page.route(`${WORKER}/**`, async (route) => {
    const request = route.request();
    const origin = request.headers().origin;
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(origin) });
    const path = new URL(request.url()).pathname;
    const body = JSON.parse(request.postData() || "{}");
    if (path === "/refresh") {
      worker.refreshes.push(body);
      const token = `ghu_test${worker.nextToken}`;
      fake.acceptToken(token);
      worker.nextToken += 1;
      return route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", ...cors(origin) },
        body: JSON.stringify({
          access_token: token,
          expires_in: "28800",
          refresh_token: `ghr_test${worker.nextToken}`,
          refresh_token_expires_in: "15897600",
          login: USER.login,
          user_id: String(USER.id),
        }),
      });
    }
    if (path === "/logout") {
      worker.logouts.push(body);
      return route.fulfill({ status: 204, headers: cors(origin) });
    }
    if (path === "/describe") {
      worker.describes.push(body);
      return route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", ...cors(origin) },
        body: JSON.stringify(SUGGESTIONS[body.kind]),
      });
    }
    return route.fulfill({ status: 404, headers: cors(origin), body: "Not found" });
  });
  return worker;
}

export const SIGN_IN_FRAGMENT =
  "#access_token=ghu_test&expires_in=28800&refresh_token=ghr_test&refresh_token_expires_in=15897600&login=ThomasWCode&user_id=172206513";

// Signs in through the fragment and waits for the homepage to be editable.
// `beforeLoad(page)` can add routes that take precedence over the fake's.
export async function openEditor(page, fake, { beforeLoad = null } = {}) {
  const worker = await connect(page, fake);
  if (beforeLoad) await beforeLoad(page);
  await page.goto(`/${SIGN_IN_FRAGMENT}`);
  await expect(page.locator("#stage-title")).toHaveText("Home");
  await expect(frame(page).locator("h1")).toHaveText("Hi, I’m Tom.");
  await frameReady(page);
  return worker;
}

export const frame = (page) => page.frameLocator("#page-frame");

// The frame is ready at its load event, which waits for the site's CSS, fonts
// and images from the live site: slower than the default wait when several
// browsers fetch them at once.
export async function frameReady(page) {
  await expect(page.locator("#frame-wrap")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
}

// Clicks just after the last character of a block and types, as a person would.
export async function typeAtEnd(page, locator, text) {
  await locator.scrollIntoViewIfNeeded();
  const position = await locator.evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const lines = range.getClientRects();
    const last = lines[lines.length - 1];
    const box = element.getBoundingClientRect();
    return { x: Math.max(1, last.right - box.left - 1), y: last.top - box.top + last.height / 2 };
  });
  await locator.click({ position });
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

// Saves through the dialog and waits for the commit to finish (the Save
// button drops its count only once GitHub has accepted it).
export async function save(page) {
  await page.locator("#save-button").click();
  const dialog = page.locator("#save-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".dialog-actions .button--primary").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#save-button")).toHaveText("Save");
  await expect(page.locator("#status-line")).not.toHaveText("Working on GitHub…");
}
