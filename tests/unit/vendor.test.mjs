import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bundleParse5 } from "../../scripts/bundle-parse5.mjs";
import { decodeHTML, parse } from "../../vendor/parse5.js";

test("vendor/parse5.js is exactly what scripts/bundle-parse5.mjs builds from the pinned packages", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "parse5-bundle-"));
  try {
    const outfile = path.join(directory, "parse5.js");
    await bundleParse5({ outfile });
    const rebuilt = await readFile(outfile);
    const committed = await readFile(new URL("../../vendor/parse5.js", import.meta.url));
    assert.ok(rebuilt.equals(committed), "run `npm run vendor` and commit vendor/parse5.js");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the bundle reports source offsets and decodes entities", () => {
  const html = "<!doctype html><p>A &amp; B</p>";
  const document = parse(html, { sourceCodeLocationInfo: true });
  const body = document.childNodes[1].childNodes[1];
  const paragraph = body.childNodes[0];
  assert.equal(paragraph.tagName, "p");
  assert.deepEqual(
    [paragraph.sourceCodeLocation.startOffset, paragraph.sourceCodeLocation.endOffset],
    [15, html.length],
  );
  const text = paragraph.childNodes[0];
  assert.equal(text.value, "A & B");
  assert.equal(html.slice(text.sourceCodeLocation.startOffset, text.sourceCodeLocation.endOffset), "A &amp; B");
  assert.equal(decodeHTML("&rsquo;&amp;&nbsp;"), "’& ");
});
