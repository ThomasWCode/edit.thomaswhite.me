// Reads one page's source into a model of what may be edited and exactly where
// each piece of it lives in the file.
//
// The front matter is blanked (every character but newlines becomes a space)
// rather than stripped, so parse5's source offsets are file offsets. Elements
// under main#main-content are keyed by their element-child index path from
// main ("3.0.1"); the render copy writes those keys into the preview so a DOM
// element always leads back to its source. main holds no scripts or comments
// (tests/unit/page-model.test.mjs checks the fixtures), so the browser's tree
// and parse5's agree.
//
// A "block" is the unit of editing: a leaf element whose text is typed in one
// piece (a paragraph, a list item, a heading, or an inline span inside a
// compact list). The rules are in docs/how-it-works.md, "From a click to a
// one-line diff".

import { decodeHTML, parse } from "../vendor/parse5.js";

export const INLINE_TAGS = new Set([
  "a", "abbr", "b", "bdi", "cite", "code", "data", "del", "dfn", "em", "i", "ins", "kbd", "mark", "q", "s",
  "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var",
]);
export const REPLACED_TAGS = new Set(["br", "wbr", "img", "picture", "source", "svg"]);
export const SKIPPED_TAGS = new Set([
  "script", "style", "template", "form", "button", "input", "select", "textarea", "label", "video", "audio",
  "dialog", "iframe",
]);
export const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);
const STRUCTURAL_TAGS = new Set(["p", "li"]);
const FRONT_MATTER = /^---\npermalink: ([^\n]+)\n---\n/;
export const ANALISA_PHRASE = "I was honestly so impressed";
const HTML_WHITESPACE = /[ \t\n\f\r]+/g;

export const LOCK_REASONS = {
  outside: "The header and footer are shared by every page. Change them in a Claude session.",
  h1: "The page heading is pinned by the site's tests and the status-page monitor. Change it in a Claude session.",
  analisa: "Analisa's testimonial is quoted word for word, and a site test checks it.",
  nowUpdated: "This line is set by the Now helper: choose the month there.",
  proofLabel: "Proof-block subheadings are fixed labels.",
  form: "The contact form is wired to Formspree and the site's script.",
  button: "Buttons are wired to the site's script.",
  media: "Video and audio players can't be edited here.",
  other: "This part is wired to the site's script.",
};

export class PageModelError extends Error {
  constructor(message) {
    super(message);
    this.name = "PageModelError";
  }
}

export const isElement = (node) => typeof node.tagName === "string";
export const elementChildren = (node) => (node.childNodes || []).filter(isElement);
export const attribute = (node, name) => {
  const found = node.attrs && node.attrs.find((item) => item.name === name);
  return found ? found.value : null;
};
export const hasAttribute = (node, name) => Boolean(node.attrs && node.attrs.some((item) => item.name === name));
export const classTokens = (node) => (attribute(node, "class") || "").split(/[ \t\n\f\r]+/).filter(Boolean);
export const collapse = (text) => text.replace(HTML_WHITESPACE, " ").trim();

export function isHidden(node) {
  return hasAttribute(node, "hidden") || attribute(node, "aria-hidden") === "true";
}

// Decoded text of a node and everything inside it.
export function textOf(node) {
  if (node.nodeName === "#text") return node.value;
  return (node.childNodes || []).map(textOf).join("");
}

export function innerRange(node) {
  const location = node.sourceCodeLocation;
  return { start: location.startTag.endOffset, end: location.endTag ? location.endTag.startOffset : location.startTag.endOffset };
}

export function ancestorsOf(node, stop) {
  const result = [];
  for (let current = node.parentNode; current && current !== stop; current = current.parentNode) result.push(current);
  return result;
}

function findMain(root) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.tagName === "main" && attribute(node, "id") === "main-content") return node;
    const children = node.childNodes || [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return null;
}

function hasText(node) {
  for (const child of node.childNodes || []) {
    if (child.nodeName === "#text" && child.value.trim()) return true;
    if (isElement(child) && !isHidden(child) && hasText(child)) return true;
  }
  return false;
}

function hasDirectText(node) {
  return (node.childNodes || []).some((child) => child.nodeName === "#text" && child.value.trim());
}

function hasBlockDescendant(node) {
  for (const child of elementChildren(node)) {
    if (isHidden(child)) continue;
    if (!INLINE_TAGS.has(child.tagName) && !REPLACED_TAGS.has(child.tagName)) return true;
    if (hasBlockDescendant(child)) return true;
  }
  return false;
}

function skippedReason(node) {
  if (node.tagName === "form") return LOCK_REASONS.form;
  if (node.tagName === "button") return LOCK_REASONS.button;
  if (node.tagName === "video" || node.tagName === "audio") return LOCK_REASONS.media;
  return LOCK_REASONS.other;
}

function draftKind(node) {
  if (!hasAttribute(node, "data-draft")) return null;
  if (attribute(node, "data-draft") === "check") return "check";
  const classes = classTokens(node);
  if (classes.includes("draft-inline")) return "inline";
  if (classes.includes("draft-note")) return "note";
  return INLINE_TAGS.has(node.tagName) ? "inline" : "note";
}

// Builds the model. `readOnlyReason` marks a whole page as not editable (the
// CV and the redirect pages); the page still renders.
export function buildPageModel(source, { path = "", readOnlyReason = null } = {}) {
  if (source.includes("\r")) {
    throw new PageModelError(`${path || "This file"} has Windows line endings (CRLF); the site's files use LF.`);
  }
  const frontMatter = FRONT_MATTER.exec(source);
  const html = frontMatter ? frontMatter[0].replace(/[^\n]/g, " ") + source.slice(frontMatter[0].length) : source;
  const document = parse(html, { sourceCodeLocationInfo: true });

  const model = {
    path,
    source,
    html,
    permalink: frontMatter ? frontMatter[1].trim() : null,
    document,
    main: null,
    readOnly: readOnlyReason,
    keyOf: new Map(),
    nodeOf: new Map(),
    roles: new Map(),
    lockReasons: new Map(),
    blocks: [],
    blockByKey: new Map(),
    drafts: [],
    links: [],
    images: [],
    ids: new Set(),
    now: null,
    unreachable: [],
  };
  if (!frontMatter) model.readOnly ??= "This page has no front matter (the three lines at the top starting with ---).";

  collectIds(document, model.ids);
  const main = findMain(document);
  if (!main) {
    model.readOnly ??= "This page has no <main id=\"main-content\">.";
    return model;
  }
  model.main = main;

  const assign = (parent, prefix) => {
    elementChildren(parent).forEach((child, index) => {
      const key = prefix === null ? String(index) : `${prefix}.${index}`;
      model.keyOf.set(child, key);
      model.nodeOf.set(key, child);
      if (!VOID_TAGS.has(child.tagName) && !child.sourceCodeLocation.endTag) {
        model.readOnly ??= `The <${child.tagName}> on line ${child.sourceCodeLocation.startLine} has no end tag, so its text can't be located safely.`;
      }
      assign(child, key);
    });
  };
  assign(main, null);

  classifyBlocks(model);
  collectMarkers(model);
  findUnreachableText(model);
  return model;
}

function addRole(model, node, role) {
  const key = model.keyOf.get(node);
  if (!model.roles.has(key)) model.roles.set(key, new Set());
  model.roles.get(key).add(role);
}

function lockReasonFor(model, node) {
  const chain = [node, ...ancestorsOf(node, model.main)];
  if (chain.some((item) => item.tagName === "h1")) return LOCK_REASONS.h1;
  if (collapse(textOf(node)).includes(ANALISA_PHRASE)) return LOCK_REASONS.analisa;
  if (chain.some((item) => classTokens(item).includes("now-updated"))) return LOCK_REASONS.nowUpdated;
  if (chain.some((item) => item.tagName === "h4") && chain.some((item) => classTokens(item).includes("proof-block"))) {
    return LOCK_REASONS.proofLabel;
  }
  return null;
}

// The list item or plain paragraph that "+" and "×" act on. Paragraphs with a
// styling class (eyebrows, the hero lede) are single-purpose, so a copy of one
// would be wrong; draft classes are dropped from copies anyway.
function structuralKeyFor(model, node) {
  for (const item of [node, ...ancestorsOf(node, model.main)]) {
    if (!STRUCTURAL_TAGS.has(item.tagName)) continue;
    const styling = classTokens(item).filter((token) => token !== "draft-note" && token !== "draft-inline");
    return item.tagName === "li" || styling.length === 0 ? model.keyOf.get(item) : null;
  }
  return null;
}

function classifyBlocks(model) {
  const consider = (node) => {
    if (isHidden(node)) return;
    if (SKIPPED_TAGS.has(node.tagName)) {
      const key = model.keyOf.get(node);
      addRole(model, node, "locked");
      model.lockReasons.set(key, skippedReason(node));
      return;
    }
    if (!hasText(node)) return;
    if (hasBlockDescendant(node)) {
      elementChildren(node).forEach(consider);
      return;
    }
    const onlyInlineChildren = elementChildren(node).every(
      (child) => INLINE_TAGS.has(child.tagName) || REPLACED_TAGS.has(child.tagName),
    );
    if (!INLINE_TAGS.has(node.tagName) && !hasDirectText(node) && onlyInlineChildren) {
      elementChildren(node).forEach(consider);
      return;
    }
    const key = model.keyOf.get(node);
    const lock = lockReasonFor(model, node);
    const chain = [node, ...ancestorsOf(node, model.main)];
    const block = {
      key,
      node,
      tag: node.tagName,
      lock,
      draft: draftKind(node),
      structuralKey: lock ? null : structuralKeyFor(model, node),
      shared: chain.some((item) => attribute(item, "id") === "tech-projects"),
      inNow: chain.some((item) => hasAttribute(item, "data-updated")),
    };
    model.blocks.push(block);
    model.blockByKey.set(key, block);
    addRole(model, node, lock ? "locked" : "block");
    if (lock) model.lockReasons.set(key, lock);
  };
  elementChildren(model.main).forEach(consider);
}

function blockKeyContaining(model, node) {
  for (const item of [node, ...ancestorsOf(node, model.main)]) {
    const key = model.keyOf.get(item);
    if (key !== undefined && model.blockByKey.has(key)) return key;
  }
  return null;
}

function collectMarkers(model) {
  const visit = (node) => {
    for (const child of elementChildren(node)) {
      if (isHidden(child)) continue;
      const key = model.keyOf.get(child);
      const kind = draftKind(child);
      if (kind) {
        model.drafts.push({ key, node: child, kind, blockKey: blockKeyContaining(model, child) });
        addRole(model, child, `draft-${kind}`);
      }
      if (child.tagName === "a" && hasAttribute(child, "href")) {
        model.links.push({ key, node: child, href: attribute(child, "href"), blockKey: blockKeyContaining(model, child) });
        addRole(model, child, "link");
      }
      if (child.tagName === "img") {
        const button = ancestorsOf(child, model.main).find(
          (item) => item.tagName === "button" && classTokens(item).includes("gallery-open"),
        );
        const figure = button && button.parentNode;
        const caption = figure && elementChildren(figure).find((item) => item.tagName === "figcaption");
        model.images.push({
          key,
          node: child,
          gallery: button
            ? { buttonKey: model.keyOf.get(button), captionKey: caption ? model.keyOf.get(caption) : null }
            : null,
        });
        addRole(model, child, button ? "gallery" : "image");
      }
      if (hasAttribute(child, "data-updated") && !model.now) {
        const line = findDescendant(child, (item) => classTokens(item).includes("now-updated"));
        model.now = { key, updated: attribute(child, "data-updated"), lineKey: line ? model.keyOf.get(line) : null };
      }
      visit(child);
    }
  };
  visit(model.main);
}

function findDescendant(node, predicate) {
  for (const child of elementChildren(node)) {
    if (predicate(child)) return child;
    const found = findDescendant(child, predicate);
    if (found) return found;
  }
  return null;
}

function collectIds(node, ids) {
  for (const child of node.childNodes || []) {
    if (!isElement(child)) continue;
    const id = attribute(child, "id");
    if (id) ids.add(id);
    collectIds(child, ids);
    if (child.content) collectIds(child.content, ids);
  }
}

// Text a visitor can see but no block can reach. Always empty for the site's
// pages (tested); reported so a future markup pattern fails loudly.
function findUnreachableText(model) {
  const visit = (node, covered) => {
    for (const child of node.childNodes || []) {
      if (child.nodeName === "#text") {
        if (!covered && child.value.trim()) {
          model.unreachable.push({ offset: child.sourceCodeLocation.startOffset, text: collapse(child.value) });
        }
      } else if (isElement(child)) {
        const key = model.keyOf.get(child);
        const skip = isHidden(child) || SKIPPED_TAGS.has(child.tagName);
        visit(child, covered || skip || model.blockByKey.has(key));
      }
    }
  };
  visit(model.main, false);
}

export function blockText(model, key) {
  return collapse(textOf(model.nodeOf.get(key)));
}

// The page's <title>, for labels.
export function pageTitle(model) {
  const stack = [model.document];
  while (stack.length) {
    const node = stack.pop();
    if (node.tagName === "title") return collapse(textOf(node));
    for (const child of node.childNodes || []) stack.push(child);
  }
  return "";
}

// Line number (1-based) of an element's start tag.
export function lineOf(node) {
  return node.sourceCodeLocation.startLine;
}

export function decodeEntities(text) {
  return decodeHTML(text);
}
