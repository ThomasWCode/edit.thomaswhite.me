// Checks run before Save, on the working source's parse5 tree.
//
// Blocking findings mirror the site repository's CI (tests/static/*.test.mjs),
// so a Save that passes here does not turn the pull request red: Liquid
// markers, banned words, "passionate" more than once site-wide, school years
// without a review date, the Now section's Updated line, the new-tab rule for
// links, local references that point at nothing. The editor adds a few of its
// own: a link to a missing #anchor (on changed lines), an emptied heading, and
// any change outside main or inside a locked block.
//
// Warnings compare the working page with the page as loaded: more
// exclamation marks, a Now line edited without the helper, the shared call to
// action, emptied blocks, straight quotes, school years to re-date, a gallery
// caption that no longer matches.
//
// Each finding: { level: "block" | "warn", code, message, key, line, fix? }.

import {
  ancestorsOf,
  attribute,
  classTokens,
  collapse,
  elementChildren,
  isElement,
  LOCK_REASONS,
  textOf,
} from "./page-model.js";
import { diffSequences } from "./sequence-diff.js";
import { MONTHS } from "./edits.js";

const BANNED = /\b(impressive|incredible|journey|leverage|showcase)\b/gi;
const PASSIONATE = /\bpassionate\b/gi;
const SCHOOL_YEAR = /Year 1[0-3]\b/;
const CHECKED_ATTRIBUTES = ["alt", "content", "title", "aria-label", "data-caption"];
const REFERENCE_ATTRIBUTES = ["href", "src", "poster", "data-full-src"];

// Every element and text node in the document, with ancestors (outermost first).
function walk(model, visit) {
  const stack = [];
  const recurse = (node) => {
    for (const child of node.childNodes || []) {
      if (child.nodeName === "#text") visit(child, stack);
      else if (isElement(child)) {
        visit(child, stack);
        stack.push(child);
        recurse(child);
        if (child.content) recurse(child.content);
        stack.pop();
      }
    }
  };
  recurse(model.document);
}

// The nearest element under main with a key, for "go to".
function keyNear(model, node) {
  for (const item of [node, ...ancestorsOf(node, null)]) {
    const key = model.keyOf.get(item);
    if (key !== undefined) return key;
  }
  return null;
}

function lineAt(source, offset) {
  let line = 1;
  for (let index = source.indexOf("\n"); index >= 0 && index < offset; index = source.indexOf("\n", index + 1)) line += 1;
  return line;
}

function finding(model, level, code, message, node, extra = {}) {
  const location = node && node.sourceCodeLocation;
  return {
    level,
    code,
    message,
    key: node ? keyNear(model, node) : null,
    line: location ? location.startLine : null,
    ...extra,
  };
}

// Lines of `after` that are new or changed relative to `before` (1-based).
export function changedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines = new Set();
  for (const operation of diffSequences(a, b)) if (operation.type === "insert") lines.add(operation.newIndex + 1);
  return lines;
}

const onChangedLine = (node, lines) => {
  const location = node.sourceCodeLocation;
  if (!location) return false;
  for (let line = location.startLine; line <= location.endLine; line += 1) if (lines.has(line)) return true;
  return false;
};

// Paths a same-tab link may point at: every page, the CV and the redirects,
// from each published page's permalink; external redirects are excluded
// (tests/static/site-contracts.test.mjs, "only links to the site's own pages
// open in the same tab").
export function siteContext({ pages, files }) {
  const samePagePaths = new Set();
  const pagePaths = new Set();
  const idsByPath = new Map();
  for (const page of pages) {
    if (!page.permalink) continue;
    pagePaths.add(page.permalink);
    if (!page.externalRedirect) samePagePaths.add(page.permalink);
    if (page.ids) idsByPath.set(page.permalink, page.ids);
  }
  return { samePagePaths, pagePaths, idsByPath, files: new Set(files) };
}

// A page's refresh target, when it is an external redirect.
export function isExternalRedirect(model) {
  let external = false;
  walk(model, (node) => {
    if (node.tagName === "meta" && (attribute(node, "http-equiv") || "").toLowerCase() === "refresh") {
      external = /url=https?:\/\//i.test(attribute(node, "content") || "");
    }
  });
  return external;
}

function checkLink(model, node, context, lines, findings, tabRule) {
  const href = attribute(node, "href") || "";
  let pathname;
  try {
    pathname = decodeURIComponent(href.split(/[?#]/)[0]);
  } catch {
    pathname = href.split(/[?#]/)[0];
  }
  const samePage = href.startsWith("#") || pathname === "/" || context.samePagePaths.has(pathname);
  const newTab = attribute(node, "target") === "_blank";
  const noOpener = /\bnoopener\b/.test(attribute(node, "rel") || "");
  // A local path that is neither a page nor a file is reported by
  // checkReferences; which tab it would open in is then beside the point.
  const unknownLocal =
    pathname.startsWith("/") && !pathname.startsWith("//") && !context.pagePaths.has(pathname) && !context.files.has(pathname.slice(1));
  const applies = tabRule && !unknownLocal;
  if (applies && samePage && newTab) {
    findings.push(finding(model, "block", "link-new-tab", `“${href}” is a page of this site, so it must open in the same tab.`, node, { fix: "same-tab" }));
  } else if (applies && !samePage && !(newTab && noOpener)) {
    findings.push(finding(model, "block", "link-same-tab", `“${href}” leaves the site's pages, so it must open in a new tab (target="_blank" rel="noopener noreferrer").`, node, { fix: "new-tab" }));
  }
  if (!onChangedLine(node, lines) || !href.includes("#")) return;
  const anchor = href.slice(href.indexOf("#") + 1);
  if (!anchor) return;
  const targetPath = href.startsWith("#") ? model.permalink : pathname;
  const ids = targetPath === model.permalink ? model.ids : context.idsByPath.get(targetPath);
  if (!ids) {
    if (context.pagePaths.has(targetPath)) {
      findings.push(finding(model, "warn", "anchor-unknown", `Couldn't check “#${anchor}” on ${targetPath} yet.`, node));
    }
    return;
  }
  if (!ids.has(anchor)) {
    findings.push(finding(model, "block", "anchor-missing", `“${href}” points at #${anchor}, which is not on ${targetPath}.`, node));
  }
}

function checkReferences(model, node, context, findings) {
  for (const name of REFERENCE_ATTRIBUTES) {
    const value = attribute(node, name);
    if (value && value.startsWith("/") && !value.startsWith("//")) checkLocal(model, node, value, context, findings);
  }
  const srcset = attribute(node, "srcset");
  if (srcset) {
    for (const candidate of srcset.split(",")) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) checkLocal(model, node, url, context, findings);
    }
  }
}

function checkLocal(model, node, value, context, findings) {
  let pathname;
  try {
    pathname = decodeURIComponent(value.split(/[?#]/)[0]);
  } catch {
    pathname = value.split(/[?#]/)[0];
  }
  if (!pathname || pathname === "/" || context.pagePaths.has(pathname) || context.files.has(pathname.slice(1))) return;
  findings.push(finding(model, "block", "missing-file", `“${value}” is not a page or a file in the site repository.`, node));
}

export function checkPage(model, original, context) {
  const findings = [];
  const source = model.source;
  const lines = changedLines(original.source, source);

  // Liquid: GitHub Pages runs every page with front matter through Jekyll.
  for (const marker of ["{{", "{%"]) {
    const index = source.indexOf(marker);
    if (index >= 0) {
      findings.push({
        level: "block",
        code: "liquid",
        message: `“${marker}” would be read as a Jekyll (Liquid) tag. Reword it.`,
        key: null,
        line: lineAt(source, index),
      });
    }
  }

  const updatedSections = [];
  // The site's new-tab contract covers pages, documents and redirects, not
  // external redirects like /gravatar/, whose fallback link opens in place.
  const tabRule = !isExternalRedirect(model);
  walk(model, (node, ancestors) => {
    if (node.nodeName === "#text") {
      const text = node.value;
      for (const match of text.matchAll(BANNED)) {
        findings.push(finding(model, "block", "banned-word", `“${match[0]}” is on the site's banned list.`, node.parentNode));
      }
      const year = SCHOOL_YEAR.exec(text);
      if (year && !ancestors.some((item) => attribute(item, "data-review"))) {
        findings.push(finding(model, "block", "school-year", `“${year[0]}” needs a data-review date on this element or one around it.`, node.parentNode));
      }
      return;
    }
    for (const name of CHECKED_ATTRIBUTES) {
      const value = attribute(node, name);
      if (!value) continue;
      for (const match of value.matchAll(BANNED)) {
        findings.push(finding(model, "block", "banned-word", `“${match[0]}” (in ${name}) is on the site's banned list.`, node));
      }
    }
    const covered = [...ancestors, node].some((item) => attribute(item, "data-review"));
    for (const { name, value } of node.attrs) {
      if (!name.startsWith("data-") && SCHOOL_YEAR.test(value) && !covered) {
        findings.push(finding(model, "block", "school-year", `The ${name} attribute mentions a school year without a data-review date.`, node));
      }
    }
    if (attribute(node, "data-updated")) updatedSections.push(node);
    if (node.tagName === "a" && attribute(node, "href") !== null) checkLink(model, node, context, lines, findings, tabRule);
    checkReferences(model, node, context, findings);
  });

  for (const section of updatedSections) {
    const [year, month] = attribute(section, "data-updated").split("-");
    const expected = `Updated ${MONTHS[Number(month) - 1]} ${year}`;
    if (!collapse(textOf(section)).includes(expected)) {
      findings.push(finding(model, "block", "now-updated", `This section must say “${expected}”.`, section, { fix: "now" }));
    }
  }

  if (model.main) {
    // An emptied element has no text, so it is no longer a block: find it directly.
    const emptied = [];
    walk(model, (node) => {
      if (!isElement(node) || !model.keyOf.has(node)) return;
      if (/^(p|li|h[1-6]|figcaption|blockquote)$/.test(node.tagName) && !collapse(textOf(node)) && !elementChildren(node).length) {
        emptied.push(node);
      }
    });
    for (const node of emptied) {
      if (/^h[1-6]$/.test(node.tagName)) {
        findings.push(finding(model, "block", "empty-heading", "A heading can't be empty.", node));
      } else if (onChangedLine(node, lines)) {
        findings.push(finding(model, "warn", "empty-block", "This is now empty. Remove it with × if it should go.", node));
      }
    }
  }

  findings.push(...protectedChanges(model, original));
  findings.push(...warnings(model, original, lines));
  return dedupe(findings);
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((item) => {
    const id = `${item.level}|${item.code}|${item.line}|${item.message}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// Anything outside main, and every locked block, must be byte-identical.
function protectedChanges(model, original) {
  const findings = [];
  if (!model.main || !original.main) return findings;
  const outside = (m) => {
    const location = m.main.sourceCodeLocation;
    return [m.source.slice(0, location.startTag.endOffset), m.source.slice(location.endTag.startOffset)];
  };
  const [beforeNow, afterNow] = outside(model);
  const [beforeThen, afterThen] = outside(original);
  if (beforeNow !== beforeThen || afterNow !== afterThen) {
    findings.push({ level: "block", code: "outside-main", message: "Something outside the page's main content changed.", key: null, line: null });
  }
  // The Updated line is locked against typing but rewritten by the Now helper;
  // the now-updated check verifies it instead.
  const locked = (m) =>
    m.blocks
      .filter((block) => block.lock && block.lock !== LOCK_REASONS.nowUpdated)
      .map((block) => m.source.slice(block.node.sourceCodeLocation.startOffset, block.node.sourceCodeLocation.endOffset));
  const lockedNow = locked(model);
  const lockedThen = locked(original);
  if (lockedNow.length !== lockedThen.length || lockedNow.some((text, index) => text !== lockedThen[index])) {
    findings.push({ level: "block", code: "locked-changed", message: "A locked part of the page (a heading, a quote or a fixed label) changed.", key: null, line: null });
  }
  return findings;
}

function mainText(model) {
  if (!model.main) return "";
  const texts = [];
  const visit = (node) => {
    for (const child of node.childNodes || []) {
      if (child.nodeName === "#text") texts.push(child.value);
      else if (isElement(child)) visit(child);
    }
  };
  visit(model.main);
  return texts.join(" ");
}

const count = (text, pattern) => (text.match(pattern) || []).length;

function warnings(model, original, lines) {
  const findings = [];
  const textNow = mainText(model);
  const textThen = mainText(original);

  const bangsNow = count(textNow, /!/g);
  if (bangsNow > 1 && bangsNow > count(textThen, /!/g)) {
    findings.push({ level: "warn", code: "exclamations", message: `This page now has ${bangsNow} exclamation marks; the voice guide allows one.`, key: null, line: null });
  }

  const straightNow = count(textNow, /['"]/g);
  if (straightNow > count(textThen, /['"]/g)) {
    findings.push({ level: "warn", code: "straight-quotes", message: "Straight quotes were typed; the site uses curly ones (’ “ ”).", key: null, line: null, fix: "curl-quotes" });
  }

  const changedBlocks = model.blocks.filter((block) => onChangedLine(block.node, lines));
  const nowChanged = changedBlocks.some((block) => block.inNow && !classTokens(block.node).includes("now-updated"));
  if (nowChanged && model.now && original.now && model.now.updated === original.now.updated) {
    findings.push(finding(model, "warn", "now-helper", "A Now line changed but the Updated month didn't. Use the Now helper.", model.nodeOf.get(model.now.key), { fix: "now" }));
  }
  if (changedBlocks.some((block) => block.shared)) {
    findings.push(finding(model, "warn", "shared-cta", "The call to action is repeated on Home, Programming, Volunteering and Contact. Change all four the same way.", changedBlocks.find((block) => block.shared).node));
  }
  for (const block of changedBlocks) {
    if (SCHOOL_YEAR.test(textOf(block.node))) {
      findings.push(finding(model, "warn", "school-year-edited", "This mentions a school year: check its data-review date is the next 1 September.", block.node));
    }
  }
  for (const image of model.images) {
    if (!image.gallery || !image.gallery.captionKey) continue;
    const button = model.nodeOf.get(image.gallery.buttonKey);
    const figcaption = model.nodeOf.get(image.gallery.captionKey);
    // Without data-caption the gallery script shows the figcaption itself.
    if (attribute(button, "data-caption") === null) continue;
    if (!onChangedLine(button, lines) && !onChangedLine(figcaption, lines)) continue;
    const caption = collapse(textOf(figcaption));
    const dataCaption = collapse(attribute(button, "data-caption"));
    if (dataCaption !== caption) {
      findings.push(finding(model, "warn", "gallery-caption", `The expanded-photo caption (“${dataCaption}”) no longer matches the visible caption.`, button, { fix: "gallery-caption" }));
    }
  }
  return findings;
}

// Site-wide: "passionate" may appear once across every published page, and
// every data-record value must be a "### slug" heading in docs/record.md
// (`slugs`, when the record is loaded).
export function checkSite(models, { slugs = null } = {}) {
  const findings = [];
  if (slugs) {
    for (const model of models) {
      walk(model, (node) => {
        const slug = isElement(node) ? attribute(node, "data-record") : null;
        if (slug !== null && !slugs.has(slug)) {
          findings.push({
            ...finding(model, "block", "record-slug", `${model.path} uses data-record="${slug}", which is not a ### heading in docs/record.md.`, node),
            path: model.path,
          });
        }
      });
    }
  }
  let total = 0;
  const where = [];
  for (const model of models) {
    walk(model, (node) => {
      const values = node.nodeName === "#text" ? [node.value] : CHECKED_ATTRIBUTES.map((name) => attribute(node, name)).filter(Boolean);
      for (const value of values) {
        const found = count(value, PASSIONATE);
        if (found) {
          total += found;
          where.push(model.path);
        }
      }
    });
  }
  if (total > 1) {
    findings.push({
      level: "block",
      code: "passionate",
      message: `“Passionate” appears ${total} times across the site (${[...new Set(where)].join(", ")}); the limit is one.`,
      key: null,
      line: null,
    });
  }
  return findings;
}

// Curls straight quotes the way the site writes them: ’ for apostrophes and
// closing singles, ‘ after a space or an opening bracket, “ ” for doubles.
export function curlQuotes(text) {
  return text
    .replace(/(^|[\s([{—–-])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/(^|[\s([{—–-])'/g, "$1‘")
    .replace(/'/g, "’");
}
