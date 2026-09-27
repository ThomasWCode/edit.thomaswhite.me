// Finding 2 of the data-safety audit (docs/audits/2026-09-27-merge-safety.md).
// A new version ("replace" draft) of a live element waits on `edits`.
// Meanwhile main changes a different word of that live element (a Claude
// session, say). The editor brings main into edits (on load, or Update from
// main), git merges the two cleanly, and Tom presses "Publish new version".
// It must be refused, so main's change is never lost, until Tom has carried
// it into the new version and recorded the live element as it is now. When
// main deletes the live element instead, publishing must never cut another.
import assert from "node:assert/strict";
import { test } from "node:test";
import { asDraft, liveChanged, publishDraft, recordLive } from "../../src/drafting.js";
import { commitTextEdit } from "../../src/edits.js";
import { blockText, previousElementSibling } from "../../src/page-model.js";
import { loadModel, renderedSnapshot, typeInto } from "../support/fixtures.mjs";
import { gitMerge } from "../support/git-merge.mjs";

const PAGES = ["index.html", "programming.html", "physics.html", "tedx.html", "volunteering.html", "gallery.html", "blog/index.html", "contact.html"];

const edit = (model, key, from, to) => commitTextEdit(model, key, typeInto(renderedSnapshot(model, key), from, to)).model;

// Types `to` over the first whole word `from` (typeInto matches any text, and
// "things" is inside "everythings").
function typeWord(snapshot, from, to) {
  const word = new RegExp(`(?<![A-Za-z])${from}(?![A-Za-z])`);
  let done = false;
  const visit = (node) => {
    if (done) return node;
    if (node.type === "text") {
      if (!word.test(node.text)) return node;
      done = true;
      return { ...node, text: node.text.replace(word, to) };
    }
    return { ...node, children: node.children.map(visit) };
  };
  const result = visit(snapshot);
  assert.ok(done, `"${from}" is not a word of the block`);
  return result;
}

test("publishing a new version never undoes a change merged from main into its live element", () => {
  const tally = { cases: 0, changeConflicted: 0, changeMergedCleanly: 0, refused: 0, mainChangeLost: 0, bothKeptAfterRecording: 0, deleteConflicted: 0, deleteMergedCleanly: 0, deleteCutAnotherElement: 0 };
  const lost = [];
  for (const path of PAGES) {
    const model = loadModel(path);
    for (const block of model.blocks) {
      if (block.lock) continue;
      const words = blockText(model, block.key).split(" ").filter((word) => /^[a-z]{5,}$/.test(word));
      const once = [...new Set(words)].filter((word) => words.indexOf(word) === words.lastIndexOf(word));
      if (once.length < 2) continue;
      const [draftWord, mainWord] = once;
      let direct;
      let drafted;
      let onMain;
      try {
        direct = edit(model, block.key, draftWord, `${draftWord}s`);
        drafted = asDraft(model, direct);
        onMain = edit(model, block.key, mainWord, mainWord.toUpperCase());
      } catch {
        continue;
      }
      const copy = drafted.drafts.find((draft) => draft.kind === "replace");
      if (!copy || drafted === direct) continue;
      tally.cases += 1;
      const where = `${path} ${block.key}: main changed ${mainWord}, the draft ${draftWord}`;

      const merged = gitMerge(model.source, drafted.source, onMain.source);
      if (!merged.clean) {
        tally.changeConflicted += 1;
      } else {
        tally.changeMergedCleanly += 1;
        const after = loadModel(path, merged.text);
        const waiting = after.keyOf.get(after.drafts.find((draft) => draft.kind === "replace").node);
        assert.equal(liveChanged(after, waiting), true, `${where}: the live element reads as changed`);
        let published = null;
        try {
          published = publishDraft(after, waiting);
        } catch {
          tally.refused += 1;
        }
        if (published && !published.source.includes(mainWord.toUpperCase())) {
          tally.mainChangeLost += 1;
          lost.push(where);
        }
        // Carried over by hand and recorded, both changes go live. The word is
        // typed in the block holding the new version's copy of it (inside the
        // new version, or around it when that is a link): the live element's
        // own copy has main's change already.
        const draftNode = after.nodeOf.get(waiting);
        const within = (node, outer) => Boolean(node) && (node === outer || within(node.parentNode, outer));
        const target = after.blocks.find((item) => (within(item.node, draftNode) || within(draftNode, item.node)) && blockText(after, item.key).split(" ").includes(mainWord));
        const carried = commitTextEdit(after, target.key, typeWord(renderedSnapshot(after, target.key), mainWord, mainWord.toUpperCase())).model;
        const done = publishDraft(recordLive(carried, waiting), waiting).source;
        if (done.includes(mainWord.toUpperCase()) && done.includes(`${draftWord}s`)) tally.bothKeptAfterRecording += 1;
      }

      // Main deletes the live element (when it has its lines to itself).
      const live = previousElementSibling(copy.node);
      const { startOffset, endOffset } = live.sourceCodeLocation;
      const source = model.source;
      const lineBegin = source.lastIndexOf("\n", startOffset - 1) + 1;
      const newline = source.indexOf("\n", endOffset);
      if (source.slice(lineBegin, startOffset).trim() || source.slice(endOffset, newline).trim()) continue;
      const deleted = gitMerge(model.source, drafted.source, source.slice(0, lineBegin) + source.slice(newline + 1));
      if (!deleted.clean) {
        tally.deleteConflicted += 1;
        continue;
      }
      tally.deleteMergedCleanly += 1;
      const after = loadModel(path, deleted.text);
      const waiting = after.drafts.find((draft) => draft.kind === "replace");
      try {
        publishDraft(after, after.keyOf.get(waiting.node));
        tally.deleteCutAnotherElement += 1;
      } catch {
        // Refused: nothing lost.
      }
    }
  }
  assert.deepEqual(lost, [], "publishing lost main's change");
  // The audit's counts on these fixtures: 128 cases, 94 clean merges, 127 deletions that conflict.
  assert.equal(tally.cases, 128);
  assert.equal(tally.changeMergedCleanly, 94);
  assert.equal(tally.refused, tally.changeMergedCleanly, "every clean merge is refused");
  assert.equal(tally.bothKeptAfterRecording, tally.changeMergedCleanly, "and published with both changes once carried over and recorded");
  assert.equal(tally.deleteCutAnotherElement, 0);
  assert.equal(tally.deleteConflicted + tally.deleteMergedCleanly, 127);
});
