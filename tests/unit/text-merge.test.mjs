import assert from "node:assert/strict";
import { test } from "node:test";
import { diffSequences } from "../../src/sequence-diff.js";
import { collapsedText, sanitise, skeletonOf, slotTexts, textNode } from "../../src/snapshot.js";
import { applySplices, indentationBefore, stripTrailingSpaces } from "../../src/splice.js";
import { mergeText } from "../../src/text-merge.js";

const block = { blockStart: true, blockEnd: true };

test("diffSequences finds the shortest edit and orders deletes before inserts", () => {
  const ops = (a, b) =>
    diffSequences(a.split(" "), b.split(" "))
      .map((op) => (op.type === "equal" ? "=" : op.type === "delete" ? `-${a.split(" ")[op.oldIndex]}` : `+${b.split(" ")[op.newIndex]}`))
      .join(" ");
  assert.equal(ops("a b c", "a b c"), "= = =");
  assert.equal(ops("a b c", "a x c"), "= -b +x =");
  assert.equal(ops("a b c d", "a c d e"), "= -b = = +e");
  assert.equal(ops("the cat the dog", "Xyz cat the dog"), "-the +Xyz = = =");
  assert.deepEqual(diffSequences([], ["x"]), [{ type: "insert", newIndex: 0 }]);
  assert.deepEqual(diffSequences(["x"], []), [{ type: "delete", oldIndex: 0 }]);
  // A long random-ish case: applying the ops reproduces the target.
  const before = "one two three four five six seven eight nine ten".split(" ");
  const after = "zero one three four 4.5 five seven nine ten eleven".split(" ");
  const rebuilt = [];
  for (const op of diffSequences(before, after)) {
    if (op.type === "equal") rebuilt.push(before[op.oldIndex]);
    if (op.type === "insert") rebuilt.push(after[op.newIndex]);
  }
  assert.deepEqual(rebuilt, after);
});

test("mergeText keeps untouched words, their spelling and their line wraps", () => {
  const raw = "\n    Physics student, volunteer developer,\n    occasional TEDx speaker &amp; organiser.\n  ";
  assert.equal(mergeText(raw, "Physics student, volunteer developer, occasional TEDx speaker & organiser.", block), raw);
  assert.equal(
    mergeText(raw, "Physics student, volunteer coder, occasional TEDx speaker & organiser.", block),
    "\n    Physics student, volunteer coder,\n    occasional TEDx speaker &amp; organiser.\n  ",
  );
  assert.equal(
    mergeText(raw, "Physics student, volunteer developer, occasional TEDx speaker & host.", block),
    "\n    Physics student, volunteer developer,\n    occasional TEDx speaker &amp; host.\n  ",
  );
});

test("mergeText insertions, deletions and replacements keep line breaks in place", () => {
  const raw = "\n  one two three\n  four five six\n";
  const merge = (text) => mergeText(raw, text, block);
  assert.equal(merge("zero one two three four five six"), "\n  zero one two three\n  four five six\n");
  assert.equal(merge("one two three four five six seven"), "\n  one two three\n  four five six seven\n");
  assert.equal(merge("one two three new four five six"), "\n  one two three\n  new four five six\n");
  assert.equal(merge("one two four five six"), "\n  one two\n  four five six\n");
  assert.equal(merge("one two three five six"), "\n  one two three\n  five six\n");
  assert.equal(merge("two three four five six"), "\n  two three\n  four five six\n");
  assert.equal(merge("one two three four five"), "\n  one two three\n  four five\n");
  // A deletion across a line break joins what is left onto one line (the smaller diff).
  assert.equal(merge("one five six"), "\n  one five six\n");
  assert.equal(merge("one TWO THREE four five six"), "\n  one TWO THREE\n  four five six\n");
});

test("mergeText escapes only & < > in new words and never leaves trailing spaces", () => {
  assert.equal(mergeText("\n  A\n", "A & B < C > D \"E\" 'F'", block), "\n  A &amp; B &lt; C &gt; D \"E\" 'F'\n");
  assert.equal(mergeText("\n  keep this\n  gone\n", "keep this", block), "\n  keep this\n");
  assert.equal(stripTrailingSpaces("a  \nb\t\nc"), "a\nb\nc");
});

test("mergeText: whitespace next to inline elements follows the typed text", () => {
  // After </strong>: ": my first game" has no leading space.
  assert.equal(mergeText(": my first game", ": my first game"), ": my first game");
  assert.equal(mergeText(": my first game", " new: my first game"), " new: my first game");
  assert.equal(mergeText(": my first game", ": my second game"), ": my second game");
  // Between two inline elements.
  assert.equal(mergeText("\n    ", " "), "\n    ", "a line break that renders as a space stays");
  assert.equal(mergeText("\n    ", ""), "", "a deleted space goes");
  assert.equal(mergeText("", " "), " ", "a typed space becomes one space");
  assert.equal(mergeText(" and ", " or "), " or ");
  assert.equal(mergeText(" and ", "or"), "or");
  assert.equal(mergeText("\n    and\n    ", " and more "), "\n    and more\n    ");
});

test("mergeText: whitespace at the block's own edges is formatting and stays", () => {
  assert.equal(mergeText("\n    Hello\n  ", "Hello there", block), "\n    Hello there\n  ");
  assert.equal(mergeText("Hello", " Hello ", block), "Hello");
  assert.equal(mergeText("\n    Hello\n  ", "", block), "\n  ", "an emptied block keeps its closing indentation only");
  assert.equal(mergeText("\n    ", "Hello ", { blockStart: true }), "\n    Hello ", "typed before an inline child at the start");
  assert.equal(mergeText("\n  ", " Hello", { blockEnd: true }), " Hello\n  ", "typed after the last inline child");
});

test("mergeText decodes entities before comparing, so &amp; and & are the same word", () => {
  assert.equal(mergeText("Physics &amp; Ideas", "Physics & Ideas", block), "Physics &amp; Ideas");
  assert.equal(mergeText("Physics &amp; Ideas", "Physics & Thinking", block), "Physics &amp; Thinking");
  assert.equal(mergeText("It’s here", "It’s there", block), "It’s there");
});

test("sanitise maps NBSP, drops Chrome's trailing <br> and unwraps style-only wrappers", () => {
  const element = (key, tag, children, attrs = []) => ({ type: "element", key, tag, attrs, children });
  const raw = element("1", "p", [
    textNode("A b "),
    element(null, "span", [textNode("c")], [["style", "color: red"]]),
    textNode(" d"),
    element("1.0", "a", [textNode("link")]),
    element(null, "font", [element(null, "b", [textNode(" e")])]),
    element(null, "br", []),
  ]);
  const clean = sanitise(raw);
  assert.deepEqual(clean.children, [textNode("A b c d"), element("1.0", "a", [textNode("link")]), textNode(" e")]);
  assert.equal(collapsedText(clean), "A b c dlink e");
  assert.equal(skeletonOf(clean), "1(1.0())");
  assert.deepEqual(slotTexts(clean), ["A b c d", "link", " e"]);

  const styled = sanitise(element("1", "p", [element(null, "span", [textNode("x")], [["class", "note"]])]));
  assert.equal(skeletonOf(styled), "1(?span())", "a wrapper with a real attribute is kept, so the edit is refused");
});

test("applySplices refuses overlaps and applies back to front", () => {
  assert.equal(applySplices("abcdef", [{ start: 1, end: 2, text: "B" }, { start: 4, end: 4, text: "_" }]), "aBcd_ef");
  assert.throws(() => applySplices("abcdef", [{ start: 1, end: 3, text: "" }, { start: 2, end: 4, text: "" }]), RangeError);
  assert.throws(() => applySplices("abc", [{ start: 2, end: 9, text: "" }]), RangeError);
  assert.equal(indentationBefore("x\n    <p>", 6), "    ");
  assert.equal(indentationBefore("x\n  a <p>", 6), null);
});
