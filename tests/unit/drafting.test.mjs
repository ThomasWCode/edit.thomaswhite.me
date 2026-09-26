import assert from "node:assert/strict";
import { test } from "node:test";
import { asDraft, discardDraft, draftAround, draftPhrase, liveSource, makeDraft, markDraft, publishDraft, unitOf } from "../../src/drafting.js";
import { commitTextEdit, EditRejectedError, setAttribute, setNowUpdated } from "../../src/edits.js";
import { blockText, collapse, LOCK_REASONS, textOf } from "../../src/page-model.js";
import { blockKeyStarting, editBlock, loadModel, renderedSnapshot, typeInto } from "../support/fixtures.mjs";

const draftsOf = (model, kind) => model.drafts.filter((draft) => draft.kind === kind);

test("any word changed as a draft: the live page is untouched, publishing is the direct edit, discarding restores it", () => {
  let checked = 0;
  for (const path of ["index.html", "programming.html", "physics.html", "tedx.html", "volunteering.html", "gallery.html"]) {
    const model = loadModel(path);
    for (const block of model.blocks) {
      if (block.lock || draftAround(model, block.node)) continue;
      const word = blockText(model, block.key).split(" ").find((item) => /^[a-z]{5,}$/.test(item));
      if (!word) continue;
      let direct;
      try {
        direct = commitTextEdit(model, block.key, typeInto(renderedSnapshot(model, block.key), word, `${word}s`)).model;
      } catch {
        continue;
      }
      const drafted = asDraft(model, direct);
      const where = `${path} ${block.key} (${word})`;
      if (drafted === direct) {
        // The word is inside a draft already (an inline check, say): the edit is to that draft.
        const inside = direct.drafts.some((draft) => collapse(textOf(draft.node)).includes(`${word}s`));
        assert.ok(inside, `${where}: kept as made only when the edit is inside a draft`);
        continue;
      }
      assert.equal(liveSource(drafted), liveSource(model), `${where}: the live page is as it was`);
      const [copy] = draftsOf(drafted, "replace");
      assert.ok(copy, `${where}: a new version was saved`);
      assert.equal(publishDraft(drafted, copy.key).source, direct.source, `${where}: publishing gives the direct edit`);
      assert.equal(discardDraft(drafted, copy.key).source, model.source, `${where}: discarding restores the page`);
      checked += 1;
    }
  }
  assert.ok(checked > 40, `only ${checked} blocks checked`);
});

test("a draft copy sits straight after the live element, which is locked until the draft goes", () => {
  const home = loadModel("index.html");
  const key = blockKeyStarting(home, "Pick whatever");
  const drafted = asDraft(home, editBlock(home, "Pick whatever", "interesting", "interesting today"));
  assert.ok(drafted.source.includes("<p>Pick whatever sounds a bit interesting.</p>\n            <p data-draft=\"replace\">Pick whatever sounds a bit interesting today.</p>\n"));
  assert.equal(drafted.lockReasons.get(key), LOCK_REASONS.replaced, "the live paragraph is locked");
  const [copy] = draftsOf(drafted, "replace");
  const edited = editBlock(drafted, "Pick whatever sounds a bit interesting today", "today", "now");
  assert.equal(asDraft(drafted, edited), edited, "typing in the draft edits the draft");
  assert.ok(edited.nodeOf.get(copy.key));
});

test("links, the Now month and captions: the smallest whole element is the draft", () => {
  const home = loadModel("index.html");
  const reading = home.links.find((link) => link.href === "/physics/#reading");
  const direct = setAttribute(home, reading.key, "href", "/physics/#questions");
  const drafted = asDraft(home, direct);
  const [copy] = draftsOf(drafted, "replace");
  assert.equal(copy.node.tagName, "a", "a link's address drafts just the link");
  assert.ok(drafted.source.includes('<a href="/physics/#reading">more of what I read</a><a data-draft="replace" href="/physics/#questions">more of what I read</a>'));
  assert.equal(liveSource(drafted), liveSource(home));
  assert.equal(publishDraft(drafted, copy.key).source, direct.source);

  const now = setNowUpdated(home, "2026-10");
  const nowDraft = asDraft(home, now);
  const [section] = draftsOf(nowDraft, "replace");
  assert.equal(section.node.tagName, "section", "the Now month and its line go together");
  assert.ok(!/<section[^>]*data-draft="replace"[^>]*\sid=/.test(nowDraft.source), "the copy's ids are renamed");
  assert.equal(publishDraft(nowDraft, section.key).source, now.source, "and publishing names them back");

  const gallery = loadModel("gallery.html");
  const image = gallery.images.find((item) => item.gallery);
  const captioned = setAttribute(gallery, image.gallery.buttonKey, "data-caption", "A new caption");
  const figure = draftsOf(asDraft(gallery, captioned), "replace")[0];
  assert.ok(["figure", "li"].includes(figure.node.tagName), figure.node.tagName);

  // The portrait note shares the first section with the page's h1, and a
  // quote's attribution sits inside the pinned quote: each block alone is copied.
  for (const [path, from, to, tag] of [
    ["index.html", "Hello from London :)", "Hello from London!", "span"],
    ["testimonials.html", "Analisa Plehn, St John’s Garden", "Analisa Plehn, St John’s Garden, London", "footer"],
  ]) {
    const model = loadModel(path);
    const edited = editBlock(model, from, from, to);
    const drafted = asDraft(model, edited);
    const [own] = draftsOf(drafted, "replace");
    assert.equal(own.node.tagName, tag, `${path}: just the ${tag}`);
    assert.equal(drafted.blocks.filter((block) => block.lock === LOCK_REASONS.h1).length, model.blocks.filter((block) => block.lock === LOCK_REASONS.h1).length);
    assert.equal(liveSource(drafted), liveSource(model), `${path}: the live page is untouched`);
    assert.equal(publishDraft(drafted, own.key).source, edited.source, `${path}: publishing is the direct edit`);
    assert.equal(discardDraft(drafted, own.key).source, model.source, `${path}: discarding restores it`);
  }
});

test("marking whole elements: new keeps them off the site, remove keeps them on until published", () => {
  const home = loadModel("index.html");
  const key = blockKeyStarting(home, "Pick whatever");
  const hidden = makeDraft(home, key);
  assert.ok(!liveSource(hidden).includes("Pick whatever"), "a new draft is off the live site");
  assert.equal(publishDraft(hidden, draftsOf(hidden, "new")[0].key).source, home.source, "publishing puts it back exactly");
  assert.ok(!discardDraft(hidden, draftsOf(hidden, "new")[0].key).source.includes("Pick whatever"), "discarding deletes it");

  const going = markDraft(home, key, "remove");
  assert.equal(liveSource(going), liveSource(home), "a removal stays live until published");
  assert.ok(!publishDraft(going, key).source.includes("Pick whatever"));
  assert.equal(discardDraft(going, key).source, home.source, "calling it off restores the page");

  const physics = loadModel("physics.html");
  const label = blockKeyStarting(physics, "Dennis E. Taylor");
  assert.equal(physics.nodeOf.get(unitOf(physics, label)).tagName, "li", "a dated item's label drafts the whole item");
  assert.throws(() => markDraft(hidden, draftsOf(hidden, "new")[0].key, "remove"), EditRejectedError);

  // The site's tests need the page heading and Analisa's words on the live page.
  for (const [path, reason] of [["index.html", LOCK_REASONS.h1], ["testimonials.html", LOCK_REASONS.analisa]]) {
    const model = loadModel(path);
    const pinned = model.blocks.find((block) => block.lock === reason);
    assert.throws(() => makeDraft(model, pinned.key), /page heading or a quoted testimonial/, `${path}: ${reason}`);
    assert.throws(() => markDraft(model, unitOf(model, pinned.key), "remove"), /page heading or a quoted testimonial/);
  }
});

test("phrases: words in one run of text, wrapped; the whole text marks the block", () => {
  const home = loadModel("index.html");
  const key = blockKeyStarting(home, "Pick whatever");
  const text = blockText(home, key);
  const start = text.indexOf("a bit");
  const drafted = draftPhrase(home, key, start, start + "a bit ".length, "new");
  assert.ok(drafted.source.includes('<p>Pick whatever sounds <span data-draft="new">a bit</span> interesting.</p>'), "trimmed to its words");
  assert.ok(liveSource(drafted).includes("<p>Pick whatever sounds interesting.</p>"), "no double space live");
  const phrase = draftsOf(drafted, "new")[0];
  assert.equal(publishDraft(drafted, phrase.key).source, home.source, "publishing unwraps it");
  assert.ok(discardDraft(drafted, phrase.key).source.includes("<p>Pick whatever sounds interesting.</p>"));

  const going = draftPhrase(home, key, start, start + 5, "remove");
  assert.equal(liveSource(going), liveSource(home), "a phrase to remove stays live");
  assert.equal(discardDraft(going, draftsOf(going, "remove")[0].key).source, home.source);

  const whole = draftPhrase(home, key, 0, text.length, "new");
  assert.equal(draftsOf(whole, "new")[0].node.tagName, "p", "the whole text marks the paragraph instead");

  const contact = loadModel("contact.html");
  const ampersand = contact.blocks.find((block) => blockText(contact, block.key).includes("&"));
  if (ampersand) {
    const words = blockText(contact, ampersand.key);
    const at = words.indexOf("&");
    const marked = draftPhrase(contact, ampersand.key, at, at + 1, "remove");
    assert.equal(blockText(marked, ampersand.key), words, "an entity stays one character");
  }
});
