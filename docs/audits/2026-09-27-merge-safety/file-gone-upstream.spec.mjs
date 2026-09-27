// Finding 3. Unsaved edits to a file that is no longer on GitHub (renamed or
// deleted in a Claude session, say). Save reports a conflict and offers
// "Reload those files", promising to keep the edits aside. Asserts the safe
// outcome, so it fails today.
import { expect, test } from "@playwright/test";
import { createFake, openEditor } from "../../../tests/e2e/support.mjs";

test("unsaved edits to a blog source renamed on main are kept aside", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await page.locator("#blog-source-list .file-link", { hasText: "bridging-the-gap" }).click();
  const box = page.locator("#markdown-editor");
  await box.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nMY-UNSAVED-PARAGRAPH");
  await page.waitForTimeout(600);
  const text = fake.fileAt("main", "docs/blog-sources/bridging-the-gap.md");
  await fake.commitAs("main", { "docs/blog-sources/bridging-the-gap.md": null, "docs/blog-sources/bridging-the-gap-renamed.md": text });

  await page.locator("#save-button").click();
  const saveDialog = page.locator("#save-dialog");
  await expect(saveDialog).toBeVisible();
  await saveDialog.locator(".dialog-actions .button--primary").click();
  const confirm = page.locator("#confirm-dialog");
  await expect(confirm).toContainText("keeps your unsaved edits to them aside");
  await confirm.getByRole("button", { name: "Reload those files" }).click();
  await page.waitForTimeout(2500);

  let shown = false;
  for (const label of await page.locator("#blog-source-list .file-link-label").allTextContents()) {
    await page.locator("#blog-source-list .file-link", { hasText: label }).first().click();
    await page.waitForTimeout(300);
    if (/weren't applied/.test(await page.locator("#panel").textContent())) shown = true;
  }
  expect.soft(shown, "a blog source shows the kept-aside edits").toBe(true);
  expect.soft(await page.locator("#save-button").textContent(), "or they still count as unsaved").not.toBe("Save");
});
