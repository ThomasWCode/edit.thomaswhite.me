// A block as the browser left it after typing, as plain data:
//   { type: "element", key, tag, attrs: [[name, value]], children } | { type: "text", text }
// `key` is the data-edit-key the render copy gave every element under main, or
// null for an element the browser created while editing. dom-snapshot.js builds
// these from the preview's DOM; the tests build them from parse5 trees.

import { VOID_TAGS } from "./page-model.js";

const HTML_WHITESPACE = /[ \t\n\f\r]+/g;
const UNWRAPPABLE = new Set(["span", "font", "b", "i"]);

export const textNode = (text) => ({ type: "text", text });

// Snapshot of a parse5 element (in tests, a parse of the render copy).
export function snapshotFromParse5(node) {
  if (node.nodeName === "#text") return textNode(node.value);
  if (typeof node.tagName !== "string") return null;
  const keyAttribute = node.attrs.find((item) => item.name === "data-edit-key");
  return {
    type: "element",
    key: keyAttribute ? keyAttribute.value : null,
    tag: node.tagName,
    attrs: node.attrs.filter((item) => !item.name.startsWith("data-edit-")).map((item) => [item.name, item.value]),
    children: node.childNodes.map(snapshotFromParse5).filter(Boolean),
  };
}

// Undoes what browsers do to contenteditable text: non-breaking spaces typed
// for spaces, Chrome's <br> in an emptied block, and wrapper elements carrying
// only a style attribute. Adjacent texts are merged and empty ones dropped.
export function sanitise(snapshot) {
  const cleanChildren = (children) => {
    const result = [];
    const pushText = (text) => {
      if (!text) return;
      const last = result[result.length - 1];
      if (last && last.type === "text") last.text += text;
      else result.push(textNode(text));
    };
    for (const child of children) {
      if (child.type === "text") {
        pushText(child.text.replace(/ /g, " "));
        continue;
      }
      const onlyStyle = child.attrs.every(([name]) => name === "style");
      if (child.key === null && UNWRAPPABLE.has(child.tag) && onlyStyle) {
        for (const inner of cleanChildren(child.children)) {
          if (inner.type === "text") pushText(inner.text);
          else result.push(inner);
        }
        continue;
      }
      result.push({ ...child, children: cleanChildren(child.children) });
    }
    return result;
  };

  const root = { ...snapshot, children: cleanChildren(snapshot.children) };
  // Chrome leaves <br> as the last child of a block emptied by deletion.
  const last = root.children[root.children.length - 1];
  if (last && last.type === "element" && last.key === null && last.tag === "br") {
    root.children = root.children.slice(0, -1);
  }
  return root;
}

export function collapsedText(snapshot) {
  const text = (node) => (node.type === "text" ? node.text : node.children.map(text).join(""));
  return text(snapshot).replace(HTML_WHITESPACE, " ").trim();
}

// Element structure by key (text ignored): "k(k1()k2(k3()))". An element the
// browser created appears as "?tag".
export function skeletonOf(snapshot) {
  const walk = (node) =>
    `${node.key === null ? `?${node.tag}` : node.key}(${node.children
      .filter((child) => child.type === "element")
      .map(walk)
      .join("")})`;
  return walk(snapshot);
}

// Element structure by tag name only, for comparing with a re-parse.
export function tagSkeletonOf(snapshot) {
  const walk = (node) =>
    `${node.tag}(${node.children
      .filter((child) => child.type === "element")
      .map(walk)
      .join("")})`;
  return walk(snapshot);
}

// The text between elements, in document order: an element with k element
// children has k + 1 slots, and each child's own slots follow the slot before it.
export function slotTexts(snapshot) {
  const slots = [];
  const walk = (node) => {
    let text = "";
    for (const child of node.children) {
      if (child.type === "text") {
        text += child.text;
      } else {
        slots.push(text);
        text = "";
        if (!VOID_TAGS.has(child.tag)) walk(child);
      }
    }
    slots.push(text);
  };
  walk(snapshot);
  return slots;
}

export function keysIn(snapshot) {
  const keys = [];
  const walk = (node) => {
    if (node.type !== "element") return;
    keys.push(node.key);
    node.children.forEach(walk);
  };
  walk(snapshot);
  return keys;
}
