// Shared helpers for the unit tests: the site fixtures, and a stand-in for the
// browser. parse5 implements the same HTML parsing algorithm as a browser, so
// parsing the render copy and editing its text nodes reproduces what the
// preview's DOM holds after typing, minus browser quirks (which snapshot.js
// handles and tests/unit/snapshot.test.mjs covers).

import { readFileSync } from "node:fs";
import { parse } from "../../vendor/parse5.js";
import { targets } from "../../src/config.js";
import { buildPageModel } from "../../src/page-model.js";
import { renderCopy } from "../../src/render-copy.js";
import { readOnlyReason } from "../../src/site-files.js";
import { snapshotFromParse5 } from "../../src/snapshot.js";
import { diffSequences } from "../../src/sequence-diff.js";

export const PAGE_FILES = [
  "index.html",
  "programming.html",
  "physics.html",
  "physics/magnetic-newtons-cradle.html",
  "volunteering.html",
  "blog/index.html",
  "blog/how-this-site-works.html",
  "sport-music-and-drama.html",
  "gallery.html",
  "tedx.html",
  "testimonials.html",
  "contact.html",
  "youtube.html",
  "cv.html",
  "sport.html",
  "music&drama.html",
  "gravatar.html",
];

export const ORIGINS = { assetsOrigin: "https://new.thomaswhite.me", editorOrigin: "http://127.0.0.1:4174" };

export function readFixture(path) {
  return readFileSync(new URL(`../fixtures/site/${path}`, import.meta.url), "utf8");
}

export function loadModel(path, source = readFixture(path)) {
  return buildPageModel(source, { path, readOnlyReason: readOnlyReason(targets.preview, path) });
}

function findByKey(node, key) {
  for (const child of node.childNodes || []) {
    if (typeof child.tagName !== "string") continue;
    if (child.attrs.some((item) => item.name === "data-edit-key" && item.value === key)) return child;
    const found = findByKey(child, key);
    if (found) return found;
  }
  return null;
}

// The block as the preview's DOM holds it, before any typing.
export function renderedSnapshot(model, key) {
  const document = parse(renderCopy(model, ORIGINS));
  const element = findByKey(document, key);
  if (!element) throw new Error(`No element with data-edit-key="${key}" in the render copy`);
  return snapshotFromParse5(element);
}

// Replaces the first occurrence of `from` in the snapshot's text nodes, as
// typing would. Throws if `from` is not inside a single text node.
export function typeInto(snapshot, from, to) {
  let done = false;
  const visit = (node) => {
    if (done) return node;
    if (node.type === "text") {
      const index = node.text.indexOf(from);
      if (index < 0) return node;
      done = true;
      return { ...node, text: node.text.slice(0, index) + to + node.text.slice(index + from.length) };
    }
    return { ...node, children: node.children.map(visit) };
  };
  const result = visit(snapshot);
  if (!done) throw new Error(`"${from}" is not in one text node of the block`);
  return result;
}

// Lines added and removed between two versions of a file.
export function lineChanges(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  const operations = diffSequences(a, b);
  return {
    removed: operations.filter((operation) => operation.type === "delete").map((operation) => a[operation.oldIndex]),
    added: operations.filter((operation) => operation.type === "insert").map((operation) => b[operation.newIndex]),
  };
}
