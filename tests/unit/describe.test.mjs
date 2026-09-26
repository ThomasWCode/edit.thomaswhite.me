import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoTitleOf,
  bodyText,
  CHANGES_END,
  CHANGES_START,
  commitMessageFor,
  describeFile,
  forAi,
  hasAutoTitle,
  itemLine,
  noteOf,
  prDescription,
  SUBJECT_LIMIT,
  summarise,
  wordChange,
} from "../../src/describe.js";
import { asDraft, discardDraft, makeDraft, publishDraft } from "../../src/drafting.js";
import { completeDraft, setAttribute, setNowUpdated } from "../../src/edits.js";
import { collapse, textOf } from "../../src/page-model.js";
import { addAfter, removeBlock } from "../../src/structure.js";
import { blockKeyStarting, editBlock, loadModel, readFixture } from "../support/fixtures.mjs";

// A page's description from a model and the model after an edit.
const described = (before, after) =>
  describeFile({ path: before.path, before: before.source, after: after.source, beforeModel: before, afterModel: after });

const physics = loadModel("physics.html");
const programming = loadModel("programming.html");
const home = loadModel("index.html");

test("one word changed: the subject names it, on one page or several", () => {
  const onPhysics = described(physics, editBlock(physics, "Game of Life", "then see which", "then watch which"));
  assert.deepEqual(onPhysics.items.map((item) => item.kind), ["text"]);
  assert.equal(onPhysics.label, "Physics & Ideas");
  assert.equal(summarise([onPhysics]), "Physics & Ideas: “see” → “watch”");
  assert.equal(itemLine(onPhysics.items[0]), "“… add live cells, then see which patterns survive.” → “… add live cells, then watch which patterns survive.”");

  const onProgramming = described(programming, editBlock(programming, "Game of Life", "then see which", "then watch which"));
  assert.equal(summarise([onPhysics, onProgramming]), "“see” → “watch” on Physics & Ideas and Programming");
  assert.equal(
    commitMessageFor([onPhysics]),
    "Physics & Ideas: “see” → “watch”\n\nPhysics & Ideas (physics.html)\n- “… add live cells, then see which patterns survive.” → “… add live cells, then watch which patterns survive.”\n",
  );
});

test("wordChange: one short run of words, or nothing", () => {
  const change = (before, after) => wordChange({ kind: "text", before, after });
  assert.equal(change("I like red apples", "I like green apples"), "“red” → “green”");
  assert.equal(change("I like apples", "I really like apples"), "add “really”");
  assert.equal(change("I really like apples", "I like apples"), "remove “really”");
  assert.equal(change("a b c d", "x b c y"), null, "two separate changes");
  assert.equal(change("short", "a much longer replacement than a subject can hold"), null);
  assert.equal(wordChange({ kind: "added", text: "x" }), null);
});

test("drafts done and approved, found by count and text", () => {
  const note = programming.drafts.find((draft) => draft.kind === "note" && collapse(textOf(draft.node)).startsWith("Two or three screenshots"));
  const done = described(programming, completeDraft(programming, note.key));
  assert.deepEqual(done.items, [{ kind: "draft-done", text: "Two or three screenshots of the guides and the backup app." }]);
  assert.equal(summarise([done]), "Programming: finish the draft “Two or three screenshots of the…”");

  const post = loadModel("blog/how-this-site-works.html");
  const check = post.drafts.find((draft) => draft.kind === "check");
  const approved = described(post, completeDraft(post, check.key));
  assert.equal(approved.items[0].kind, "approved");
  assert.match(itemLine(approved.items[0]), /^Approved a checked draft/);
});

test("a list item added or removed is one item, and the blocks after it are unchanged", () => {
  const itemKey = physics.blockByKey.get(blockKeyStarting(physics, "Dennis E. Taylor")).structuralKey;
  const { model: added } = addAfter(physics, itemKey);
  const addition = described(physics, added);
  assert.deepEqual(addition.items.map((item) => [item.kind, item.tag]), [["added", "li"]]);
  assert.equal(summarise([addition]), "Physics & Ideas: add a list item “Label — New item”");

  const removal = described(physics, removeBlock(physics, itemKey));
  assert.deepEqual(removal.items.map((item) => [item.kind, item.tag]), [["removed", "li"]]);
  assert.match(itemLine(removal.items[0]), /^Removed a list item: “Dennis E\. Taylor — All of the Bobiverse books/);
});

test("a removal or an insertion next to a rewording is paired by shared words, not position", () => {
  const lucky = programming.blockByKey.get(blockKeyStarting(programming, "I consider myself lucky")).structuralKey;
  const removedThenReworded = editBlock(removeBlock(programming, lucky), "Since then I", "Since then I’ve made", "Since then I have made");
  const first = described(programming, removedThenReworded);
  assert.deepEqual(first.items.map((item) => item.kind), ["text", "removed"]);
  assert.match(itemLine(first.items[0]), /^“Since then I’ve made .*” → “Since then I have made /);
  assert.match(itemLine(first.items[1]), /^Removed a paragraph: “I consider myself lucky/);

  const lua = programming.blockByKey.get(blockKeyStarting(programming, "My first language was Lua")).structuralKey;
  const insertedThenReworded = editBlock(addAfter(programming, lua).model, "I consider myself lucky", "myself lucky", "myself fortunate");
  const second = described(programming, insertedThenReworded);
  assert.deepEqual(second.items.map((item) => item.kind), ["text", "added"]);
  assert.match(itemLine(second.items[0]), /“I consider myself lucky .*” → “I consider myself fortunate/);
  assert.equal(second.items[1].text, "New paragraph");

  const rewritten = describeFile({ path: "x.md", before: "The first line.\n", after: "Something else entirely.\n" });
  assert.deepEqual(rewritten.items.map((item) => item.kind), ["text"], "one line rewritten outright is still a rewording");
});

test("link addresses and tabs, alt text, and the Now month", () => {
  const reading = home.links.find((link) => link.href === "/physics/#reading");
  const moved = described(home, setAttribute(home, reading.key, "href", "/physics/#questions"));
  assert.deepEqual(moved.items, [{ kind: "link", text: "more of what I read", before: "/physics/#reading", after: "/physics/#questions" }]);
  assert.equal(summarise([moved]), "Home: point “more of what I read” at /physics/#questions");

  const image = home.images.find((item) => item.node.attrs.some((attr) => attr.value === "Tom smiling in a garden"));
  const alt = described(home, setAttribute(home, image.key, "alt", "Tom smiling in his garden"));
  assert.equal(itemLine(alt.items[0]), "Alt text: “Tom smiling in a garden” → “Tom smiling in his garden”");

  const now = described(home, setNowUpdated(home, "2026-10"));
  assert.deepEqual(now.items, [{ kind: "updated", before: "2026-09", after: "2026-10" }], "the Updated line itself is not a second change");
  assert.equal(summarise([now]), "Home: Now section updated for October 2026");
});

test("Markdown: changed lines, and the Record's label", () => {
  const record = readFixture("docs/record.md");
  const file = describeFile({ path: "docs/record.md", before: record, after: `${record}- A new fact.\n` });
  assert.equal(file.label, "Record");
  assert.deepEqual(file.items, [{ kind: "added", tag: "line", text: "- A new fact." }]);
  assert.equal(summarise([file]), "Record: add a line “- A new fact.”");
  const page = described(physics, editBlock(physics, "Game of Life", "then see which", "then watch which"));
  assert.equal(summarise([page, file]), "Physics & Ideas and the Record: 1 wording change, 1 line added");
  assert.equal(bodyText([file]), "Record (docs/record.md)\n- Added a line: “- A new fact.”");

  const spacing = describeFile({ path: "docs/record.md", before: "a\n\nb\n", after: "a\n\n\nb\n" });
  assert.deepEqual(spacing.items, [{ kind: "spacing" }], "blank lines alone are still a change");
  assert.equal(summarise([spacing]), "Record: changed only blank lines or spacing");
});

test("subjects never pass 72 characters; many changes fall back to counts", () => {
  const labels = ["Home", "Programming", "Physics & Ideas", "Volunteering", "Contact", "TEDx"];
  const files = labels.map((label, index) => ({
    path: `page-${index}.html`,
    label,
    page: true,
    items: [{ kind: "text", before: `word${index} old`, after: `word${index} new` }, { kind: "draft-done", text: "" }],
  }));
  assert.equal(summarise(files), "Edit 6 pages: 6 wording changes, 6 drafts done");
  const long = summarise([{ path: "x.html", label: "A page with a title far longer than any subject line could ever hold", page: true, items: [{ kind: "markup" }, { kind: "markup" }] }]);
  assert.ok(long.length <= SUBJECT_LIMIT, long);
  assert.equal(summarise([]), "Edit the site");
});

test("the pull request description: note, refreshed changes, footer, and the generated title", () => {
  const page = described(physics, editBlock(physics, "Game of Life", "then see which", "then watch which"));
  const title = summarise([page]);
  const body = prDescription({ note: "Please check @codex <b>this</b>.", files: [page], screenshots: ["tests/visual/x/programming-desktop.png"], autoTitle: title });
  assert.ok(body.startsWith("Please check @codex <b>this</b>.\n\n<!-- editor:changes -->\n### Changes"), "your note is kept as written");
  assert.ok(body.includes("- `programming-desktop.png`"));
  assert.ok(body.includes(CHANGES_START) && body.includes(CHANGES_END));
  assert.equal(noteOf(body), "Please check @codex <b>this</b>.");
  assert.equal(autoTitleOf(body), title);
  assert.equal(hasAutoTitle({ title, body }, "Text edits from the editor"), true);
  assert.equal(hasAutoTitle({ title: "My own title", body }, "Text edits from the editor"), false);
  assert.equal(hasAutoTitle({ title: "Text edits from the editor", body: "" }, "Text edits from the editor"), true, "the old fixed title");
  assert.equal(noteOf("Edits made at https://edit.thomaswhite.me.\n\nPages changed: …"), "", "an old generated body holds no note");

  // Page text can't mention anyone or add HTML: "@" gets a zero-width space, markup is escaped.
  const risky = describeFile({ path: "x.md", before: "Hi\n", after: "Hi @codex <script>\n" });
  const escaped = prDescription({ files: [risky], autoTitle: "x" });
  assert.match(escaped, /@​codex \\<script\\>/);
  assert.ok(!escaped.includes("@codex"), "no mention reaches GitHub");
});

test("drafts: saved, published, discarded and taken off the live site are told apart", () => {
  const drafted = asDraft(home, editBlock(home, "Pick whatever", "interesting", "fascinating"));
  const saved = described(home, drafted);
  assert.deepEqual(saved.items.map((item) => item.kind), ["draft-added"], "nothing live changed");
  assert.equal(summarise([saved]), "Home: draft “interesting.” → “fascinating.”");
  assert.match(itemLine(saved.items[0]), /^Draft of a new version \(not live\): “Pick whatever/);

  const copy = drafted.drafts.find((draft) => draft.kind === "replace").key;
  const published = described(drafted, publishDraft(drafted, copy));
  assert.equal(summarise([published]), "Home: “interesting.” → “fascinating.”", "publishing is the live change itself");
  assert.deepEqual(described(drafted, discardDraft(drafted, copy)).items.map((item) => item.kind), ["draft-discarded"]);

  const off = described(home, makeDraft(home, blockKeyStarting(home, "Pick whatever")));
  assert.deepEqual(off.items.map((item) => item.kind), ["unpublished"]);
  assert.equal(summarise([off]), "Home: take “Pick whatever sounds a bit…” off the live site");

  const body = prDescription({ files: [saved, off], autoTitle: "x" });
  assert.ok(body.indexOf("### Changes") < body.indexOf("### Drafts (saved, left out of thomaswhite.me)"), "live changes, then drafts");
  assert.match(body, /### Drafts \(saved, left out of thomaswhite\.me\)\n\n\*\*Home\*\*/);
});

test("forAi: published changes as lines, private files as a count", () => {
  const page = described(physics, editBlock(physics, "Game of Life", "then see which", "then watch which"));
  const record = readFixture("docs/record.md");
  const privateFile = describeFile({ path: "docs/record.md", before: record, after: `${record}- Secret.\n- Another.\n` });
  const source = describeFile({ path: "docs/blog-sources/my-secret-post.md", before: "a\n", after: "b\n" });
  assert.equal(source.label, "Blog source my-secret-post", "the editor itself may show the name");
  const sent = forAi([page, privateFile, source]);
  assert.deepEqual(sent[0], { file: "Physics & Ideas", path: "physics.html", changes: [itemLine(page.items[0])] });
  assert.deepEqual(sent[1], { file: "Record", path: "docs/record.md", changes: ["2 changes (private file: content not shared)"] });
  assert.deepEqual(sent[2], { file: "Blog source", path: "docs/blog-sources/", changes: ["1 change (private file: content not shared)"] });
  const text = JSON.stringify(sent);
  assert.ok(!text.includes("Secret") && !text.includes("secret"), "neither the Record's text nor a post's title-derived name");
});
