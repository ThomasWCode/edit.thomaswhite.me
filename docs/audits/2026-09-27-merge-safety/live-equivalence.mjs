// An assumption checked: the editor's liveSource() leaves out exactly what the
// site's stripDrafts() does. Compared on every fixture page and on drafted
// variants (a word changed as a replace draft, a block made a new draft, a
// paragraph or list item marked remove).
//
// Exits 1 on any difference.
import { asDraft, draftAround, liveSource, makeDraft, markDraft } from "../../../src/drafting.js";
import { commitTextEdit } from "../../../src/edits.js";
import { blockText } from "../../../src/page-model.js";
import { loadModel, PAGE_FILES, renderedSnapshot, typeInto } from "../../../tests/support/fixtures.mjs";
import { siteDrafts } from "./site-repo.mjs";

const { stripDrafts } = await siteDrafts();
let compared = 0;
const differences = [];
const check = (label, model) => {
  compared += 1;
  if (stripDrafts(model.source) !== liveSource(model)) differences.push(label);
};
const attempt = (label, make) => {
  let model;
  try {
    model = make();
  } catch {
    return;
  }
  check(label, model);
};

for (const path of PAGE_FILES) {
  const model = loadModel(path);
  check(`${path} as it is`, model);
  if (model.readOnly) continue;
  for (const block of model.blocks) {
    if (block.lock || draftAround(model, block.node)) continue;
    const word = blockText(model, block.key).split(" ").find((item) => /^[a-z]{5,}$/.test(item));
    if (word) {
      attempt(`${path} ${block.key} replace`, () => asDraft(model, commitTextEdit(model, block.key, typeInto(renderedSnapshot(model, block.key), word, `${word}s`)).model));
    }
    attempt(`${path} ${block.key} new`, () => makeDraft(model, block.key));
    if (block.structuralKey) attempt(`${path} ${block.key} remove`, () => markDraft(model, block.structuralKey, "remove"));
  }
}
console.log(JSON.stringify({ compared, differences: differences.length, first: differences.slice(0, 5) }));
console.log(differences.length ? "UNSAFE: the editor and the site disagree on what thomaswhite.me serves." : "SAFE: the editor and the site agree byte for byte.");
process.exitCode = differences.length ? 1 : 0;
