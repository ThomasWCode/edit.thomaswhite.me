// The copy of a page shown in the preview frame (iframe srcdoc). It is built
// from the working source by splicing, never by re-serialising, so what the
// frame shows is the file as it will be saved:
//
// - every script, noscript and meta http-equiv is removed, so no site code,
//   refresh or consent banner runs, and a CSP meta (script-src 'none';
//   form-action 'none') is added first thing in <head>;
// - <base> points at the site, so /CSS/, /Fonts/ and /Images/ load from it;
// - frame.css (the edit states) is linked last in <head>, absolutely, because
//   of the <base>;
// - every element under main gets data-edit-key, and blocks, drafts, links,
//   images and locked parts get data-edit-role; editable blocks and images get
//   tabindex="0" so they can be reached from the keyboard.

import { hasAttribute, isElement } from "./page-model.js";
import { applySplices, escapeAttribute } from "./splice.js";

const REMOVED = (node) =>
  node.tagName === "script" || node.tagName === "noscript" || node.tagName === "base" ||
  (node.tagName === "meta" && hasAttribute(node, "http-equiv"));

function findElement(root, tagName) {
  for (const child of root.childNodes || []) {
    if (!isElement(child)) continue;
    if (child.tagName === tagName) return child;
    const found = findElement(child, tagName);
    if (found) return found;
  }
  return null;
}

export const FRAME_CSP = "script-src 'none'; form-action 'none'";

export function renderCopy(model, { assetsOrigin, editorOrigin }) {
  const splices = [];
  const removeAll = (node) => {
    for (const child of node.childNodes || []) {
      if (!isElement(child)) continue;
      if (REMOVED(child) && child.sourceCodeLocation) {
        const { startOffset, endOffset } = child.sourceCodeLocation;
        splices.push({ start: startOffset, end: endOffset, text: "" });
        continue;
      }
      removeAll(child);
    }
  };
  removeAll(model.document);

  // data-editor tells the site's stylesheet this is the editor's copy, which
  // shows a live element and the new version drafted after it side by side.
  const html = findElement(model.document, "html");
  const htmlStart = html && html.sourceCodeLocation && html.sourceCodeLocation.startTag;
  if (htmlStart) splices.push({ start: htmlStart.startOffset + "<html".length, end: htmlStart.startOffset + "<html".length, text: " data-editor" });

  const head = findElement(model.document, "head");
  const headStart = head && head.sourceCodeLocation && head.sourceCodeLocation.startTag;
  const opening =
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
    `<base href="${escapeAttribute(assetsOrigin)}/">`;
  const stylesheet = `<link rel="stylesheet" href="${escapeAttribute(editorOrigin)}/frame.css">`;
  if (headStart) {
    splices.push({ start: headStart.endOffset, end: headStart.endOffset, text: opening });
    const headEnd = head.sourceCodeLocation.endTag;
    const at = headEnd ? headEnd.startOffset : head.sourceCodeLocation.endOffset;
    splices.push({ start: at, end: at, text: stylesheet });
  } else {
    splices.push({ start: 0, end: 0, text: opening + stylesheet });
  }

  const editable = !model.readOnly;
  for (const [key, node] of model.nodeOf) {
    const roles = editable ? [...(model.roles.get(key) || [])] : [];
    let attributes = ` data-edit-key="${key}"`;
    if (roles.length) attributes += ` data-edit-role="${roles.join(" ")}"`;
    const focusable = roles.includes("block") || roles.includes("image") || roles.includes("gallery");
    if (focusable && !hasAttribute(node, "tabindex")) attributes += ` tabindex="0"`;
    const end = node.sourceCodeLocation.startTag.endOffset;
    const at = model.html[end - 2] === "/" ? end - 2 : end - 1;
    splices.push({ start: at, end: at, text: attributes });
  }

  return applySplices(model.html, splices);
}
