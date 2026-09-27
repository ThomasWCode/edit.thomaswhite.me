import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asDraft,
  discardDraft,
  draftAround,
  draftPhrase,
  hasWaitingVersion,
  LIVE_CHANGED,
  liveAsItWas,
  liveChanged,
  liveSource,
  makeDraft,
  markDraft,
  publishDraft,
  recordLive,
  refuseWaitingChange,
  sourceHash,
  unitOf,
} from "../../src/drafting.js";
import { commitTextEdit, EditRejectedError, setAttribute, setNowUpdated } from "../../src/edits.js";
import { attribute, blockText, buildPageModel, collapse, LOCK_REASONS, textOf } from "../../src/page-model.js";
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
  const of = sourceHash("<p>Pick whatever sounds a bit interesting.</p>");
  assert.ok(drafted.source.includes(`<p>Pick whatever sounds a bit interesting.</p>\n            <p data-draft="replace" data-draft-of="${of}">Pick whatever sounds a bit interesting today.</p>\n`));
  assert.equal(drafted.lockReasons.get(key), LOCK_REASONS.replaced, "the live paragraph is locked");
  const [copy] = draftsOf(drafted, "replace");
  const edited = editBlock(drafted, "Pick whatever sounds a bit interesting today", "today", "now");
  assert.equal(asDraft(drafted, edited), edited, "typing in the draft edits the draft");
  assert.ok(edited.nodeOf.get(copy.key));
});

test("a new version records its live element, and isn't published once that changes until it is recorded again", () => {
  const home = loadModel("index.html");
  const live = "<p>Pick whatever sounds a bit interesting.</p>";
  const drafted = asDraft(home, editBlock(home, "Pick whatever", "interesting", "interesting today"));
  const [copy] = draftsOf(drafted, "replace");
  const of = attribute(copy.node, "data-draft-of");
  assert.match(of, /^[0-9a-f]{8}$/);
  assert.equal(of, sourceHash(live), "a short hash of the live element's source");
  assert.equal(liveChanged(drafted, copy.key), false);

  // main changes another word of the live paragraph, and it is merged in.
  const merged = loadModel("index.html", drafted.source.replace(live, "<p>Pick anything that sounds a bit interesting.</p>"));
  const [waiting] = draftsOf(merged, "replace");
  assert.equal(liveChanged(merged, waiting.key), true);
  assert.throws(() => publishDraft(merged, waiting.key), (error) => error instanceof EditRejectedError && error.message === LIVE_CHANGED);
  assert.deepEqual(liveAsItWas(drafted.source, "index.html", of), { source: live, text: "Pick whatever sounds a bit interesting." }, "found in the version it was made from");
  assert.equal(liveAsItWas(merged.source, "index.html", of), null, "and not in the changed one");

  // Tom carries main's change into the new version, records the live one as it is now, and publishes.
  const carried = editBlock(merged, "Pick whatever sounds a bit interesting today", "Pick whatever sounds", "Pick anything that sounds");
  const key = draftsOf(carried, "replace")[0].key;
  assert.equal(liveChanged(carried, key), true, "typing in the new version records nothing");
  const recorded = recordLive(carried, key);
  assert.equal(liveChanged(recorded, key), false);
  assert.equal(recorded.source.length, carried.source.length, "only the recorded hash changed");
  const published = publishDraft(recorded, key);
  assert.ok(published.source.includes("<p>Pick anything that sounds a bit interesting today.</p>"), "both changes are live");
  assert.ok(!published.source.includes("data-draft"), "the marker and the record go");
  const expected = merged.source.replace(
    `<p>Pick anything that sounds a bit interesting.</p>\n            <p data-draft="replace" data-draft-of="${of}">Pick whatever sounds a bit interesting today.</p>`,
    "<p>Pick anything that sounds a bit interesting today.</p>",
  );
  assert.notEqual(expected, merged.source);
  assert.equal(published.source, expected, "exactly the live paragraph with both changes");

  // A new version with no record can't be told apart from a changed one: it waits too.
  const unrecorded = loadModel("index.html", drafted.source.replace(` data-draft-of="${of}"`, ""));
  const bare = draftsOf(unrecorded, "replace")[0];
  assert.equal(liveChanged(unrecorded, bare.key), true);
  assert.throws(() => publishDraft(unrecorded, bare.key), EditRejectedError);
  assert.equal(liveChanged(recordLive(unrecorded, bare.key), bare.key), false);
});

test("links, the Now month and captions: the smallest whole element is the draft", () => {
  const home = loadModel("index.html");
  const reading = home.links.find((link) => link.href === "/physics/#reading");
  const direct = setAttribute(home, reading.key, "href", "/physics/#questions");
  const drafted = asDraft(home, direct);
  const [copy] = draftsOf(drafted, "replace");
  assert.equal(copy.node.tagName, "a", "a link's address drafts just the link");
  const of = sourceHash('<a href="/physics/#reading">more of what I read</a>');
  assert.ok(drafted.source.includes(`<a href="/physics/#reading">more of what I read</a><a data-draft="replace" data-draft-of="${of}" href="/physics/#questions">more of what I read</a>`));
  assert.equal(liveSource(drafted), liveSource(home));
  assert.equal(publishDraft(drafted, copy.key).source, direct.source);

  const now = setNowUpdated(home, "2026-10");
  const nowDraft = asDraft(home, now);
  const [section] = draftsOf(nowDraft, "replace");
  assert.equal(section.node.tagName, "section", "the Now month and its line go together");
  assert.ok(!/<section[^>]*data-draft="replace"[^>]*\sid=/.test(nowDraft.source), "the copy's ids are renamed");
  assert.equal(publishDraft(nowDraft, section.key).source, now.source, "and publishing names them back");
  // With a new version waiting, the Now helper sets that version, not the live section.
  assert.equal(nowDraft.now.key, section.key);
  const again = setNowUpdated(nowDraft, "2026-11");
  assert.equal(asDraft(nowDraft, again), again, "a change to the draft, not a second copy");
  assert.equal(draftsOf(again, "replace").length, 1);
  assert.equal(liveSource(again), liveSource(home), "the live section still waits");
  assert.equal(publishDraft(again, section.key).source, setNowUpdated(home, "2026-11").source);

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

test("a live element with a new version waiting stays as it is, drafts on or off", () => {
  const home = loadModel("index.html");
  const reading = home.links.find((link) => link.href === "/physics/#reading");
  const drafted = asDraft(home, setAttribute(home, reading.key, "href", "/physics/#questions"));
  const live = drafted.links.find((link) => link.href === "/physics/#reading");
  const copy = drafted.links.find((link) => link.href === "/physics/#questions");
  assert.ok(hasWaitingVersion(drafted, live.node) && !hasWaitingVersion(drafted, copy.node), "the live link waits; its copy is the one to change");
  const again = setAttribute(drafted, live.key, "href", "/physics/#ideas");
  assert.throws(() => asDraft(drafted, again), /waiting as a draft/, "no second version");
  assert.throws(() => refuseWaitingChange(drafted, again), /waiting as a draft/, "nor a direct change under the draft");
  const copyChanged = setAttribute(drafted, copy.key, "href", "/physics/#ideas");
  assert.doesNotThrow(() => refuseWaitingChange(drafted, copyChanged));
  assert.equal(asDraft(drafted, copyChanged), copyChanged, "changing the copy changes the draft");
});

test("content marked to remove is still live: a change to it can't wait as a draft", () => {
  const home = loadModel("index.html");
  const key = blockKeyStarting(home, "Pick whatever");
  const going = markDraft(home, key, "remove");
  const edited = editBlock(going, "Pick whatever", "interesting", "fascinating");
  assert.throws(() => asDraft(going, edited), /marked to remove/);

  const physics = loadModel("physics.html");
  const label = blockKeyStarting(physics, "Dennis E. Taylor");
  const list = physics.nodeOf.get(unitOf(physics, label)).parentNode;
  const listGoing = markDraft(physics, physics.keyOf.get(list), "remove");
  const inside = asDraft(listGoing, editBlock(listGoing, "Dennis E. Taylor", "Dennis", "Denis"));
  assert.equal(draftsOf(inside, "replace").length, 1, "an item inside a removal gets a new version of its own");
  assert.equal(liveSource(inside), liveSource(listGoing), "and nothing live changes");
});

test("a draft is never wrapped in another: publish or discard the inner one first", () => {
  const home = loadModel("index.html");
  const key = blockKeyStarting(home, "Pick whatever");
  const text = blockText(home, key);
  const at = text.indexOf("a bit");
  const phrase = draftPhrase(home, key, at, at + "a bit".length, "new");
  assert.throws(() => makeDraft(phrase, key), /holds a draft already/);
  assert.throws(() => markDraft(phrase, key, "remove"), /holds a draft already/);
});

test("leaving out a phrase before punctuation takes the space before it, as the site's build does", () => {
  const home = loadModel("index.html");
  const key = blockKeyStarting(home, "Pick whatever");
  const text = blockText(home, key);
  const at = text.indexOf("interesting");
  const last = draftPhrase(home, key, at, at + "interesting".length, "new");
  assert.ok(last.source.includes('<p>Pick whatever sounds a bit <span data-draft="new">interesting</span>.</p>'));
  assert.ok(liveSource(last).includes("<p>Pick whatever sounds a bit.</p>"), "no “a bit .”");
  assert.ok(discardDraft(last, draftsOf(last, "new")[0].key).source.includes("<p>Pick whatever sounds a bit.</p>"));
  const going = draftPhrase(home, key, at, at + "interesting".length, "remove");
  assert.ok(publishDraft(going, draftsOf(going, "remove")[0].key).source.includes("<p>Pick whatever sounds a bit.</p>"));
  assert.equal(liveSource(going), liveSource(home), "a phrase to remove stays live until published");
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

  // An entity that decodes to two UTF-16 units (an emoji) before the words.
  const emoji = buildPageModel(home.source.replace("<p>Pick whatever", "<p>Pick &#x1F600; whatever"), { path: home.path });
  const emojiKey = blockKeyStarting(emoji, "Pick");
  const emojiText = blockText(emoji, emojiKey);
  const at = emojiText.indexOf("whatever");
  const wrapped = draftPhrase(emoji, emojiKey, at, at + "whatever".length, "new");
  assert.ok(wrapped.source.includes('<p>Pick &#x1F600; <span data-draft="new">whatever</span> sounds'), "wraps exactly the words chosen");
});
