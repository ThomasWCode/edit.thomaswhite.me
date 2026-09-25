// Adding and removing paragraphs and list items ("+" and "×" on a block).
//
// A new item is a copy of the one it follows: the same tag and attributes
// (dates and record slugs included, which the site's contracts require on
// dated list items) minus draft markers and the id, with its text replaced by
// "New paragraph" or "New item" and its own indentation. A compact-list item
// keeps its label and text spans and drops its arrow link. Removing an item
// takes its whole line(s) when it stands on its own lines.

import {
  attribute,
  buildPageModel,
  classTokens,
  elementChildren,
  innerRange,
  isElement,
} from "./page-model.js";
import { EditRejectedError, removeAttributeSplice, removeClassTokenSplice } from "./edits.js";
import { applySplices, indentationBefore, lineEnd, lineStart } from "./splice.js";

export const NEW_PARAGRAPH = "New paragraph";
export const NEW_ITEM = "New item";
export const NEW_LABEL = "Label";

function structuralNode(model, key) {
  if (model.readOnly) throw new EditRejectedError(`This page can't be edited here: ${model.readOnly}`);
  const node = model.nodeOf.get(key);
  if (!node || !["p", "li"].includes(node.tagName)) throw new EditRejectedError("Only paragraphs and list items can be added or removed.");
  if (model.blocks.some((block) => block.lock && (block.node === node || block.node.parentNode === node))) {
    throw new EditRejectedError("That part of the page is locked.");
  }
  return node;
}

// The start tag without draft markers or an id, from the tag's own source.
// Each splice touches a different attribute, so they never overlap.
function cleanStartTag(model, node) {
  const location = node.sourceCodeLocation.startTag;
  const splices = [
    removeAttributeSplice(model, node, "data-draft"),
    removeAttributeSplice(model, node, "id"),
    removeClassTokenSplice(model, node, "draft-note", "draft-inline"),
  ]
    .filter(Boolean)
    .map((splice) => ({ start: splice.start - location.startOffset, end: splice.end - location.startOffset, text: splice.text }));
  return applySplices(model.source.slice(location.startOffset, location.endOffset), splices);
}

const endTagOf = (model, node) => model.source.slice(node.sourceCodeLocation.endTag.startOffset, node.sourceCodeLocation.endTag.endOffset);

function edgeWhitespace(model, node) {
  const { start, end } = innerRange(node);
  const inner = model.source.slice(start, end);
  const lead = /^[ \t\n\f\r]*/.exec(inner)[0];
  const trail = lead.length === inner.length ? "" : /[ \t\n\f\r]*$/.exec(inner)[0];
  return { lead, trail };
}

function isCompactItem(node) {
  return node.tagName === "li" && elementChildren(node).some((child) => classTokens(child).includes("compact-list-text"));
}

function compactItemInner(model, node) {
  const { lead, trail } = edgeWhitespace(model, node);
  const children = elementChildren(node);
  const label = children.find((child) => classTokens(child).includes("compact-list-label"));
  const text = children.find((child) => classTokens(child).includes("compact-list-text"));
  const tagged = (child, content) => {
    const location = child.sourceCodeLocation;
    return model.source.slice(location.startTag.startOffset, location.startTag.endOffset) + content + endTagOf(model, child);
  };
  // The whitespace between the label and the text span, as written.
  const between = label
    ? model.source.slice(label.sourceCodeLocation.endOffset, text.sourceCodeLocation.startOffset)
    : "";
  return lead + (label ? tagged(label, NEW_LABEL) + between : "") + tagged(text, NEW_ITEM) + trail;
}

// Inserts a new paragraph or list item after `key`. Returns { model, key }
// where key is the new element's.
export function addAfter(model, key) {
  const node = structuralNode(model, key);
  const placeholder = node.tagName === "li" ? NEW_ITEM : NEW_PARAGRAPH;
  let inner;
  if (isCompactItem(node)) {
    inner = compactItemInner(model, node);
  } else {
    const { lead, trail } = edgeWhitespace(model, node);
    inner = lead + placeholder + trail;
  }
  const copy = cleanStartTag(model, node) + inner + endTagOf(model, node);
  const { startOffset, endOffset } = node.sourceCodeLocation;
  const indent = indentationBefore(model.source, startOffset);
  const text = indent !== null ? `\n${indent}${copy}` : copy;
  const source = applySplices(model.source, [{ start: endOffset, end: endOffset, text }]);
  const next = buildPageModel(source, { path: model.path, readOnlyReason: model.readOnly });

  const parts = key.split(".");
  parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
  const newKey = parts.join(".");
  const added = next.nodeOf.get(newKey);
  if (!added || added.tagName !== node.tagName) throw new EditRejectedError("The new item could not be placed.");
  return { model: next, key: newKey };
}

// What removing `key` means, for the confirmation: the last item of a list
// leaves the list empty.
export function removalInfo(model, key) {
  const node = structuralNode(model, key);
  const siblings = elementChildren(node.parentNode).filter((child) => child.tagName === node.tagName);
  return { tag: node.tagName, lastItem: node.tagName === "li" && siblings.length === 1 };
}

// Removes a paragraph or list item, with its line(s) when it has them to itself.
export function removeBlock(model, key) {
  const node = structuralNode(model, key);
  let { startOffset: start, endOffset: end } = node.sourceCodeLocation;
  const indent = indentationBefore(model.source, start);
  const restOfLine = model.source.slice(end, lineEnd(model.source, end));
  if (indent !== null && /^[ \t]*$/.test(restOfLine)) {
    start = lineStart(model.source, start);
    end = Math.min(model.source.length, lineEnd(model.source, end) + 1);
  }
  const source = applySplices(model.source, [{ start, end, text: "" }]);
  return buildPageModel(source, { path: model.path, readOnlyReason: model.readOnly });
}

// Every element with a data-record value, for checking against the record.
export function recordReferences(model) {
  const references = [];
  const visit = (node) => {
    for (const child of node.childNodes || []) {
      if (!isElement(child)) continue;
      const slug = attribute(child, "data-record");
      if (slug !== null) references.push({ slug, node: child, key: model.keyOf.get(child) ?? null });
      visit(child);
    }
  };
  visit(model.document);
  return references;
}
