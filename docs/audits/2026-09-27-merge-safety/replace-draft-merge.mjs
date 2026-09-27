// Finding 2. A "replace" draft (a new version of a live element) waits on
// `edits`. Meanwhile main changes a different word of that live element (a
// Claude session, say). The editor brings main into edits (on load, or Update
// from main), git merges the two cleanly, and Tom presses "Publish new
// version". Is main's change still there afterwards?
//
// Also: main deletes the live element instead. Does publishing then cut
// something else?
//
// Exits 1 while main's change can be lost.
import { asDraft, publishDraft } from "../../../src/drafting.js";
import { commitTextEdit } from "../../../src/edits.js";
import { blockText, collapse, previousElementSibling, textOf } from "../../../src/page-model.js";
import { loadModel, renderedSnapshot, typeInto } from "../../../tests/support/fixtures.mjs";
import { gitMerge } from "./git-merge.mjs";

const PAGES = ["index.html", "programming.html", "physics.html", "tedx.html", "volunteering.html", "gallery.html", "blog/index.html", "contact.html"];
const tally = { cases: 0, changeConflicted: 0, changeMergedCleanly: 0, mainChangeLostOnPublish: 0, deleteConflicted: 0, deleteMergedCleanly: 0, deleteCutAnotherElement: 0 };
const examples = [];

const edit = (model, key, from, to) => commitTextEdit(model, key, typeInto(renderedSnapshot(model, key), from, to)).model;

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

    const merged = gitMerge(model.source, drafted.source, onMain.source);
    if (!merged.clean) {
      tally.changeConflicted += 1;
    } else {
      tally.changeMergedCleanly += 1;
      const after = loadModel(path, merged.text);
      const waiting = after.drafts.find((draft) => draft.kind === "replace");
      try {
        const published = publishDraft(after, after.keyOf.get(waiting.node));
        if (!published.source.includes(mainWord.toUpperCase())) {
          tally.mainChangeLostOnPublish += 1;
          if (examples.length < 3) examples.push({ path, block: block.key, mainChanged: `${mainWord} → ${mainWord.toUpperCase()}`, draftChanged: `${draftWord} → ${draftWord}s` });
        }
      } catch {
        // Refused: nothing lost.
      }
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
      examples.push({ path, cutInstead: collapse(textOf(previousElementSibling(waiting.node))).slice(0, 80) });
    } catch {
      // Refused: nothing lost.
    }
  }
}

console.log(JSON.stringify({ ...tally, examples }, null, 1));
const unsafe = tally.mainChangeLostOnPublish + tally.deleteCutAnotherElement;
console.log(unsafe ? `UNSAFE: publishing the draft lost main's change in ${unsafe} of ${tally.cases} cases.` : "SAFE: no case lost main's change.");
process.exitCode = unsafe ? 1 : 0;
