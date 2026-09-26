import { expect, test } from "@playwright/test";
import { gitBlobSha } from "../../src/github-client.js";
import { createFake, frame, frameReady, openEditor, readFixture, save, typeAtEnd } from "./support.mjs";

const treeWrites = (fake) => fake.requests.filter((request) => request.method === "POST" && request.path === "/git/trees");

async function openPage(page, label) {
  await page.locator("#page-list .file-link", { hasText: label }).first().click();
  await expect(page.locator("#stage-title")).toHaveText(label);
  await frameReady(page);
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
  expect(commit.body.message).toBe(
    "Home: add “Really.”\n\nHome (index.html)\n- “Pick whatever sounds a bit interesting.” → “Pick whatever sounds a bit interesting. Really.”\n",
  );
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
  // A script-made paste: engines differ on which event carries script-made
  // clipboard data (WebKit: the paste event; Firefox: beforeinput), and the
  // editor handles both, as it does real pastes.
  await paragraph.evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "C\nD");
    data.setData("text/html", "<b>C</b><br>D");
    const before = element.innerHTML;
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    if (element.innerHTML === before) {
      element.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertFromPaste", dataTransfer: data, bubbles: true, cancelable: true }));
    }
  });
  expect(await paragraph.evaluate((element) => element.innerHTML)).toBe("Pick whatever sounds a bit interesting. ABC D");
  // Shift+Enter finishes the block like Enter, without a line break.
  await page.keyboard.press("Shift+Enter");
  await expect(paragraph).not.toHaveAttribute("contenteditable", "true");
  expect(await paragraph.evaluate((element) => element.innerHTML)).toBe("Pick whatever sounds a bit interesting. ABC D");
  await save(page);
  expect(treeWrites(fake)[0].body.tree[0].content).toContain("<p>Pick whatever sounds a bit interesting. ABC D</p>");
});

test("clicking a link never navigates; it opens the link in the panel to change its address", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  const link = frame(page).locator("a", { hasText: "more of what I read" });
  await link.click();
  await expect(frame(page).locator("h1")).toHaveText("Hi, I’m Tom.");
  const panel = page.locator("#panel");
  await expect(panel.getByRole("heading", { name: "Link" })).toBeVisible();
  const address = panel.getByRole("textbox", { name: "Link address" }).first();
  await expect(address).toHaveValue("/physics/#reading");
  await address.fill("/physics/#questions");
  await address.press("Enter");
  await expect(page.locator("#save-button")).toHaveText("Save (1)");
  await save(page);
  expect(treeWrites(fake)[0].body.tree[0].content).toBe(
    readFixture("index.html").replace('<a href="/physics/#reading">', '<a href="/physics/#questions">'),
  );
});

test("the keyboard reaches a block with Tab and types at its end", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  const eyebrow = frame(page).locator("p.eyebrow", { hasText: "Heyyy" });
  await eyebrow.focus();
  await expect(eyebrow).toHaveAttribute("contenteditable", "true");
  await page.keyboard.type("y");
  await page.keyboard.press("Tab");
  await expect(eyebrow).not.toHaveAttribute("contenteditable", "true");
  await expect(eyebrow).toHaveText("Heyyyy");
  await expect(page.locator("#save-button")).toHaveText("Save (1)");
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

test("a placeholder still asks before Done after an item is added above it", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await openPage(page, "Physics & Ideas");
  // A new item before the list's last one shifts that item's key.
  await frame(page).locator("li", { hasText: "Andrew Doig" }).locator(".compact-list-label").click();
  await page.locator(".edit-toolbar button", { hasText: "+" }).click();
  await page.keyboard.type("A new book");
  await page.keyboard.press("Enter");
  const last = frame(page).locator("li", { hasText: "Dennis E. Taylor" });
  await last.locator(".draft-inline").click();
  await page.locator(".edit-toolbar button", { hasText: "Done" }).click();
  const confirm = page.locator("#confirm-dialog");
  await expect(confirm).toContainText("still has its placeholder text");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(last.locator(".draft-inline")).toHaveCount(1);
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
  await expect(dialog.getByLabel("Pull request title")).toHaveValue("Physics & Ideas: add “(and stuff)”");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByRole("link", { name: "#1 Physics & Ideas: add “(and stuff)”" })).toBeVisible();
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

test("commit messages and pull requests: generated, editable, or suggested by AI without private text", async ({ page }) => {
  const fake = await createFake();
  const worker = await openEditor(page, fake);
  const paragraph = frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." });
  await typeAtEnd(page, paragraph, " Really.");
  await page.keyboard.press("Enter");
  await page.locator("#record-list .file-link").click();
  const record = page.locator("#markdown-editor");
  await record.press("Control+End");
  await record.type("- A private fact.\n");
  await page.waitForTimeout(600);

  await page.locator("#save-button").click();
  const saveDialog = page.locator("#save-dialog");
  const subject = saveDialog.getByLabel("Commit message");
  await expect(subject).toHaveValue("Home and the Record: 1 wording change, 1 line added");
  await saveDialog.getByRole("button", { name: "Suggest with AI" }).click();
  await expect(subject).toHaveValue("Add “Really.” to the homepage");
  await expect(saveDialog.getByLabel("Details")).toHaveValue("Home gains one word.");
  await subject.fill("Home: add “Really.”; a fact for the Record");
  await saveDialog.locator(".dialog-actions .button--primary").click();
  await expect(saveDialog).toBeHidden();
  await expect(page.locator("#save-button")).toHaveText("Save");
  const commit = fake.requests.find((request) => request.method === "POST" && request.path === "/git/commits");
  expect(commit.body.message).toBe("Home: add “Really.”; a fact for the Record\n\nHome gains one word.\n");

  // What went to the AI: the page's change, and the Record only as a count.
  const [asked] = worker.describes;
  expect(asked).toMatchObject({ access_token: expect.stringMatching(/^ghu_test/), kind: "commit" });
  expect(asked.changes).toEqual([
    { file: "Home", path: "index.html", changes: ["“Pick whatever sounds a bit interesting.” → “Pick whatever sounds a bit interesting. Really.”"] },
    { file: "Record", path: "docs/record.md", changes: ["1 change (private file: content not shared)"] },
  ]);
  expect(JSON.stringify(worker.describes)).not.toContain("private fact");

  await page.locator("#publish-button").click();
  const publish = page.locator("#publish-dialog");
  const prTitle = publish.getByLabel("Pull request title");
  await expect(prTitle).toHaveValue("Home and the Record: 1 wording change, 1 line added");
  await publish.getByRole("button", { name: "Suggest with AI" }).click();
  await expect(prTitle).toHaveValue("Publish a word on Home and a Record fact");
  await publish.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(publish.getByRole("link", { name: "#1 Publish a word on Home and a Record fact" })).toBeVisible();
  const [pull] = fake.pulls();
  expect(pull.body.startsWith("One word on Home and a fact in the Record.\n\n<!-- editor:changes -->")).toBe(true);
  expect(pull.body).toContain("**Home** (`index.html`)");
  expect(worker.describes[1].kind).toBe("pr");
  expect(JSON.stringify(worker.describes)).not.toContain("private fact");
});

test("drafts: in draft mode a change to live text waits as a new version, and publishing it makes the change", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  const toggle = page.locator("#draft-mode-button");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#status-line")).toContainText("Drafts on");

  const live = frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." }).first();
  await typeAtEnd(page, live, " Really.");
  await page.keyboard.press("Enter");
  const copy = frame(page).locator('p[data-draft="replace"]');
  await expect(copy).toHaveText("Pick whatever sounds a bit interesting. Really.");
  await expect(frame(page).locator("p:not([data-draft])", { hasText: "Pick whatever" })).toHaveText("Pick whatever sounds a bit interesting.");
  // The page's list names it a new version, to publish, not a placeholder to finish.
  const listed = page.locator("#panel .draft-item", { hasText: "Really." });
  await expect(listed.locator(".tag")).toHaveText("New version");
  await expect(listed.getByRole("button", { name: "Publish" })).toBeVisible();
  await save(page);
  const saved = fake.fileAt("edits", "index.html");
  expect(saved).toContain(
    '<p>Pick whatever sounds a bit interesting.</p>\n            <p data-draft="replace">Pick whatever sounds a bit interesting. Really.</p>\n',
  );
  const commit = fake.commit(fake.head("edits"));
  expect(commit.message.split("\n")[0]).toBe("Home: draft add “Really.”");

  await toggle.click();
  await copy.click();
  await page.locator(".edit-toolbar button", { hasText: "Publish new version" }).click();
  await expect(frame(page).locator("[data-draft]")).toHaveCount(fake.fileAt("main", "index.html").match(/data-draft/g)?.length ?? 0);
  await save(page);
  expect(fake.fileAt("edits", "index.html")).toBe(
    readFixture("index.html").replace("<p>Pick whatever sounds a bit interesting.</p>", "<p>Pick whatever sounds a bit interesting. Really.</p>"),
  );
});

test("drafts: whole paragraphs and chosen words kept off the live site, and × marking a removal", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  const paragraph = frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." });
  await paragraph.click();
  await page.locator("#panel").getByRole("button", { name: "Make this a draft" }).click();
  await expect(frame(page).locator('p[data-draft="new"]')).toHaveText("Pick whatever sounds a bit interesting.");
  await page.locator("#undo-button").click();
  await expect(frame(page).locator('p[data-draft="new"]')).toHaveCount(0);

  // Select "interesting" by keyboard, then keep just that word off the live site.
  await typeAtEnd(page, frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." }), "");
  await page.keyboard.press("ArrowLeft");
  for (let index = 0; index < "interesting".length; index += 1) await page.keyboard.press("Shift+ArrowLeft");
  await page.locator("#panel").getByRole("button", { name: "Keep them off the live site" }).click();
  await expect(frame(page).locator('span[data-draft="new"]')).toHaveText("interesting");

  await page.locator("#draft-mode-button").click();
  const item = frame(page).locator("li", { hasText: "Building VAXTB" });
  await item.locator(".compact-list-text").click();
  await page.locator(".edit-toolbar button", { hasText: "×" }).click();
  await expect(page.locator("#confirm-dialog")).toBeHidden();
  await expect(frame(page).locator('li[data-draft="remove"]')).toContainText("Building VAXTB");
  await save(page);
  const saved = fake.fileAt("edits", "index.html");
  expect(saved).toContain('<p>Pick whatever sounds a bit <span data-draft="new">interesting</span>.</p>');
  expect(saved).toMatch(/<li data-draft="remove">\s*<span class="compact-list-label">VAXTB<\/span>/);
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
  // The typing the reload replaced is kept aside to copy from.
  const panel = page.locator("#panel");
  await expect(panel).toContainText("changed on GitHub after your unsaved edits");
  await panel.getByRole("button", { name: "Show them" }).click();
  await expect(page.locator("#save-dialog")).toContainText("Three.");
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

test("typing in a block that was never finished survives a reload", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await typeAtEnd(page, frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." }), " Unfinished");
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(frame(page).locator("p", { hasText: "Pick whatever" })).toHaveText("Pick whatever sounds a bit interesting. Unfinished");
  await expect(page.locator("#save-button")).toHaveText("Save (1)");
});

test("unsaved Record edits made to an older version are kept aside, not overwritten", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await page.locator("#record-list .file-link").click();
  const editor = page.locator("#markdown-editor");
  await editor.press("Control+End");
  await editor.type("- Typed before the file changed.\n");
  await page.waitForTimeout(600);
  await fake.commitAs("main", { "docs/record.md": `${fake.fileAt("main", "docs/record.md")}- Added on another device.\n` });
  await page.reload();
  await page.locator("#record-list .file-link").click();
  const panel = page.locator("#panel");
  await expect(panel).toContainText("changed on GitHub after your unsaved edits");
  await expect(editor).toHaveValue(/Added on another device/);
  await editor.press("Control+End");
  await editor.type("- New typing.\n");
  await page.waitForTimeout(600);
  await page.reload();
  await page.locator("#record-list .file-link").click();
  await expect(panel).toContainText("changed on GitHub after your unsaved edits");

  // A second change on GitHub sets the new typing aside too, next to the first;
  // saving other work to the file keeps both.
  await fake.commitAs("main", { "docs/record.md": `${fake.fileAt("main", "docs/record.md")}- Added again.\n` });
  await page.reload();
  await page.locator("#record-list .file-link").click();
  await expect(editor).toHaveValue(/Added again/);
  await editor.press("Control+End");
  await editor.type("- Saved typing.\n");
  await save(page);
  expect(fake.fileAt("edits", "docs/record.md")).toContain("- Saved typing.\n");
  await page.reload();
  await page.locator("#record-list .file-link").click();
  await expect(panel).toContainText("changed on GitHub after your unsaved edits");
  await panel.getByRole("button", { name: "Show them" }).click();
  const shown = page.locator("#save-dialog");
  await expect(shown).toContainText("Typed before the file changed.");
  await expect(shown).toContainText("New typing.");
});

test("Save waits until every page has loaded, so the site-wide checks see the whole site", async ({ page }) => {
  const fake = await createFake();
  const blob = await gitBlobSha(readFixture("programming.html"));
  let failing = true;
  await openEditor(page, fake, {
    beforeLoad: (target) =>
      target.route(`https://api.github.com/repos/**/git/blobs/${blob}`, (route) =>
        failing
          ? route.fulfill({ status: 502, headers: { "access-control-allow-origin": "*" }, body: '{"message":"Server Error"}' })
          : route.fallback(),
      ),
  });
  await typeAtEnd(page, frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." }), " Blocked?");
  await page.keyboard.press("Enter");
  await page.locator("#save-button").click();
  await expect(page.locator("#toast")).toContainText("Couldn't load Programming");
  await expect(page.locator("#save-dialog")).toBeHidden();
  expect(fake.requests.filter((request) => request.path === "/git/trees")).toHaveLength(0);

  failing = false;
  await save(page);
  expect(fake.fileAt("edits", "index.html")).toContain("interesting. Blocked?</p>");
});
