// Finding 2 of the data-safety audit (docs/audits/2026-09-27-merge-safety.md):
// a new version ("replace" draft) records its live element as it was. Once the
// live element changes (main's change merged in, or a Claude session's edit),
// "Publish new version" shows the live element as it was, as it is now, and
// the new version, and publishes nothing until Tom has carried the change
// over and recorded the live element as it is now.
import { expect, test } from "@playwright/test";
import { createFake, frame, openEditor, save, typeAtEnd } from "./support.mjs";

test("a new version whose live paragraph changed on GitHub is shown beside it, and published only once recorded", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  const toggle = page.locator("#draft-mode-button");
  await toggle.click();
  await typeAtEnd(page, frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." }).first(), " Really.");
  await page.keyboard.press("Enter");
  await save(page);
  await toggle.click();

  // A Claude session adds to the live paragraph on edits, leaving the new version as it was.
  await fake.commitAs("edits", {
    "index.html": fake.fileAt("edits", "index.html").replace("<p>Pick whatever sounds a bit interesting.</p>", "<p>Pick whatever sounds a bit interesting. Go on.</p>"),
  });
  await page.reload();
  const copy = frame(page).locator('p[data-draft="replace"]');
  await copy.click();
  await page.locator(".edit-toolbar button", { hasText: "Publish new version" }).click();
  const dialog = page.locator("#save-dialog");
  await expect(dialog).toContainText("The live version has changed");
  await expect(dialog).toContainText("What changed in the live version");
  await expect(dialog.locator(".change-words").first().locator(".word--insert")).toHaveText("Go on. ");
  await expect(dialog.locator(".change-words").nth(1).locator(".word--insert")).toHaveText("Really. ");
  await dialog.locator(".dialog-actions").getByRole("button", { name: "Close" }).click();
  await expect(copy).toHaveCount(1);
  expect(fake.fileAt("edits", "index.html")).toContain("<p>Pick whatever sounds a bit interesting. Go on.</p>");

  // Carried over by typing, then recorded: publishing works, with both changes.
  await typeAtEnd(page, copy, " Go on.");
  await page.keyboard.press("Enter");
  await copy.click();
  const panel = page.locator("#panel");
  await expect(panel).toContainText("The live version has changed since this new version was made");
  await panel.getByRole("button", { name: "Record the live version", exact: true }).click();
  await expect(panel).not.toContainText("The live version has changed since this new version was made");
  await copy.click();
  await page.locator(".edit-toolbar button", { hasText: "Publish new version" }).click();
  await expect(copy).toHaveCount(0);
  await save(page);
  const saved = fake.fileAt("edits", "index.html");
  expect(saved).toContain("<p>Pick whatever sounds a bit interesting. Really. Go on.</p>");
  expect(saved).not.toContain("Pick whatever sounds a bit interesting. Go on.</p>");
  expect(saved).not.toContain("data-draft-of");
});
