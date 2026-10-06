import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// package.json `overrides` force a newer release of a package than the package
// that depends on it pins. An override applies to every copy of the package in
// the tree, so this test fails once any package pins a newer release, which the
// override would force down. It is also only kept while it is needed: once every
// package that depends on the overridden one pins that release or a later one
// itself, the test fails, so the override is removed rather than left behind.

const root = new URL("../../", import.meta.url);
const readJson = async (file) => JSON.parse(await readFile(new URL(file, root), "utf8"));
const exact = /^\d+\.\d+\.\d+$/;

function compareVersions(a, b) {
  const [left, right] = [a, b].map((version) => version.split(".").map(Number));
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

test("every npm override is still needed and forces nothing down", async () => {
  const { overrides = {} } = await readJson("package.json");
  const { packages } = await readJson("package-lock.json");

  for (const [name, forced] of Object.entries(overrides)) {
    assert.match(forced, exact, `The ${name} override must be an exact version.`);

    // The lockfile keeps each package's own declared dependencies, so it still
    // shows the version the dependent pins, not the one the override installs.
    const pins = Object.entries(packages)
      .filter(([location, entry]) => location !== "" && (entry.dependencies?.[name] ?? entry.optionalDependencies?.[name]))
      .map(([location, entry]) => ({
        by: location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length),
        pin: entry.dependencies?.[name] ?? entry.optionalDependencies?.[name],
      }));
    assert.ok(pins.length > 0, `Nothing depends on ${name} any more: remove its override from package.json.`);

    const newer = pins.filter(({ pin }) => exact.test(pin) && compareVersions(pin, forced) > 0);
    assert.ok(
      newer.length === 0,
      `${newer.map(({ by, pin }) => `${by} pins ${name} ${pin}`).join(", ")}, newer than the override, which would force it down to ${forced}: remove the override from package.json, or limit it to the package that still needs it.`,
    );

    const older = pins.filter(({ pin }) => exact.test(pin) && compareVersions(pin, forced) < 0);
    assert.ok(
      older.length > 0,
      `${pins.map(({ by, pin }) => `${by} pins ${name} ${pin}`).join(", ")} itself now, so the override to ${forced} is no longer needed: remove it from package.json and run npm install.`,
    );
  }
});
