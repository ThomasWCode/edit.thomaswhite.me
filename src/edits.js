// Every change the editor makes to a page's source. Each function takes a page
// model and returns a new one built from the changed source; nothing is edited
// in place. Text edits are verified by re-parsing: if the result does not have
// exactly the structure and text the browser showed, the edit is refused and
// the page is left as it was (EditRejectedError).

import {
  ancestorsOf,
  attribute,
  buildPageModel,
  classTokens,
  collapse,
  elementChildren,
  innerRange,
  PageModelError,
  textOf,
  VOID_TAGS,
} from "./page-model.js";
import { collapsedText, keysIn, sanitise, skeletonOf, slotTexts, tagSkeletonOf } from "./snapshot.js";
import { applySplices, escapeAttribute, escapeText, indentationBefore, stripTrailingSpaces } from "./splice.js";
import { mergeText } from "./text-merge.js";

export class EditRejectedError extends Error {
  constructor(message, { typedText = "" } = {}) {
    super(message);
    this.name = "EditRejectedError";
    this.typedText = typedText;
  }
}

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function rebuild(model, source) {
  return buildPageModel(source, { path: model.path, readOnlyReason: model.readOnly });
}

function requireEditable(model, key) {
  if (model.readOnly) throw new EditRejectedError(`This page can't be edited here: ${model.readOnly}`);
  const node = model.nodeOf.get(key);
  if (!node) throw new EditRejectedError("That part of the page no longer exists. Reload the page.");
  return node;
}

function modelSkeleton(model, node) {
  const walk = (element) => `${model.keyOf.get(element)}(${elementChildren(element).map(walk).join("")})`;
  return walk(node);
}

function modelTagSkeleton(node) {
  const walk = (element) => `${element.tagName}(${elementChildren(element).map(walk).join("")})`;
  return walk(node);
}

// The source ranges of a block's text slots, matching snapshot.slotTexts.
function sourceSlots(node) {
  const slots = [];
  const walk = (element, isBlock) => {
    const children = elementChildren(element);
    const { start, end } = innerRange(element);
    let cursor = start;
    children.forEach((child, index) => {
      slots.push({ start: cursor, end: child.sourceCodeLocation.startOffset, blockStart: isBlock && index === 0, blockEnd: false });
      if (!VOID_TAGS.has(child.tagName)) walk(child, false);
      cursor = child.sourceCodeLocation.endOffset;
    });
    slots.push({ start: cursor, end, blockStart: isBlock && children.length === 0, blockEnd: isBlock });
  };
  walk(node, true);
  return slots;
}

function countElements(node) {
  return elementChildren(node).reduce((total, child) => total + 1 + countElements(child), 0);
}

// Re-serialises a block whose element structure changed (a deletion took a link
// or a <strong> with it), reusing each surviving element's original tags.
function reserialise(model, node, snapshot) {
  const seen = new Set();
  const serialise = (children) =>
    children
      .map((child) => {
        if (child.type === "text") return escapeText(child.text);
        const original = child.key === null ? null : model.nodeOf.get(child.key);
        if (!original || original.tagName !== child.tag || seen.has(child.key) || !ancestorsOf(original, model.main).includes(node)) {
          throw new EditRejectedError("The browser added formatting the editor can't save.");
        }
        seen.add(child.key);
        const location = original.sourceCodeLocation;
        const startTag = model.source.slice(location.startTag.startOffset, location.startTag.endOffset);
        if (VOID_TAGS.has(original.tagName)) return startTag;
        const endTag = model.source.slice(location.endTag.startOffset, location.endTag.endOffset);
        return startTag + serialise(child.children) + endTag;
      })
      .join("");
  return stripTrailingSpaces(serialise(snapshot.children));
}

// Applies the text of one edited block. `snapshot` is the block as the browser
// has it now (see snapshot.js). Returns { model, changed, restructured }.
export function commitTextEdit(model, key, snapshot) {
  const node = requireEditable(model, key);
  const block = model.blockByKey.get(key);
  if (!block || block.lock) throw new EditRejectedError(block ? block.lock : "That part of the page is not editable.");
  const clean = sanitise(snapshot);
  const typedText = collapsedText(clean);
  if (clean.key !== key) throw new EditRejectedError("The edited element does not match the page.", { typedText });

  const sameSkeleton = modelSkeleton(model, node) === skeletonOf(clean);
  if (sameSkeleton && collapse(textOf(node)) === typedText) return { model, changed: false, restructured: false };

  const splices = [];
  if (sameSkeleton) {
    const slots = sourceSlots(node);
    const texts = slotTexts(clean);
    if (slots.length !== texts.length) throw new EditRejectedError("The block's text slots do not line up.", { typedText });
    slots.forEach((slot, index) => {
      const raw = model.source.slice(slot.start, slot.end);
      if (raw.includes("<")) throw new EditRejectedError("The block contains markup the editor can't merge.", { typedText });
      const merged = mergeText(raw, texts[index], slot);
      if (merged !== raw) splices.push({ start: slot.start, end: slot.end, text: merged });
    });
  } else {
    let text;
    try {
      text = reserialise(model, node, clean);
    } catch (error) {
      if (error instanceof EditRejectedError) error.typedText = typedText;
      throw error;
    }
    const { start, end } = innerRange(node);
    splices.push({ start, end, text });
  }
  if (!splices.length) return { model, changed: false, restructured: false };

  const source = applySplices(model.source, splices);
  let next;
  try {
    next = rebuild(model, source);
  } catch (error) {
    throw new EditRejectedError(`The change would break the page (${error.message}).`, { typedText });
  }
  verifyTextEdit(model, next, key, clean, typedText);
  return { model: next, changed: true, restructured: !sameSkeleton };
}

function verifyTextEdit(model, next, key, clean, typedText) {
  const fail = (why) => {
    throw new EditRejectedError(`The editor could not save this change exactly (${why}), so the block was reset.`, { typedText });
  };
  const before = model.nodeOf.get(key);
  const after = next.nodeOf.get(key);
  if (next.readOnly) fail(next.readOnly);
  if (!after || after.tagName !== before.tagName) fail("the block moved");
  const startTag = (m, n) => m.source.slice(n.sourceCodeLocation.startTag.startOffset, n.sourceCodeLocation.startTag.endOffset);
  if (startTag(model, before) !== startTag(next, after)) fail("its start tag changed");
  if (modelTagSkeleton(after) !== tagSkeletonOf(clean)) fail("its structure differs from the preview");
  if (collapse(textOf(after)) !== typedText) fail("its text differs from the preview");
  const oldRange = innerRange(before);
  const newRange = innerRange(after);
  if (next.source.slice(0, newRange.start) !== model.source.slice(0, oldRange.start)) fail("bytes before it changed");
  if (next.source.slice(newRange.end) !== model.source.slice(oldRange.end)) fail("bytes after it changed");
  const removed = countElements(before) - (keysIn(clean).length - 1);
  if (countElements(next.main) !== countElements(model.main) - removed) fail("the page's element count changed");
}

// ---- Attributes -------------------------------------------------------------

function attributeLocation(node, name) {
  const attrs = node.sourceCodeLocation.startTag.attrs;
  return attrs && attrs[name] ? attrs[name] : null;
}

// The splice that sets an attribute's value, touching only the value when the
// attribute exists, or adding it after the last attribute (on its own line in
// a tag that already spans several lines).
export function setAttributeSplice(model, node, name, value) {
  const location = attributeLocation(node, name);
  const escaped = escapeAttribute(value);
  if (location) {
    const raw = model.source.slice(location.startOffset, location.endOffset);
    const quoted = /^([^\s=]+\s*=\s*)(["'])([\s\S]*)\2$/.exec(raw);
    if (quoted) {
      const valueStart = location.startOffset + quoted[1].length + 1;
      return { start: valueStart, end: location.endOffset - 1, text: quoted[2] === '"' ? escaped : value.replace(/&/g, "&amp;").replace(/'/g, "&#39;") };
    }
    return { start: location.startOffset, end: location.endOffset, text: `${name}="${escaped}"` };
  }
  const tag = node.sourceCodeLocation.startTag;
  const attrs = Object.values(tag.attrs || {});
  const tagText = model.source.slice(tag.startOffset, tag.endOffset);
  if (attrs.length) {
    const last = attrs.reduce((a, b) => (b.endOffset > a.endOffset ? b : a));
    const indent = tagText.includes("\n") ? indentationBefore(model.source, last.startOffset) : null;
    return { start: last.endOffset, end: last.endOffset, text: indent !== null ? `\n${indent}${name}="${escaped}"` : ` ${name}="${escaped}"` };
  }
  const afterName = tag.startOffset + 1 + node.tagName.length;
  return { start: afterName, end: afterName, text: ` ${name}="${escaped}"` };
}

// Removes an attribute and the whitespace before it.
export function removeAttributeSplice(model, node, name) {
  const location = attributeLocation(node, name);
  if (!location) return null;
  let start = location.startOffset;
  while (start > 0 && /[ \t\n\f\r]/.test(model.source[start - 1])) start -= 1;
  return { start, end: location.endOffset, text: "" };
}

// Removes class tokens, and the whole attribute when none are left.
export function removeClassTokenSplice(model, node, ...tokens) {
  const current = classTokens(node);
  if (!tokens.some((token) => current.includes(token))) return null;
  const remaining = current.filter((item) => !tokens.includes(item));
  if (!remaining.length) return removeAttributeSplice(model, node, "class");
  return setAttributeSplice(model, node, "class", remaining.join(" "));
}

function applyToModel(model, splices) {
  const list = splices.filter(Boolean);
  if (!list.length) return model;
  return rebuild(model, applySplices(model.source, list));
}

export function setAttribute(model, key, name, value) {
  const node = requireEditable(model, key);
  if (attribute(node, name) === value) return model;
  return applyToModel(model, [setAttributeSplice(model, node, name, value)]);
}

export function removeAttribute(model, key, name) {
  const node = requireEditable(model, key);
  return applyToModel(model, [removeAttributeSplice(model, node, name)]);
}

// ---- Drafts -----------------------------------------------------------------

// Done on a written draft: a note loses data-draft and its draft-note class; an
// inline slot's <span> tags are removed, leaving the text. A check is approved
// by removing data-draft="check" only.
export function completeDraft(model, key) {
  const node = requireEditable(model, key);
  const draft = model.drafts.find((item) => item.key === key);
  if (!draft) throw new EditRejectedError("That is not a draft.");
  if (draft.kind === "check") {
    return applyToModel(model, [removeAttributeSplice(model, node, "data-draft")]);
  }
  if (draft.kind === "note") {
    return applyToModel(model, [
      removeAttributeSplice(model, node, "data-draft"),
      removeClassTokenSplice(model, node, "draft-note"),
    ]);
  }
  const location = node.sourceCodeLocation;
  return applyToModel(model, [
    { start: location.startTag.startOffset, end: location.startTag.endOffset, text: "" },
    { start: location.endTag.startOffset, end: location.endTag.endOffset, text: "" },
  ]);
}

// ---- The Now section ----------------------------------------------------------

export function updatedLabel(yyyymm) {
  const [year, month] = yyyymm.split("-");
  return `Updated ${MONTHS[Number(month) - 1]} ${year}`;
}

// Sets data-updated and the visible "Updated Month Year" line together.
export function setNowUpdated(model, yyyymm) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yyyymm)) throw new EditRejectedError("Choose a month as YYYY-MM.");
  if (!model.now || !model.now.lineKey) throw new EditRejectedError("This page has no Now section.");
  const section = model.nodeOf.get(model.now.key);
  const line = model.nodeOf.get(model.now.lineKey);
  const { start, end } = innerRange(line);
  const raw = model.source.slice(start, end);
  return applyToModel(model, [
    setAttributeSplice(model, section, "data-updated", yyyymm),
    { start, end, text: mergeText(raw, updatedLabel(yyyymm), { blockStart: true, blockEnd: true }) },
  ]);
}

export { PageModelError };
