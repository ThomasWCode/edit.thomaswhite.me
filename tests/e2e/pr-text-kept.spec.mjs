// Finding 7 of the data-safety audit (docs/audits/2026-09-27-merge-safety.md):
// the Publish dialog sends a pull request's title and note only if they were
// changed in it, so a title or note changed on GitHub since it opened stays.
import { expect, test } from "@playwright/test";
import { createFake, frame, openEditor, save, typeAtEnd } from "./support.mjs";

const API = "https://api.github.com/repos/ThomasWCode/ThomasWCode.github.io-revised";

async function editOnGitHub(fake, fields) {
  await fake.fetch(new Request(`${API}/pulls/1`, { method: "PATCH", headers: { Authorization: "Bearer ghu_test", "Content-Type": "application/json" }, body: JSON.stringify(fields) }));
}

test("Update title and description sends only what was changed in the dialog", async ({ page }) => {
  const fake = await createFake();
  await openEditor(page, fake);
  await typeAtEnd(page, frame(page).locator("p", { hasText: "Pick whatever sounds a bit interesting." }), " Really.");
  await page.keyboard.press("Enter");
  await save(page);
  await page.locator("#publish-button").click();
  const dialog = page.locator("#publish-dialog");
  await dialog.getByLabel("Description").fill("My note.");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByRole("link", { name: /^#1 / })).toBeVisible();
  await dialog.locator(".dialog-actions").getByRole("button", { name: "Close" }).click();

  // Opened again, then changed on GitHub while the dialog is open.
  await page.locator("#publish-button").click();
  await expect(dialog.getByLabel("Description")).toHaveValue("My note.");
  const below = "Added below the list on GitHub.";
  await editOnGitHub(fake, { title: "Title from GitHub", body: `${fake.pulls()[0].body.replace("My note.", "Note from GitHub.")}\n${below}\n` });
  await dialog.getByRole("button", { name: "Update title and description" }).click();
  await expect(page.locator("#publish-dialog .notice")).toContainText("Updated the pull request's title and description.");
  expect(fake.pulls()[0].title).toBe("Title from GitHub");
  expect(fake.pulls()[0].body.startsWith("Note from GitHub.\n\n")).toBe(true);
  expect(fake.pulls()[0].body).toContain(below);

  // A title changed in the dialog is sent; the note, untouched there, stays.
  await dialog.getByLabel("Pull request title").fill("Title from the dialog");
  await dialog.getByRole("button", { name: "Update title and description" }).click();
  await expect.poll(() => fake.pulls()[0].title).toBe("Title from the dialog");
  expect(fake.pulls()[0].body.startsWith("Note from GitHub.\n\n")).toBe(true);
  expect(fake.pulls()[0].body).toContain(below);
});
