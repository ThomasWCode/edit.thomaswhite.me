// GitHub Pages publishes this repository with Jekyll, which serves every file
// it is not told to exclude (Markdown included, even without front matter).
// Every top-level path must be either meant for the published editor or listed
// in _config.yml's exclude, so tests, docs and the Worker are never served.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const PUBLISHED = new Set(["index.html", "editor.css", "frame.css", "robots.txt", "CNAME", "_config.yml", "src/", "vendor/"]);
const root = new URL("../../", import.meta.url);

async function excluded() {
  const config = await readFile(new URL("_config.yml", root), "utf8");
  return new Set(Array.from(config.matchAll(/^\s+-\s+(\S+)\s*$/gm), (match) => match[1]));
}

test("every tracked top-level path is published on purpose or excluded", async () => {
  const exclude = await excluded();
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const topLevel = new Set(tracked.map((file) => (file.includes("/") ? `${file.split("/")[0]}/` : file)));
  const unaccounted = [...topLevel].filter(
    // Jekyll never publishes dot-files or dot-folders.
    (entry) => !entry.startsWith(".") && !PUBLISHED.has(entry) && !exclude.has(entry),
  );
  assert.deepEqual(unaccounted, [], "add each path to _config.yml's exclude, or to PUBLISHED if the editor needs it");
  for (const entry of ["docs/", "tests/", "worker/", "wrangler.toml", "AGENTS.md", "README.md", "dev/", "scripts/"]) {
    assert.ok(exclude.has(entry), `_config.yml must exclude ${entry}`);
  }
});

test("the published page never contains Liquid markers", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  assert.ok(!html.includes("{{") && !html.includes("{%"));
});
