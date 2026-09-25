import { expect, test } from "@playwright/test";
import { createFake, frame, openEditor, readFixture, save, typeAtEnd } from "./support.mjs";

const treeWrites = (fake) => fake.requests.filter((request) => request.method === "POST" && request.path === "/git/trees");

async function openPage(page, label) {
  await page.locator("#page-list .file-link", { hasText: label }).first().click();
  await expect(page.locator("#stage-title")).toHaveText(label);
  await expect(page.locator("#frame-wrap")).toHaveAttribute("data-ready", "true");
}

test("signs in from the Worker's fragment and clears it from the address bar", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await expect(page).toHaveURL("http://127.0.0.1:4174/");
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem("siteEditor.session.v1")));
  expect(session).toMatchObject({ login: "ThomasWCode", userId: 172206513, accessToken: "ghu_test", refreshToken: "ghr_test" });
  await expect(page.locator("#account-summary")).toHaveText("ThomasWCode");
});

test("lists the pages in the site's order, then the record and the blog sources", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  const labels = page.locator("#page-list .file-link-label");
  await expect(labels).toHaveCount(18);
  await expect(labels.nth(0)).toHaveText("Home");
  await expect(labels.nth(1)).toHaveText("Programming");
  await expect(labels.nth(2)).toHaveText("Physics & Ideas");
  await expect(labels.last()).toHaveText("Gravatar");
  await expect(page.locator("#record-list .file-link-label")).toHaveText(["Record"]);
  await expect(page.locator("#blog-source-list .file-link-label")).toHaveText(["bridging-the-gap", "how-this-site-works"]);
});

test("typing in a paragraph and saving commits exactly that line", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  const paragraph = frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." });
  await typeAtEnd(page, paragraph, " Really.");
  await page.keyboard.press("Enter");
  await expect(paragraph).not.toHaveAttribute("contenteditable", "true");
  await expect(page.locator("#save-button")).toHaveText("Save (1)");
  await save(page);
  await expect(page.locator("#status-line")).toContainText("1 file differs from main");

  const [tree] = treeWrites(fake);
  expect(tree.body.tree).toHaveLength(1);
  expect(tree.body.tree[0]).toMatchObject({ path: "index.html", mode: "100644", type: "blob" });
  expect(tree.body.tree[0].content).toBe(
    readFixture("index.html").replace("<p>Pick whatever sounds a bit interesting.</p>", "<p>Pick whatever sounds a bit interesting. Really.</p>"),
  );
  const commit = fake.requests.find((request) => request.method === "POST" && request.path === "/git/commits");
  expect(commit.body.message).toBe("Edit 1 file in the editor\n\n- index.html\n");
  const ref = fake.requests.find((request) => request.method === "PATCH" && request.path === "/git/refs/heads/edits");
  expect(ref.body.force).toBe(false);
  expect(fake.checkRuns()).toHaveLength(0);
});

test("formatting keys, line breaks and pasted markup never reach the page", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  const paragraph = frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." });
  await typeAtEnd(page, paragraph, " A");
  await page.keyboard.press("Control+B");
  await page.keyboard.type("B");
  await paragraph.evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "C\nD");
    data.setData("text/html", "<b>C</b><br>D");
    element.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertFromPaste", dataTransfer: data, bubbles: true, cancelable: true }));
  });
  expect(await paragraph.evaluate((element) => element.innerHTML)).toBe("Pick whatever sounds a bit interesting. ABC D");
  // Shift+Enter finishes the block like Enter, without a line break.
  await page.keyboard.press("Shift+Enter");
  await expect(paragraph).not.toHaveAttribute("contenteditable", "true");
  expect(await paragraph.evaluate((element) => element.innerHTML)).toBe("Pick whatever sounds a bit interesting. ABC D");
  await save(page);
  expect(treeWrites(fake)[0].body.tree[0].content).toContain("<p>Pick whatever sounds a bit interesting. ABC D</p>");
});

test("a draft note's Done removes only its draft markers", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await openPage(page, "Programming");
  const note = frame(page).locator("p.draft-note", { hasText: "Two or three screenshots" });
  await note.click();
  await page.locator(".edit-toolbar button", { hasText: "Done" }).click();
  await page.locator("#confirm-dialog .button--primary").click();
  await expect(frame(page).locator("p", { hasText: "Two or three screenshots" })).not.toHaveClass(/draft-note/);
  await save(page);
  const content = treeWrites(fake)[0].body.tree[0].content;
  const before = readFixture("programming.html");
  expect(content).toBe(
    before.replace('<p class="draft-note" data-draft>\n                Two or three screenshots', "<p>\n                Two or three screenshots"),
  );
});

test("+ adds a paragraph after the selected one, ready to be typed over", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." }).click();
  await page.locator(".edit-toolbar button", { hasText: "+" }).click();
  const added = frame(page).locator("p", { hasText: "New paragraph" });
  await expect(added).toHaveAttribute("contenteditable", "true");
  await page.keyboard.type("Hello there.");
  await page.keyboard.press("Enter");
  await save(page);
  expect(treeWrites(fake)[0].body.tree[0].content).toContain(
    "<p>Pick whatever sounds a bit interesting.</p>\n            <p>Hello there.</p>\n",
  );
});

test("the Record tab edits docs/record.md as plain text", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await page.locator("#record-list .file-link").click();
  const editor = page.locator("#markdown-editor");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(readFixture("docs/record.md"));
  await editor.press("Control+End");
  await editor.type("- A new fact.\n");
  await save(page);
  const [tree] = treeWrites(fake);
  expect(tree.body.tree[0].path).toBe("docs/record.md");
  expect(tree.body.tree[0].content).toBe(`${readFixture("docs/record.md")}- A new fact.\n`);
});

test("Publish opens the pull request, waits for green checks, then merges and deletes edits", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await openPage(page, "Physics & Ideas");
  await typeAtEnd(page, frame(page).locator("p.eyebrow", { hasText: "Thinking about things" }), " (and stuff)");
  await page.keyboard.press("Enter");
  await save(page);

  await page.locator("#publish-button").click();
  const dialog = page.locator("#publish-dialog");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByRole("link", { name: /#1 Text edits from the editor/ })).toBeVisible();
  const merge = dialog.getByRole("button", { name: "Merge", exact: true });
  expect(fake.pulls()).toHaveLength(1);
  expect(fake.requests.filter((request) => request.path.includes("dispatches"))).toHaveLength(0);
  await expect(merge).toBeDisabled();
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(merge).toBeEnabled();
  await merge.click();
  await expect(dialog).toContainText("Merged.");
  expect(fake.head("edits")).toBeNull();
  expect(fake.fileAt("main", "physics.html")).toContain("Thinking about things (and stuff)");
  expect(fake.commit(fake.head("main")).parents).toHaveLength(2);
});

test("a baseline bot commit does not block a save; another device's edit to the page does", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  const paragraph = frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." });
  await typeAtEnd(page, paragraph, " One.");
  await page.keyboard.press("Enter");
  await save(page);

  await fake.commitAs("edits", { "tests/visual/home.png": "pixels" }, { bot: true });
  await typeAtEnd(page, paragraph, " Two.");
  await page.keyboard.press("Enter");
  await save(page);
  expect(fake.fileAt("edits", "index.html")).toContain("interesting. One. Two.</p>");
  expect(fake.fileAt("edits", "tests/visual/home.png")).toBe("pixels");

  await fake.commitAs("edits", { "index.html": `${fake.fileAt("edits", "index.html")}<!-- elsewhere -->\n` });
  await typeAtEnd(page, paragraph, " Three.");
  await page.keyboard.press("Enter");
  await page.locator("#save-button").click();
  await page.locator("#save-dialog .dialog-actions .button--primary").click();
  const conflict = page.locator("#confirm-dialog");
  await expect(conflict).toContainText("index.html changed on GitHub");
  await conflict.getByRole("button", { name: "Reload those files" }).click();
  await expect(frame(page).locator("p", { hasText: "Pick whatever" })).toHaveText("Pick whatever sounds a bit interesting. One. Two.");
  expect(fake.fileAt("edits", "index.html")).toContain("<!-- elsewhere -->");
});

test("locked parts refuse editing and say why", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  const heading = frame(page).locator("h1");
  await heading.click();
  await expect(heading).not.toHaveAttribute("contenteditable", "true");
  await expect(page.locator("#panel")).toContainText("status-page monitor");
  await frame(page).locator(".site-footer").click();
  await expect(page.locator("#panel")).toContainText("Header and footer");

  await openPage(page, "CV");
  await expect(page.locator("#panel")).toContainText("Read-only");
  await frame(page).locator("main p").first().click();
  await expect(frame(page).locator("[contenteditable]")).toHaveCount(0);
});

test("an expired token is refreshed through the Worker and the request retried", async ({ page }) => {
  const fake = await createFake();
  const worker = await openEditor(page, fake);
  await typeAtEnd(page, frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." }), " Yes.");
  await page.keyboard.press("Enter");
  fake.revokeToken("ghu_test");
  await save(page);
  expect(worker.refreshes).toEqual([{ refresh_token: "ghr_test" }]);
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem("siteEditor.session.v1")));
  expect(session.accessToken).toBe("ghu_test2");
  expect(fake.fileAt("edits", "index.html")).toContain("interesting. Yes.</p>");
});

test("Sign out revokes the token through the Worker and shows the sign-in screen", async ({ page }) => {
  const fake = await createFake();
  const worker = await openEditor(page, fake);
  await page.locator("#account-summary").click();
  await page.locator("#sign-out-button").click();
  await expect(page.locator("#signin-view")).toBeVisible();
  await expect(page.locator("#signin-message")).toHaveText("Signed out.");
  expect(worker.logouts).toEqual([{ access_token: "ghu_test", everywhere: false }]);
  expect(await page.evaluate(() => localStorage.getItem("siteEditor.session.v1"))).toBeNull();
});

test("unsaved edits survive a reload, and the phone preview is 390 pixels wide", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await typeAtEnd(page, frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." }), " Kept.");
  await page.keyboard.press("Enter");
  await page.reload();
  await expect(frame(page).locator("p", { hasText: "Pick whatever" })).toHaveText("Pick whatever sounds a bit interesting. Kept.");
  await expect(page.locator("#save-button")).toHaveText("Save (1)");

  await page.getByRole("button", { name: "Phone", exact: true }).click();
  await expect(page.locator("#frame-wrap")).toHaveAttribute("data-width", "phone");
  expect(Math.round((await page.locator("#page-frame").boundingBox()).width)).toBeLessThanOrEqual(390);
});
