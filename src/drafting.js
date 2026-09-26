// Drafts: changes saved to the site but left out of thomaswhite.me until they
// are published. The site's rule (its AGENTS.md, § Drafts, and
// scripts/drafts.mjs): an element marked data-draft is a draft, which the live
// build leaves out, except that a "remove" draft only loses its marker there.
// The preview site shows drafts as written. The kinds the editor writes:
//
//   "new"      content that isn't live: added as a draft, a phrase, or live
//              content taken off the site until it is published again
//   "replace"  a new version of the live element straight before it; the
//              live one stays until the draft is published
//   "remove"   live content that goes when the draft is published
//
// Placeholders (draft-note, draft-inline) and data-draft="check" come from
// the content-strategy work and are finished with Done and Approve (edits.js).
// Every function here returns a new model, re-parsed, or throws
// EditRejectedError.

import { decodeHTML } from "../vendor/parse5.js";
import { EditRejectedError, removeAttributeSplice, setAttributeSplice } from "./edits.js";
import {
  attribute,
  buildPageModel,
  collapse,
  EDITOR_DRAFT_KINDS,
  elementChildren,
  hasAttribute,
  isElement,
  LOCK_REASONS,
  nextElementSibling,
  previousElementSibling,
  textOf,
} from "./page-model.js";
import { applySplices } from "./splice.js";

// The whole elements a draft copies or marks: the smallest of these around a
// change. A link for its address or words; a heading, paragraph or list item
// for text; a figure or picture for an image; a section for the Now month.
const UNIT_TAGS = new Set(["a", "p", "li", "h2", "h3", "h4", "h5", "h6", "blockquote", "figure", "picture", "ul", "ol", "dl", "table", "details", "section", "article"]);

const rebuild = (model, source) => buildPageModel(source, { path: model.path, readOnlyReason: model.readOnly });

function apply(model, splices) {
  const list = splices.filter(Boolean);
  return list.length ? rebuild(model, applySplices(model.source, list)) : model;
}

function requireNode(model, key) {
  if (model.readOnly) throw new EditRejectedError(`This page can't be edited here: ${model.readOnly}`);
  const node = model.nodeOf.get(key);
  if (!node) throw new EditRejectedError("That part of the page no longer exists. Reload the page.");
  return node;
}

// The draft an element is in (itself or an ancestor within main): { node, kind }.
export function draftAround(model, node) {
  for (let item = node; item && item !== model.main && isElement(item); item = item.parentNode) {
    if (hasAttribute(item, "data-draft")) return { node: item, kind: attribute(item, "data-draft") };
  }
  return null;
}

// The smallest whole element strictly around the source range [start, end)
// that has an explicit end tag (so it can be copied or cut exactly).
function unitAround(model, start, end) {
  let best = null;
  for (const node of model.nodeOf.values()) {
    const location = node.sourceCodeLocation;
    if (!UNIT_TAGS.has(node.tagName) || !location || !location.endTag) continue;
    if (!(location.startOffset < start && end <= location.endOffset)) continue;
    if (!best || location.endOffset - location.startOffset < best.sourceCodeLocation.endOffset - best.sourceCodeLocation.startOffset) best = node;
  }
  return best;
}

// The smallest editable block strictly around [start, end), with an end tag.
function blockAround(model, start, end) {
  let best = null;
  for (const { node } of model.blocks) {
    const location = node.sourceCodeLocation;
    if (!location || !location.endTag || !(location.startOffset < start && end <= location.endOffset)) continue;
    if (!best || location.endOffset - location.startOffset < best.sourceCodeLocation.endOffset - best.sourceCodeLocation.startOffset) best = node;
  }
  return best;
}

function contains(outer, node) {
  for (let item = node; item; item = item.parentNode) if (item === outer) return true;
  return false;
}

// Whether a copy of `node` would repeat what the site pins (the page's h1, a
// quote, a fixed label): the preview would have it twice. The Updated line is
// the Now helper's, and copies with its section.
function holdsPinned(model, node) {
  return model.blocks.some((block) => block.lock && block.lock !== LOCK_REASONS.nowUpdated && block.lock !== LOCK_REASONS.replaced && contains(node, block.node));
}

// The key of the innermost element whose source holds `offset`.
function unitKeyAt(model, offset) {
  let best = null;
  for (const [key, node] of model.nodeOf) {
    const location = node.sourceCodeLocation;
    if (!location || location.startOffset > offset || offset >= location.endOffset) continue;
    if (!best || location.endOffset - location.startOffset < best.size) best = { key, size: location.endOffset - location.startOffset };
  }
  return best ? best.key : null;
}

// The smallest whole element around a node (itself included).
export function unitOf(model, key) {
  for (let item = model.nodeOf.get(key); item && item !== model.main && isElement(item); item = item.parentNode) {
    if (UNIT_TAGS.has(item.tagName) && item.sourceCodeLocation && item.sourceCodeLocation.endTag) return model.keyOf.get(item);
  }
  return null;
}

const CLOSING = /[.,;:!?)\]}’”»…%]/;
const OPENING = /[([{‘“«]/;

// Leaving an element out, exactly as the site's build does (scripts/drafts.mjs,
// removalRange): its own lines when it has them to itself; otherwise the
// element and the spacing it would leave wrong: the whitespace before it when
// closing punctuation or the end of a line follows (no "a bit ." and no
// trailing spaces), one of the two spaces around it, or the space after an
// opening bracket or quote. `last` is the removal before it ({ splice, floor },
// or null): a splice never reaches back into it, and straight after it the two
// count as one (its splice may grow back).
function removalSplice(source, node, last = null) {
  const { startOffset: start, endOffset: end } = node.sourceCodeLocation;
  const floor = last ? last.splice.end : 0;
  const lineBegin = source.lastIndexOf("\n", start - 1) + 1;
  const newline = source.indexOf("\n", end);
  const lineFinish = newline === -1 ? source.length : newline;
  if (lineBegin >= floor && !source.slice(lineBegin, start).trim() && !source.slice(end, lineFinish).trim()) {
    return { start: lineBegin, end: newline === -1 ? source.length : newline + 1, text: "" };
  }
  const joined = last && start === floor;
  const before = joined ? (last.splice.start > last.floor ? source[last.splice.start - 1] : "") : start > floor ? source[start - 1] : "";
  const next = source[end] ?? "";
  const back = (from, limit, pattern) => {
    let at = from;
    while (at > limit && pattern.test(source[at - 1])) at -= 1;
    return at;
  };
  const closeUp = (pattern) => {
    if (joined) last.splice.start = back(last.splice.start, last.floor, pattern);
    return { start: back(start, floor, pattern), end, text: "" };
  };
  if (CLOSING.test(next)) return closeUp(/\s/);
  if (next === "" || next === "\n" || next === "\r") return closeUp(/[ \t]/);
  if (before === " " && next === " ") return { start, end: end + 1, text: "" };
  if (OPENING.test(before) && (next === " " || next === "\t")) {
    let stop = end;
    while (stop < source.length && (source[stop] === " " || source[stop] === "\t")) stop += 1;
    return { start, end: stop, text: "" };
  }
  return { start, end, text: "" };
}

// The page as thomaswhite.me will serve it (for descriptions): every draft
// left out, and "remove" drafts without their marker.
export function liveSource(model) {
  const splices = [];
  let last = null;
  const visit = (node) => {
    for (const child of elementChildren(node)) {
      if (!hasAttribute(child, "data-draft") || !child.sourceCodeLocation) {
        visit(child);
      } else if (attribute(child, "data-draft") === "remove") {
        splices.push(...(isPhrase(child) ? unwrapSplices(child) : [removeAttributeSplice(model, child, "data-draft")]));
        visit(child);
      } else {
        const splice = removalSplice(model.source, child, last);
        splices.push(splice);
        last = { splice, floor: last ? last.splice.end : 0 };
      }
    }
  };
  if (model.main) visit(model.main);
  return applySplices(model.source, splices.filter(Boolean));
}

// A copy of an element's source for a replace draft: marked, and with every
// id renamed data-draft-id so the preview never has an id twice (publishing
// renames them back).
function draftCopy(source, node, kind) {
  const copy = source.replace(/<[a-zA-Z][^>]*>/g, (tag) => tag.replace(/(\s)id(\s*=)/g, "$1data-draft-id$2"));
  return copy.replace(new RegExp(`^<${node.tagName}`, "i"), `<${node.tagName} data-draft="${kind}"`);
}

// The source range [start, end) of `a` that differs from `b`, and the prefix
// and suffix they share.
function changedRange(a, b) {
  let prefix = 0;
  const shortest = Math.min(a.length, b.length);
  while (prefix < shortest && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shortest - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  return { start: prefix, end: a.length - suffix };
}

// Whether a node is, or is inside, a draft the live site leaves out: any kind
// but "remove", whose content stays live until the removal is published.
function leftOut(model, node) {
  for (let item = node; item && item !== model.main && isElement(item); item = item.parentNode) {
    if (hasAttribute(item, "data-draft") && attribute(item, "data-draft") !== "remove") return true;
  }
  return false;
}

export const WAITING = "A new version of this is waiting as a draft just after it. Change that one, or publish or discard it first.";

// Whether a node, or an element around it, has a new version waiting straight
// after it (so the panels offer no changes to it).
export function hasWaitingVersion(model, node) {
  for (let item = node; item && item !== model.main && isElement(item); item = item.parentNode) {
    const next = nextElementSibling(item);
    if (next && attribute(next, "data-draft") === "replace") return true;
  }
  return false;
}

// A live element with a new version waiting straight after it stays as it is
// until that draft is published or discarded: a change to it would be lost on
// publishing (or, as a draft, make a second version). Throws for a change from
// `before` to `after` that touches one; drafts on or off.
export function refuseWaitingChange(before, after) {
  if (after === before || after.source === before.source) return;
  const { start, end } = changedRange(before.source, after.source);
  for (const draft of before.drafts) {
    if (draft.kind !== "replace") continue;
    const live = previousElementSibling(draft.node);
    const location = live && live.sourceCodeLocation;
    if (location && location.startOffset < end && start < location.endOffset) throw new EditRejectedError(WAITING);
  }
}

// A change made to live content, kept as a draft instead: the smallest whole
// element around the change stays as it is, and the changed version goes in a
// copy straight after it, marked data-draft="replace". When that element holds
// something the site pins, the changed block alone is copied (the portrait
// note shares the home page's first section with its h1). A change inside a
// draft the live site leaves out is kept as made. `before` and `after` are
// models of the same page.
export function asDraft(before, after) {
  if (after === before || after.source === before.source) return after;
  const a = before.source;
  const b = after.source;
  const { start: prefix, end } = changedRange(a, b);
  const around = unitAround(before, prefix, end);
  // A change inside a left-out draft, or inside a phrase draft, is a change to
  // that draft. Content marked "remove" is still live, so it isn't one.
  if (around && leftOut(before, around)) return after;
  const inner = before.nodeOf.get(unitKeyAt(before, prefix));
  if (inner && leftOut(before, inner)) return after;
  const unit = [around, blockAround(before, prefix, end)].find((node) => node && !holdsPinned(before, node));
  if (!unit) {
    throw new EditRejectedError(
      around
        ? "A draft of this change would copy a locked part of the page. Turn drafts off to make it, or ask for it in a Claude session."
        : "This change can't be saved as a draft. Turn drafts off to make it, or ask for it in a Claude session.",
    );
  }
  if (attribute(unit, "data-draft") === "remove") {
    throw new EditRejectedError("This is marked to remove when published, and stays live until then. Choose Keep it to change it, or turn Drafts off.");
  }
  const waiting = nextElementSibling(unit);
  if (waiting && attribute(waiting, "data-draft") === "replace") throw new EditRejectedError(WAITING);
  const location = unit.sourceCodeLocation;
  const changed = b.slice(location.startOffset, location.endOffset + (b.length - a.length));
  // On lines of its own when the live element has its lines to itself, as the
  // site's build cuts drafts; hugging it otherwise, so leaving the draft out
  // (or publishing it) adds no whitespace between elements.
  const lineBegin = a.lastIndexOf("\n", location.startOffset - 1) + 1;
  const newline = a.indexOf("\n", location.endOffset);
  const lead = a.slice(lineBegin, location.startOffset);
  const tail = a.slice(location.endOffset, newline === -1 ? a.length : newline);
  const copy = draftCopy(changed, unit, "replace");
  const text = lead.trim() || tail.trim() ? copy : `\n${lead}${copy}`;
  return apply(before, [{ start: location.endOffset, end: location.endOffset, text }]);
}

// Marks the element at `key` as a draft of `kind` ("new" or "remove"). What
// the site's tests pin (the page's h1, Analisa's words) can't be taken off it.
export function markDraft(model, key, kind) {
  if (!EDITOR_DRAFT_KINDS.has(kind) || kind === "replace") throw new EditRejectedError("Not a draft kind to mark.");
  const node = requireNode(model, key);
  const around = draftAround(model, node);
  if (around) throw new EditRejectedError("This is already part of a draft.");
  if (model.blocks.some((block) => (block.lock === LOCK_REASONS.h1 || block.lock === LOCK_REASONS.analisa) && contains(node, block.node))) {
    throw new EditRejectedError("This holds the page heading or a quoted testimonial, which the site's tests need on the live page.");
  }
  // A draft inside a draft would stay behind when the outer one is published.
  if (model.drafts.some((draft) => EDITOR_DRAFT_KINDS.has(draft.kind) && draft.node !== node && contains(node, draft.node))) {
    throw new EditRejectedError("This holds a draft already. Publish or discard that one first.");
  }
  return apply(model, [setAttributeSplice(model, node, "data-draft", kind)]);
}

// Takes live content off the site until it is published again: the smallest
// whole element around `key`, marked "new".
export function makeDraft(model, key) {
  const unit = unitOf(model, key);
  if (!unit) throw new EditRejectedError("This part can't be made a draft on its own.");
  return markDraft(model, unit, "new");
}

// Renames data-draft-id back to id inside an element (a copy being published).
function restoreIds(model, node) {
  const splices = [];
  const visit = (element) => {
    const location = element.sourceCodeLocation && element.sourceCodeLocation.attrs && element.sourceCodeLocation.attrs["data-draft-id"];
    if (location) splices.push({ start: location.startOffset, end: location.startOffset + "data-draft-id".length, text: "id" });
    elementChildren(element).forEach(visit);
  };
  visit(node);
  return splices;
}

// A phrase's span, with no attribute but its marker, goes away with it: its
// tags are dropped and its words stay, as if typed directly.
function unwrapSplices(node) {
  const { startTag, endTag } = node.sourceCodeLocation;
  return [
    { start: startTag.startOffset, end: startTag.endOffset, text: "" },
    { start: endTag.startOffset, end: endTag.endOffset, text: "" },
  ];
}

const isPhrase = (node) => node.tagName === "span" && node.attrs.length === 1 && node.sourceCodeLocation && node.sourceCodeLocation.endTag;

// Publishing a draft makes it live on the next Publish: a new draft loses its
// marker; a new version takes the live element's place; a removal takes the
// element away.
export function publishDraft(model, key) {
  const node = requireNode(model, key);
  const kind = attribute(node, "data-draft");
  if (kind === "new" && isPhrase(node)) return apply(model, unwrapSplices(node));
  if (kind === "new") return apply(model, [removeAttributeSplice(model, node, "data-draft"), ...restoreIds(model, node)]);
  if (kind === "remove") return apply(model, [removalSplice(model.source, node)]);
  if (kind === "replace") {
    const live = previousElementSibling(node);
    if (!live || live.tagName !== node.tagName || hasAttribute(live, "data-draft")) {
      throw new EditRejectedError("The live version this draft replaces isn't straight before it any more. Discard the draft, or fix it in a Claude session.");
    }
    return apply(model, [removalSplice(model.source, live), removeAttributeSplice(model, node, "data-draft"), ...restoreIds(model, node)]);
  }
  throw new EditRejectedError("Finish this draft with Done or Approve.");
}

// Discarding a draft: a new draft or a new version is deleted (the live page
// is as it was); a removal is called off.
export function discardDraft(model, key) {
  const node = requireNode(model, key);
  const kind = attribute(node, "data-draft");
  if (kind === "new" || kind === "replace") return apply(model, [removalSplice(model.source, node)]);
  if (kind === "remove" && isPhrase(node)) return apply(model, unwrapSplices(node));
  if (kind === "remove") return apply(model, [removeAttributeSplice(model, node, "data-draft")]);
  throw new EditRejectedError("Finish this draft with Done or Approve.");
}

// The raw source offset of the decoded character `index` in a text node's
// raw source `raw` (an entity counts as the UTF-16 units it decodes to).
function rawOffset(raw, index) {
  let decoded = 0;
  let offset = 0;
  while (offset < raw.length && decoded < index) {
    const entity = raw[offset] === "&" ? /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.exec(raw.slice(offset)) : null;
    offset += entity ? entity[0].length : 1;
    // In UTF-16 units, as the page's text counts: &#x1F600; is two.
    decoded += entity ? decodeHTML(entity[0]).length : 1;
  }
  return offset;
}

// A phrase inside a block as a draft: the words between the block's text
// offsets `start` and `end` (as the page's text reads, in one run of text)
// wrapped in a span of `kind`: "new" to keep them off the live site until
// published, "remove" to take them away when published. A phrase that is the
// block's whole text marks the block instead (an empty block would be left).
export function draftPhrase(model, blockKey, start, end, kind) {
  if (kind !== "new" && kind !== "remove") throw new EditRejectedError("Not a draft kind for a phrase.");
  const block = requireNode(model, blockKey);
  if (draftAround(model, block)) throw new EditRejectedError("This is already part of a draft.");
  const texts = [];
  const collect = (node) => {
    for (const child of node.childNodes || []) {
      if (child.nodeName === "#text") texts.push(child);
      else if (isElement(child)) collect(child);
    }
  };
  collect(block);
  const full = texts.map((node) => node.value).join("");
  const selected = full.slice(start, end);
  if (!selected.trim()) throw new EditRejectedError("Select some words first.");
  // Trim the selection to its words.
  const from = start + (selected.length - selected.trimStart().length);
  const to = end - (selected.length - selected.trimEnd().length);
  if (collapse(full.slice(from, to)) === collapse(full)) {
    return kind === "new" ? makeDraft(model, blockKey) : markDraft(model, unitOf(model, blockKey), "remove");
  }
  let offset = 0;
  for (const node of texts) {
    const length = node.value.length;
    if (from >= offset && to <= offset + length) {
      const location = node.sourceCodeLocation;
      const raw = model.source.slice(location.startOffset, location.endOffset);
      const rawFrom = location.startOffset + rawOffset(raw, from - offset);
      const rawTo = location.startOffset + rawOffset(raw, to - offset);
      const next = apply(model, [
        { start: rawFrom, end: rawFrom, text: `<span data-draft="${kind}">` },
        { start: rawTo, end: rawTo, text: "</span>" },
      ]);
      if (collapse(textOf(next.nodeOf.get(blockKey))) !== collapse(textOf(block))) {
        throw new EditRejectedError("Couldn't mark those words without changing the text. Try a shorter phrase.");
      }
      return next;
    }
    offset += length;
  }
  throw new EditRejectedError("Select words within one run of text: not across a link or other formatting.");
}
