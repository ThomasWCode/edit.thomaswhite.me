// Finding 5 of the data-safety audit (docs/audits/2026-09-27-merge-safety.md):
// `edits` is never deleted, only moved up to main. An `edits` holding nothing
// main lacks (at main, or behind it as a pull request merged on GitHub leaves
// it) must look and behave in the editor exactly as no `edits` branch does.
import { expect, test } from "@playwright/test";
import { createFake, frame, openEditor, save, typeAtEnd } from "./support.mjs";

const API = "https://api.github.com/repos/ThomasWCode/ThomasWCode.github.io-revised";

async function createEdits(fake) {
  const response = await fake.fetch(
    new Request(`${API}/git/refs`, {
      method: "POST",
      headers: { Authorization: "Bearer ghu_test", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "refs/heads/edits", sha: fake.head("main") }),
    }),
  );
  expect(response.status).toBe(201);
}

// What the editor shows: the top bar, the file list, the side panel and the page.
const view = (page) =>
  page.evaluate(() => ({
    status: document.querySelector("#status-line").textContent,
    save: [document.querySelector("#save-button").textContent, document.querySelector("#save-button").disabled],
    publish: document.querySelector("#publish-button").disabled,
    files: document.querySelector("#sidebar").innerText,
    panel: document.querySelector("#panel").innerText,
    page: document.querySelector("#page-frame").contentDocument.querySelector("main").innerText,
  }));

// The view once the pages loading in the background (titles, draft counts)
// have all arrived: the same on three reads in a row.
async function settledView(page) {
  let last = null;
  for (let same = 0; same < 3; ) {
    await page.waitForTimeout(300);
    const next = JSON.stringify(await view(page));
    same = next === last ? same + 1 : 0;
    last = next;
  }
  return JSON.parse(last);
}

test("an edits branch holding nothing main lacks behaves in the editor exactly as no edits branch", async ({ browser, baseURL, viewport }) => {
  const seen = {};
  for (const kind of ["no edits", "edits at main", "edits behind main"]) {
    const fake = await createFake();
    const moveMain = () => fake.commitAs("main", { "docs/record.md": `${fake.fileAt("main", "docs/record.md")}\n- A fact from a Claude session.\n` });
    if (kind === "edits at main") await moveMain();
    if (kind !== "no edits") await createEdits(fake);
    if (kind !== "edits at main") await moveMain();
    const context = await browser.newContext({ baseURL, viewport });
    const page = await context.newPage();
    await openEditor(page, fake);
    await expect(page.locator("#status-line")).toHaveText("Editing ThomasWCode/ThomasWCode.github.io-revised.");
    const opened = await settledView(page);

    const main = fake.head("main");
    await typeAtEnd(page, frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." }), " Hello.");
    await page.keyboard.press("Enter");
    await save(page);
    const saved = await settledView(page);
    seen[kind] = { opened, saved };

    if (kind !== "no edits") expect(fake.requests.filter((request) => request.method === "PATCH" && request.path === "/git/refs/heads/edits").length).toBeGreaterThan(0);
    expect(fake.commit(fake.head("edits")).parents, `${kind}: the save starts from main's head`).toEqual([main]);
    expect(fake.fileAt("edits", "docs/record.md")).toContain("A fact from a Claude session.");
    expect(fake.fileAt("edits", "index.html")).toContain("interesting. Hello.</p>");
    expect(fake.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
    await context.close();
  }
  expect(seen["edits at main"]).toEqual(seen["no edits"]);
  expect(seen["edits behind main"]).toEqual(seen["no edits"]);
});
