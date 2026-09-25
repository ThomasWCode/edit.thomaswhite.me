import assert from "node:assert/strict";
import { test } from "node:test";
import { commitTextEdit, EditRejectedError } from "../../src/edits.js";
import { blockText, buildPageModel } from "../../src/page-model.js";
import { textNode } from "../../src/snapshot.js";
import { escapeText } from "../../src/splice.js";
import { lineChanges, loadModel, PAGE_FILES, readFixture, renderedSnapshot, typeInto } from "../support/fixtures.mjs";

function keyOfText(model, startsWith) {
  const block = model.blocks.find((item) => blockText(model, item.key).startsWith(startsWith));
  assert.ok(block, `no block starting "${startsWith}"`);
  return block.key;
}

function edit(model, startsWith, from, to) {
  const key = keyOfText(model, startsWith);
  return commitTextEdit(model, key, typeInto(renderedSnapshot(model, key), from, to));
}

test("a one-word edit changes exactly one line and leaves &amp; alone", () => {
  const model = loadModel("index.html");
  const { model: next, changed } = edit(model, "Running is my favourite", "favourites", "loves");
  assert.ok(changed);
  assert.deepEqual(lineChanges(model.source, next.source), {
    removed: ["                favourites, and there’s"],
    added: ["                loves, and there’s"],
  });
  assert.ok(next.source.includes("on Physics\n                &amp; Ideas."));

  const heading = edit(model, "Physics & Ideas", "Ideas", "Thinking");
  assert.deepEqual(lineChanges(model.source, heading.model.source), {
    removed: ["                <h3>Physics &amp; Ideas</h3>"],
    added: ["                <h3>Physics &amp; Thinking</h3>"],
  });
});

test("typed & and < are escaped, and hugging tags stay byte for byte", () => {
  const model = loadModel("index.html");
  const { model: next } = edit(model, "I also have a cat", "...", "... & <3");
  assert.deepEqual(lineChanges(model.source, next.source), {
    removed: ["                >..."],
    added: ["                >... &amp; &lt;3"],
  });
  assert.ok(next.source.includes(">his own website</a\n                >... &amp; &lt;3\n"));
  assert.match(blockText(next, keyOfText(next, "I also have a cat")), /website\.\.\. & <3$/);
});

test("non-breaking spaces: an unchanged block is a no-op and a typed one becomes a space", () => {
  const model = loadModel("index.html");
  const key = keyOfText(model, "Pick whatever");
  const unchanged = typeInto(renderedSnapshot(model, key), "sounds a bit", "sounds a bit");
  assert.equal(commitTextEdit(model, key, unchanged).changed, false);

  const typed = typeInto(renderedSnapshot(model, key), "a bit interesting", "a bit more interesting");
  const { model: next } = commitTextEdit(model, key, typed);
  assert.ok(next.source.includes("<p>Pick whatever sounds a bit more interesting.</p>"));
  assert.ok(!next.source.includes(" "));
});

test("whitespace the browser collapsed or rewrapped is not a change", () => {
  const model = loadModel("index.html");
  const key = keyOfText(model, "I’m in Year 12");
  const snapshot = renderedSnapshot(model, key);
  const rewrapped = { ...snapshot, children: snapshot.children.map((child) => (child.type === "text" ? textNode(child.text.replace(/\s+/g, " ")) : child)) };
  assert.equal(commitTextEdit(model, key, rewrapped).changed, false);

  // A real edit elsewhere in the block still keeps every untouched line.
  const edited = typeInto(rewrapped, "hiking", "climbing");
  const { model: next } = commitTextEdit(model, key, edited);
  assert.deepEqual(lineChanges(model.source, next.source).added, [
    "                drumming and climbing. I started programming when I was seven and",
  ]);
});

test("an emptied paragraph with Chrome's trailing <br> saves as an empty element", () => {
  const model = loadModel("index.html");
  const key = keyOfText(model, "Pick whatever");
  const snapshot = renderedSnapshot(model, key);
  const emptied = { ...snapshot, children: [{ type: "element", key: null, tag: "br", attrs: [], children: [] }] };
  const { model: next, changed } = commitTextEdit(model, key, emptied);
  assert.ok(changed);
  assert.deepEqual(lineChanges(model.source, next.source), {
    removed: ["            <p>Pick whatever sounds a bit interesting.</p>"],
    added: ["            <p></p>"],
  });
});

test("deleting across a link re-serialises the block, reusing the surviving tags", () => {
  const model = loadModel("blog/how-this-site-works.html");
  const key = keyOfText(model, "Tests only prove");
  const snapshot = renderedSnapshot(model, key);
  // The person selected "on a status page" and deleted it: the link is gone.
  const [before, , after] = snapshot.children;
  const children = [textNode(before.text.replace("results on a\n              ", "results")), textNode(after.text)];
  const { model: next, changed, restructured } = commitTextEdit(model, key, { ...snapshot, children });
  assert.ok(changed && restructured);
  const text = blockText(next, key);
  assert.ok(text.includes("publishes the results, linked in the footer."), text);
  assert.ok(!next.source.includes("status page</a"));
  const { removed, added } = lineChanges(model.source, next.source);
  assert.equal(added.length, 1);
  assert.equal(added[0], "              publishes the results, linked in the footer. A scheduled job also checks the live pages every");
  assert.equal(removed.length, 8, "the line before the link, its six lines and the line after collapse into one");
});

test("the text after a <cite> and inside a draft span is one editable", () => {
  const model = loadModel("physics.html");
  const key = keyOfText(model, "Immune");
  const { model: next } = commitTextEdit(model, key, typeInto(renderedSnapshot(model, key), "One line on why", "How your immune system works, in detail."));
  assert.deepEqual(lineChanges(model.source, next.source), {
    removed: ['                <span class="draft-inline" data-draft>One line on why</span></span'],
    added: ['                <span class="draft-inline" data-draft>How your immune system works, in detail.</span></span'],
  });
});

test("an edit inside an inline draft changes only the words in it", () => {
  const model = loadModel("programming.html");
  const key = keyOfText(model, "It was my biggest project");
  const { model: next } = commitTextEdit(model, key, typeInto(renderedSnapshot(model, key), "how many", "3,000"));
  assert.deepEqual(lineChanges(model.source, next.source), {
    removed: ['                <span class="draft-inline" data-draft>how many</span> lines of'],
    added: ['                <span class="draft-inline" data-draft>3,000</span> lines of'],
  });
});

test("offsets are UTF-16: an emoji earlier in the page does not shift the edit", () => {
  const source = readFixture("index.html").replace('<p class="eyebrow">Heyyy</p>', '<p class="eyebrow">Heyyy 🎉😀</p>');
  const model = buildPageModel(source, { path: "index.html" });
  const { model: next } = edit(model, "Pick whatever", "sounds a bit", "looks");
  assert.deepEqual(lineChanges(model.source, next.source), {
    removed: ["            <p>Pick whatever sounds a bit interesting.</p>"],
    added: ["            <p>Pick whatever looks interesting.</p>"],
  });
  assert.ok(next.source.includes("Heyyy 🎉😀"));
});

test("saved files keep LF endings and the final newline", () => {
  const model = loadModel("programming.html");
  const { model: next } = edit(model, "My first language was Lua", "Lua", "Lua (on Roblox)");
  assert.ok(!next.source.includes("\r"));
  assert.ok(next.source.endsWith("</html>\n"));
});

test("the round trip refuses a change it cannot reproduce exactly", () => {
  const model = loadModel("index.html");
  const key = keyOfText(model, "Pick whatever");
  // parse5 (like a browser) turns NUL into U+FFFD, so the saved text would differ.
  assert.throws(
    () => commitTextEdit(model, key, typeInto(renderedSnapshot(model, key), "bit", "b\u0000it")),
    (error) => error instanceof EditRejectedError && error.typedText.includes("\u0000"),
  );
  // An element the browser invented (not a style wrapper) is refused.
  const snapshot = renderedSnapshot(model, key);
  const invented = { ...snapshot, children: [...snapshot.children, { type: "element", key: null, tag: "img", attrs: [["src", "x"]], children: [] }] };
  assert.throws(() => commitTextEdit(model, key, invented), EditRejectedError);
  // Locked blocks and read-only pages refuse edits.
  const h1 = model.blocks.find((block) => block.tag === "h1").key;
  assert.throws(() => commitTextEdit(model, h1, renderedSnapshot(model, h1)), EditRejectedError);
  const cv = loadModel("cv.html");
  const cvKey = cv.blocks[3].key;
  assert.throws(() => commitTextEdit(cv, cvKey, renderedSnapshot(cv, cvKey)), EditRejectedError);
});

test("browser style wrappers are unwrapped before merging", () => {
  const model = loadModel("index.html");
  const key = keyOfText(model, "Pick whatever");
  const snapshot = renderedSnapshot(model, key);
  const wrapped = {
    ...snapshot,
    children: [
      textNode("Pick whatever "),
      { type: "element", key: null, tag: "span", attrs: [["style", "font-weight: 400"]], children: [textNode("sounds")] },
      textNode(" a bit interesting."),
    ],
  };
  assert.equal(commitTextEdit(model, key, wrapped).changed, false);
});

// Plan test 19: every editable block of every fixture survives a no-op commit
// and a one-word change touches only the line holding that word.
test("property: every block round-trips, and its longest word can be replaced on its own line", () => {
  let checked = 0;
  for (const path of PAGE_FILES) {
    const model = loadModel(path);
    if (model.readOnly) continue;
    for (const block of model.blocks) {
      if (block.lock) continue;
      const snapshot = renderedSnapshot(model, block.key);
      assert.equal(commitTextEdit(model, block.key, snapshot).changed, false, `${path} ${block.key} no-op`);

      // Candidate words come from single text nodes ("website</a>..." is not one word).
      const texts = [];
      const collect = (node) => (node.type === "text" ? texts.push(node.text) : node.children.forEach(collect));
      collect(snapshot);
      const words = texts
        .flatMap((text) => text.split(/[ \t\n\f\r]+/))
        .filter((word) => /^[\p{L}\p{N}’'.,:;()!?-]+$/u.test(word));
      if (!words.length) continue;
      const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
      const edited = typeInto(snapshot, longest, "Xyz");
      const { model: next } = commitTextEdit(model, block.key, edited);
      const { removed, added } = lineChanges(model.source, next.source);
      assert.equal(removed.length, 1, `${path} ${block.key}: "${longest}" changes one line`);
      assert.equal(added.length, 1);
      // The new line is the old one with exactly one occurrence of the word swapped.
      const raw = escapeText(longest);
      const swapped = [];
      for (let index = removed[0].indexOf(raw); index >= 0; index = removed[0].indexOf(raw, index + 1)) {
        swapped.push(removed[0].slice(0, index) + "Xyz" + removed[0].slice(index + raw.length));
      }
      assert.ok(swapped.includes(added[0]), `${path} ${block.key}: ${removed[0]} → ${added[0]}`);
      checked += 1;
    }
  }
  // 477 unlocked blocks on the editable fixture pages; one holds no plain word.
  assert.ok(checked >= 470, `checked ${checked} blocks`);
});
