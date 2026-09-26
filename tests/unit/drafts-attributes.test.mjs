import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completeDraft,
  EditRejectedError,
  openInNewTab,
  openInSameTab,
  removeAttribute,
  setAttribute,
  setNowUpdated,
  updatedLabel,
} from "../../src/edits.js";
import { blockText, textOf } from "../../src/page-model.js";
import { lineChanges, loadModel } from "../support/fixtures.mjs";

function draftAt(model, line, kind) {
  const draft = model.drafts.find((item) => item.node.sourceCodeLocation.startLine === line && (!kind || item.kind === kind));
  assert.ok(draft, `no ${kind || ""} draft on line ${line}`);
  return draft;
}

test("Done on a note removes data-draft and the draft-note class, and nothing else", () => {
  const programming = loadModel("programming.html");
  const note = programming.drafts.find((draft) => draft.kind === "note");
  const next = completeDraft(programming, note.key);
  assert.deepEqual(lineChanges(programming.source, next.source), {
    removed: ['              <p class="draft-note" data-draft>'],
    added: ["              <p>"],
  });
  assert.equal(next.drafts.length, programming.drafts.length - 1);

  const physics = loadModel("physics.html");
  const prose = draftAt(physics, 350, "note");
  const after = completeDraft(physics, prose.key);
  assert.deepEqual(lineChanges(physics.source, after.source), {
    removed: ['          <p class="draft-note prose" data-draft>'],
    added: ['          <p class="prose">'],
  });
});

test("Done on an inline slot removes the span's tags and keeps its text", () => {
  const programming = loadModel("programming.html");
  const inline = draftAt(programming, 513, "inline");
  const next = completeDraft(programming, inline.key);
  assert.deepEqual(lineChanges(programming.source, next.source), {
    removed: ['                <span class="draft-inline" data-draft>how many</span> lines of'],
    added: ["                how many lines of"],
  });
  assert.equal(blockText(next, inline.blockKey), blockText(programming, inline.blockKey));
});

test("Done on a hugging inline slot keeps the outer span's hugging end tag", () => {
  const physics = loadModel("physics.html");
  const inline = draftAt(physics, 293, "inline");
  const next = completeDraft(physics, inline.key);
  assert.deepEqual(lineChanges(physics.source, next.source), {
    removed: [
      '                <span class="draft-inline" data-draft',
      "                  >Your reaction, one to three sentences</span",
      "                ></span",
    ],
    added: ["                Your reaction, one to three sentences</span"],
  });
  assert.ok(next.source.includes("<cite>Why Does E=mc²?</cite>\n                Your reaction, one to three sentences</span\n              >"));
});

test("Done on an inline slot that is its list item's only child", () => {
  const physics = loadModel("physics.html");
  const plain = completeDraft(physics, draftAt(physics, 207, "inline").key);
  assert.deepEqual(lineChanges(physics.source, plain.source), {
    removed: ['                    <span class="draft-inline" data-draft>Which term</span>'],
    added: ["                    Which term"],
  });

  const tedx = loadModel("tedx.html");
  const hugging = completeDraft(tedx, draftAt(tedx, 387, "inline").key);
  assert.ok(hugging.source.includes("                  <li>\n                    Rehearsals: dates\n                  </li>\n"));
  assert.deepEqual(lineChanges(tedx.source, hugging.source).removed.length, 3);
});

test("Approve removes only data-draft=\"check\", on an article or a list item", () => {
  const post = loadModel("blog/how-this-site-works.html");
  const article = post.drafts.find((draft) => draft.node.tagName === "article");
  const approved = completeDraft(post, article.key);
  assert.deepEqual(lineChanges(post.source, approved.source), { removed: ['            data-draft="check"'], added: [] });

  const tedx = loadModel("tedx.html");
  const item = draftAt(tedx, 383, "check");
  const next = completeDraft(tedx, item.key);
  assert.deepEqual(lineChanges(tedx.source, next.source), {
    removed: ['                  <li data-draft="check" data-review="2026-11-01">'],
    added: ['                  <li data-review="2026-11-01">'],
  });
  assert.throws(() => completeDraft(tedx, "0.0"), EditRejectedError, "a non-draft is refused");
});

test("the Now helper changes data-updated and the Updated line together", () => {
  assert.equal(updatedLabel("2026-10"), "Updated October 2026");
  const home = loadModel("index.html");
  const next = setNowUpdated(home, "2026-10");
  assert.deepEqual(lineChanges(home.source, next.source), {
    removed: ['          data-updated="2026-09"', '            <p class="now-updated">Updated September 2026</p>'],
    added: ['          data-updated="2026-10"', '            <p class="now-updated">Updated October 2026</p>'],
  });
  assert.equal(next.now.updated, "2026-10");
  assert.throws(() => setNowUpdated(home, "2026-13"), EditRejectedError);
  assert.throws(() => setNowUpdated(loadModel("contact.html"), "2026-10"), EditRejectedError);
});

test("setAttribute changes only a value, or adds the attribute in the tag's own style", () => {
  const home = loadModel("index.html");
  const moreLink = home.links.find((link) => link.href === "/physics/#reading");
  const next = setAttribute(home, moreLink.key, "href", "/physics/#questions");
  assert.deepEqual(lineChanges(home.source, next.source), {
    removed: ['                <a href="/physics/#reading">more of what I read</a> on Physics'],
    added: ['                <a href="/physics/#questions">more of what I read</a> on Physics'],
  });

  // Adding to a one-line tag stays on the line; to a multi-line tag, a new line.
  const single = setAttribute(home, moreLink.key, "title", 'Say "hi" & go');
  assert.ok(single.source.includes('<a href="/physics/#reading" title="Say &quot;hi&quot; &amp; go">'));
  const dusty = home.links.find((link) => link.href === "https://dusty.thomaswhite.me");
  const multi = setAttribute(home, dusty.key, "title", "Dusty");
  assert.deepEqual(lineChanges(home.source, multi.source), { removed: [], added: ['                  title="Dusty"'] });

  const image = home.images.find((item) => item.node.attrs.some((attr) => attr.value === "Tom smiling in a garden"));
  const alt = setAttribute(home, image.key, "alt", "Tom smiling in his garden");
  assert.deepEqual(lineChanges(home.source, alt.source).added, ['                    alt="Tom smiling in his garden"']);
  assert.equal(setAttribute(home, image.key, "alt", "Tom smiling in a garden"), home, "setting the same value is a no-op");
});

test("removeAttribute takes the attribute and the whitespace before it", () => {
  const home = loadModel("index.html");
  const dusty = home.links.find((link) => link.href === "https://dusty.thomaswhite.me");
  const next = removeAttribute(home, dusty.key, "target");
  assert.deepEqual(lineChanges(home.source, next.source), { removed: ['                  target="_blank"'], added: [] });
  const text = textOf(next.nodeOf.get(dusty.key));
  assert.equal(text, "his own website");
  assert.equal(removeAttribute(home, dusty.key, "download"), home);
});

test("the tab fixes add or remove only noopener and noreferrer, keeping other rel tokens", () => {
  const home = loadModel("index.html");
  const reading = home.links.find((link) => link.href === "/physics/#reading");
  const tagged = setAttribute(home, reading.key, "rel", "nofollow author");
  const external = openInNewTab(tagged, reading.key);
  const node = external.nodeOf.get(reading.key);
  const attr = (name) => node.attrs.find((item) => item.name === name)?.value;
  assert.equal(attr("target"), "_blank");
  assert.equal(attr("rel"), "nofollow author noopener noreferrer");

  const back = openInSameTab(external, reading.key);
  const again = back.nodeOf.get(reading.key);
  assert.equal(again.attrs.find((item) => item.name === "target"), undefined);
  assert.equal(again.attrs.find((item) => item.name === "rel").value, "nofollow author");

  const dusty = home.links.find((link) => link.href === "https://dusty.thomaswhite.me");
  const plain = openInSameTab(home, dusty.key).nodeOf.get(dusty.key);
  assert.equal(plain.attrs.some((item) => item.name === "rel" || item.name === "target"), false, "a rel left empty is removed");
  assert.equal(openInNewTab(home, dusty.key).source, home.source, "already new-tab: no change");
});

test("read-only pages refuse draft and attribute changes", () => {
  const cv = loadModel("cv.html");
  assert.throws(() => completeDraft(cv, cv.drafts[0].key), EditRejectedError);
  assert.throws(() => setAttribute(cv, cv.links[0].key, "href", "/"), EditRejectedError);
});
