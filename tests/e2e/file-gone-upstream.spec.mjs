// Finding 3 of the data-safety audit (docs/audits/2026-09-27-merge-safety.md):
// unsaved edits to a file that is no longer on GitHub (renamed or deleted in a
// Claude session, say). Save reports it as no longer on GitHub and offers
// "Reload those files"; the edits are then kept aside under "No longer on
// GitHub", to copy from, until discarded, and the file is never recreated.
import { expect, test } from "@playwright/test";
import { createFake, openEditor, save } from "./support.mjs";

test("unsaved edits to a blog source renamed on main are kept aside, and the file is never recreated", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await page.locator("#blog-source-list .file-link", { hasText: "bridging-the-gap" }).click();
  const box = page.locator("#markdown-editor");
  await box.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nMY-UNSAVED-PARAGRAPH");
  await page.waitForTimeout(600);
  const old = "docs/blog-sources/bridging-the-gap.md";
  const text = fake.fileAt("main", old);
  await fake.commitAs("main", { [old]: null, "docs/blog-sources/bridging-the-gap-renamed.md": text });

  await page.locator("#save-button").click();
  const saveDialog = page.locator("#save-dialog");
  await expect(saveDialog).toBeVisible();
  await saveDialog.locator(".dialog-actions .button--primary").click();
  const confirm = page.locator("#confirm-dialog");
  await expect(confirm).toContainText("keeps your unsaved edits to them aside");
  await expect(confirm).toContainText(`${old} is no longer on GitHub`);
  await confirm.getByRole("button", { name: "Reload those files" }).click();

  // Listed under "No longer on GitHub", with the kept-aside notice and the text to copy.
  const gone = page.locator("#gone-list .file-link", { hasText: "bridging-the-gap" });
  await expect(page.locator("#gone-heading")).toBeVisible();
  await expect(gone).toHaveCount(1);
  await expect(page.locator("#blog-source-list .file-link", { hasText: /^bridging-the-gap$/ })).toHaveCount(0);
  await gone.click();
  await expect(page.locator("#panel")).toContainText("no longer on GitHub");
  await expect(page.locator("#panel")).toContainText("weren't applied");
  await expect(box).toHaveValue(/MY-UNSAVED-PARAGRAPH/);
  await expect(box).toHaveJSProperty("readOnly", true);
  await page.locator("#panel").getByRole("button", { name: "Show them" }).click();
  await expect(saveDialog).toContainText("MY-UNSAVED-PARAGRAPH");
  await saveDialog.getByRole("button", { name: "Close" }).last().click();

  // Nothing to save there, and a Save of other work never recreates the file.
  await expect(page.locator("#save-button")).toHaveText("Save");
  await page.locator("#record-list .file-link").click();
  await box.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n- Saved elsewhere.");
  await save(page);
  expect(fake.fileAt("edits", "docs/record.md")).toContain("- Saved elsewhere.");
  expect(fake.fileAt("edits", old)).toBeNull();

  // Kept across a reload, until discarded; then nothing holds back bringing main in.
  await page.reload();
  await expect(gone).toHaveCount(1);
  await gone.click();
  await page.locator("#panel").getByRole("button", { name: "Discard them" }).click();
  await confirm.getByRole("button", { name: "Discard edits" }).click();
  await expect(gone).toHaveCount(0);
  await expect(page.locator("#gone-heading")).toBeHidden();
  await fake.commitAs("main", { "index.html": fake.fileAt("main", "index.html").replace("Pick whatever", "Pick anything") });
  await page.reload();
  await expect(page.locator("#status-line")).toContainText("Brought main's 1 newer commit into your saved edits");
});
