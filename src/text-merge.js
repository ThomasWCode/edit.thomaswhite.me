// Merges the text a person typed back into the raw source text it came from,
// changing as few bytes (and lines) as possible.
//
// The old raw text keeps its entity spelling (&amp;), its line wraps and its
// indentation. Both texts are split into words; a word diff decides what
// changed. Unchanged words are re-emitted exactly as they were written, with the
// whitespace that preceded them. Inserted words are escaped (& < > only) and
// joined with single spaces. Around a changed run, the whitespace that carried
// a line break is kept where the run starts and ends, so an edit to one word
// changes one line.
//
// Edges: whitespace just inside the block's own tags is formatting (a newline
// and indentation) and is kept as it was. Whitespace next to an inline element
// (a link, <strong>, a draft span) is visible, so it follows the typed text:
// kept if still there, dropped if deleted, a single space if added.

import { decodeHTML } from "../vendor/parse5.js";
import { diffSequences } from "./sequence-diff.js";
import { escapeText, stripTrailingSpaces } from "./splice.js";

const LEADING = /^[ \t\n\f\r]*/;
const TRAILING = /[ \t\n\f\r]*$/;
const TOKEN = /([ \t\n\f\r]*)([^ \t\n\f\r]+)/g;

function split(text, { blankIsTrailing = false } = {}) {
  const lead = LEADING.exec(text)[0];
  if (lead.length === text.length) {
    return blankIsTrailing
      ? { lead: "", body: "", trail: text, tokens: [] }
      : { lead: text, body: "", trail: "", tokens: [] };
  }
  const trail = TRAILING.exec(text)[0];
  const body = text.slice(lead.length, text.length - trail.length);
  const tokens = [];
  for (const match of body.matchAll(TOKEN)) tokens.push({ ws: match[1], word: match[2] });
  return { lead, body, trail, tokens };
}

const sameWords = (a, b) => a.length === b.length && a.every((word, index) => word === b[index]);

function emitBody(tokens, oldWords, newWords) {
  const operations = diffSequences(oldWords, newWords);
  let out = "";
  let pendingWs = null;
  let index = 0;
  while (index < operations.length) {
    const operation = operations[index];
    if (operation.type === "equal") {
      const token = tokens[operation.oldIndex];
      out += (pendingWs ?? token.ws) + token.word;
      pendingWs = null;
      index += 1;
      continue;
    }
    const deleted = [];
    const inserted = [];
    while (index < operations.length && operations[index].type !== "equal") {
      (operations[index].type === "delete" ? deleted : inserted).push(operations[index]);
      index += 1;
    }
    const next = index < operations.length ? tokens[operations[index].oldIndex] : null;
    // The original separators this run replaces: before each deleted word, and
    // before the next unchanged word. Only the body's first word has "".
    const separators = deleted.map((operation) => tokens[operation.oldIndex].ws);
    if (next) separators.push(next.ws);
    const words = inserted.map((operation) => escapeText(newWords[operation.newIndex]));

    if (words.length === 0) {
      if (next) {
        const first = separators[0];
        const last = separators[separators.length - 1];
        if (first === "") pendingWs = "";
        else if (first.includes("\n")) pendingWs = first;
        else pendingWs = last;
      }
      continue;
    }
    out += (separators.length ? separators[0] : out === "" ? "" : " ") + words.join(" ");
    if (next) pendingWs = separators.length >= 2 ? separators[separators.length - 1] : " ";
  }
  return out;
}

// oldRaw: the source text of one slot (between two tags). newText: the text the
// browser now has there, decoded, with non-breaking spaces already mapped to
// spaces. blockStart / blockEnd: the slot touches the block's own start / end tag.
export function mergeText(oldRaw, newText, { blockStart = false, blockEnd = false } = {}) {
  const blankIsTrailing = blockEnd && !blockStart;
  const before = split(oldRaw, { blankIsTrailing });
  const after = split(newText, { blankIsTrailing });
  const oldWords = before.tokens.map((token) => decodeHTML(token.word));
  const newWords = after.tokens.map((token) => token.word);

  const wordsSame = sameWords(oldWords, newWords);
  const leadSame = blockStart || (before.lead !== "") === (after.lead !== "");
  const trailSame = blockEnd || (before.trail !== "") === (after.trail !== "");
  if (wordsSame && leadSame && trailSame) return oldRaw;

  const lead = blockStart ? before.lead : after.lead !== "" ? before.lead || " " : "";
  const trail = blockEnd ? before.trail : after.trail !== "" ? before.trail || " " : "";
  const body = wordsSame ? before.body : emitBody(before.tokens, oldWords, newWords);

  if (body === "") {
    // Nothing visible left in this slot: keep one run of whitespace at most.
    if (blockStart && blockEnd) return stripTrailingSpaces(before.trail);
    if (blockStart) return stripTrailingSpaces(lead);
    if (blockEnd) return stripTrailingSpaces(trail);
    if (lead && trail) return lead.includes("\n") ? lead : trail;
    return lead || trail;
  }
  return stripTrailingSpaces(lead + body + trail);
}
