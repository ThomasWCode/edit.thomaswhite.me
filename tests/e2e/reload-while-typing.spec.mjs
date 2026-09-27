// Finding 9 of the data-safety audit (docs/audits/2026-09-27-merge-safety.md):
// a reload that starts while a block is being typed finishes that block first,
// so every word typed reaches the file it was typed on, and is kept aside if
// that file changed on GitHub.
import { expect, test } from "@playwright/test";
import { createFake, frame, openEditor, save, typeAtEnd } from "./support.mjs";

test("a reload while a block is being typed keeps every word, kept aside when the file changed", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await page.locator("#page-list .file-link", { hasText: "Physics & Ideas" }).first().click();
  await typeAtEnd(page, frame(page).locator("p.eyebrow", { hasText: "Thinking about things" }), " (and stuff)");
  await page.keyboard.press("Enter");
  await save(page);
  await page.locator("#publish-button").click();
  const dialog = page.locator("#publish-dialog");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByRole("link", { name: /^#1 / })).toBeVisible();
  // Once GitHub has worked out whether it can merge, a poll answers at once.
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Merge", exact: true })).toBeEnabled();
  await dialog.locator(".dialog-actions").getByRole("button", { name: "Close" }).click();

  await page.locator("#page-list .file-link", { hasText: "Home" }).first().click();
  const paragraph = frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." });
  await typeAtEnd(page, paragraph, " Mirrored");
  await page.waitForTimeout(1200);
  // A Claude session changes Home and closes the pull request; the editor
  // follows it with a reload while the last words are still being typed.
  await fake.commitAs("edits", { "index.html": `${fake.fileAt("edits", "index.html")}<!-- elsewhere -->\n` });
  await fake.closeOnGitHub(1);
  await page.keyboard.type(" JustTyped");
  await page.evaluate(() => document.dispatchEvent(new window.Event("visibilitychange")));

  const panel = page.locator("#panel");
  await expect(panel).toContainText("changed on GitHub after your unsaved edits");
  await panel.getByRole("button", { name: "Show them" }).click();
  const shown = page.locator("#save-dialog");
  await expect(shown).toContainText("Mirrored");
  await expect(shown).toContainText("JustTyped");
});

test("a reload straight after typing in the Record keeps the typing, kept aside when the file changed", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await page.locator("#page-list .file-link", { hasText: "Physics & Ideas" }).first().click();
  await typeAtEnd(page, frame(page).locator("p.eyebrow", { hasText: "Thinking about things" }), " (and stuff)");
  await page.keyboard.press("Enter");
  await save(page);
  await page.locator("#publish-button").click();
  const dialog = page.locator("#publish-dialog");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByRole("link", { name: /^#1 / })).toBeVisible();
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Merge", exact: true })).toBeEnabled();
  await dialog.locator(".dialog-actions").getByRole("button", { name: "Close" }).click();

  await page.locator("#record-list .file-link").click();
  const box = page.locator("#markdown-editor");
  await fake.commitAs("edits", { "docs/record.md": `${fake.fileAt("edits", "docs/record.md")}- Added in a Claude session.\n` });
  await fake.closeOnGitHub(1);
  await box.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("- JustTyped");
  await page.evaluate(() => document.dispatchEvent(new window.Event("visibilitychange")));

  const panel = page.locator("#panel");
  await expect(panel).toContainText("changed on GitHub after your unsaved edits");
  await expect(box).toHaveValue(/Added in a Claude session/);
  await panel.getByRole("button", { name: "Show them" }).click();
  await expect(page.locator("#save-dialog")).toContainText("JustTyped");
});
