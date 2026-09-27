// Finding 1. Words finished while a Save is still talking to GitHub. The ref
// update is held for four seconds so there is time to type, as a slow
// connection or an open pull request (whose description is rebuilt on every
// save) would give. Each test asserts the safe outcome, so it fails today.
/* global sessionStorage */
import { expect, test } from "@playwright/test";
import { createFake, frame, openEditor, typeAtEnd } from "../../../tests/e2e/support.mjs";

const slowRefUpdate = (ms) => async (page) => {
  await page.route("https://api.github.com/repos/*/*/git/refs/heads/edits", async (route) => {
    if (route.request().method() === "PATCH") await new Promise((resolve) => setTimeout(resolve, ms));
    await route.fallback();
  });
};

async function startSave(page) {
  await page.locator("#save-button").click();
  const dialog = page.locator("#save-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".dialog-actions .button--primary").click();
  await expect(dialog).toBeHidden();
}

async function saveFinished(page) {
  await expect(page.locator("#status-line")).not.toHaveText(/Working on GitHub/, { timeout: 20_000 });
  await page.waitForTimeout(1500);
}

const stored = (page) =>
  page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith("siteEditor.working"))
      .map((key) => sessionStorage.getItem(key))
      .join("\n"),
  );

test("Record tab: a line typed while a save is in flight is kept", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake, { beforeLoad: slowRefUpdate(4000) });
  await page.locator("#record-list .file-link").first().click();
  const box = page.locator("#markdown-editor");
  await box.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nFIRST-SAVED-LINE");
  await startSave(page);
  await box.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nTYPED-DURING-SAVE");
  await saveFinished(page);
  expect(fake.fileAt("edits", "docs/record.md"), "the first line was saved").toContain("FIRST-SAVED-LINE");
  expect.soft(await box.inputValue(), "the line typed during the save is still in the box").toContain("TYPED-DURING-SAVE");
  expect.soft(await page.locator("#save-button").textContent(), "and counts as unsaved").toBe("Save (1)");
  expect.soft(await stored(page), "and is mirrored to sessionStorage").toContain("TYPED-DURING-SAVE");
});

test("Page: a paragraph finished while a save is in flight is kept", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake, { beforeLoad: slowRefUpdate(4000) });
  await typeAtEnd(page, frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." }), " Really.");
  await page.keyboard.press("Enter");
  await startSave(page);
  await typeAtEnd(page, frame(page).locator("main p").filter({ hasNotText: "Pick whatever" }).nth(3), " MIDSAVE");
  await page.keyboard.press("Enter");
  await saveFinished(page);
  expect(fake.fileAt("edits", "index.html"), "the first edit was saved").toContain("interesting. Really.");
  expect(await frame(page).locator("main").textContent(), "the preview shows the second edit").toContain("MIDSAVE");
  expect.soft(await page.locator("#save-button").textContent(), "the second edit counts as unsaved").toBe("Save (1)");
  expect.soft(await stored(page), "and is mirrored to sessionStorage").toContain("MIDSAVE");
  await page.reload();
  await expect(page.locator("#stage-title")).toHaveText("Home");
  await page.waitForTimeout(2000);
  expect.soft(await frame(page).locator("main").textContent(), "and survives a reload").toContain("MIDSAVE");
});
