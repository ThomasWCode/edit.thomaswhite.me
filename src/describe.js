// Words for commits and pull requests: what changed in each file, read from
// the file as it was and as it is. Pure (no DOM), so the Save dialog, the
// publish flow and the tests share it. The AI suggestions start from the same
// lines, with the private files (docs/) reduced to line counts (forAi).

import { lineHunks, trimEqualRuns, wordDiff } from "./diff-view.js";
import { liveSource } from "./drafting.js";
import { updatedLabel } from "./edits.js";
import { attribute, blockText, buildPageModel, collapse, EDITOR_DRAFT_KINDS, elementChildren, pageTitle, previousElementSibling, textOf } from "./page-model.js";
import { diffSequences } from "./sequence-diff.js";
import { fallbackLabel, labelFromTitle } from "./site-files.js";

export const SUBJECT_LIMIT = 72;
export const CHANGES_START = "<!-- editor:changes -->";
export const CHANGES_END = "<!-- /editor:changes -->";
export const FOOTER =
  "Edits made at https://edit.thomaswhite.me. If a fact changed, update `docs/record.md` (the editor's Record tab) in this pull request before merging.";
const TITLE_MARK = /<!-- editor:title ([\s\S]*?) -->/;
const OLD_BODY_START = "Edits made at https://edit.thomaswhite.me.";
const EXCERPT_LIMIT = 90;
const WORDS_LIMIT = 30;

// The Record and the blog sources: never published, never sent to the AI.
export const isPrivatePath = (path) => path.startsWith("docs/");

const quote = (text) => `“${text}”`;
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function clip(text, limit = EXCERPT_LIMIT) {
  const clean = collapse(text || "");
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function joinAnd(list) {
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export function fileLabel(path, model = null) {
  if (path === "docs/record.md") return "Record";
  const source = path.match(/^docs\/blog-sources\/(.+)\.md$/);
  if (source) return `Blog source ${source[1]}`;
  const title = model ? pageTitle(model) : "";
  return title ? labelFromTitle(title) : path.endsWith(".html") ? fallbackLabel(path) : path;
}

function safeModel(source, path) {
  try {
    return buildPageModel(source, { path });
  } catch {
    return null;
  }
}

// One file: { path, label, page, items }. `before` or `after` is null for a
// file added or removed; the page models can be passed to save parsing again.
export function describeFile({ path, before, after, label = null, beforeModel = null, afterModel = null }) {
  const page = path.endsWith(".html");
  if (before === null || after === null) {
    const model = page && after !== null ? afterModel || safeModel(after, path) : null;
    return { path, label: label || fileLabel(path, model), page, items: [{ kind: before === null ? "new-file" : "deleted-file" }] };
  }
  if (!page) return { path, label: label || fileLabel(path), page, items: lineItems(before, after) };
  const a = beforeModel || safeModel(before, path);
  const b = afterModel || safeModel(after, path);
  if (!a || !b) return { path, label: label || fileLabel(path, b || a), page, items: lineItems(before, after) };
  // What changes on thomaswhite.me: the two versions as it serves them, drafts
  // left out (drafting.js). Then the drafts themselves: placeholders finished,
  // and the editor's drafts saved, edited or discarded.
  const liveA = safeModel(liveSource(a), path) || a;
  const liveB = safeModel(liveSource(b), path) || b;
  const live = [...blockItems(liveA, liveB).items, ...linkItems(liveA, liveB), ...imageItems(liveA, liveB), ...nowItems(liveA, liveB)];
  const finished = draftItems(a, b, blockItems(a, b).gone);
  // A draft finished (a placeholder written, a checked article approved) shows
  // up live as new text: say it once, as the draft finished.
  const plain = (text) => collapse((text || "").replace(/ — /g, " "));
  const done = finished.map((item) => plain(item.text)).filter(Boolean);
  const partOfDone = (item) => item.kind === "added" && done.some((text) => text.includes(plain(item.text)));
  let items = [...live.filter((item) => !partOfDone(item)), ...finished, ...editorDraftItems(a, b, liveA, liveB)];
  // Live content made a draft: gone from the live page, kept as a new draft.
  for (const saved of items.filter((item) => item.kind === "draft-added" && item.draft === "new")) {
    const gone = items.find((item) => item.kind === "removed" && plain(item.text) === plain(saved.text));
    if (gone) items = items.filter((item) => item !== gone && item !== saved).concat({ kind: "unpublished", tag: saved.tag, text: saved.text });
  }
  if (!items.length && before !== after) items.push({ kind: "markup" });
  return { path, label: label || fileLabel(path, b), page, items };
}

// The editor's drafts ("new", "replace", "remove"), outermost only, in page
// order: { kind, tag, text, live } where live is the text a new version replaces.
function editorDrafts(model) {
  const inDraft = (node) => {
    for (let item = node; item && item.attrs; item = item.parentNode) if (EDITOR_DRAFT_KINDS.has(attribute(item, "data-draft"))) return true;
    return false;
  };
  return model.drafts
    .filter((draft) => EDITOR_DRAFT_KINDS.has(draft.kind) && !inDraft(draft.node.parentNode))
    .map((draft) => {
      const previous = draft.kind === "replace" ? previousElementSibling(draft.node) || draft.node : null;
      return {
        kind: draft.kind,
        tag: draft.node.tagName,
        text: collapse(textOf(draft.node)),
        live: previous ? collapse(textOf(previous)) : null,
        // What publishing it changes on the live site: a new version takes the
        // live element away, a removal takes itself away, new content arrives.
        sign: publishSign(previous || draft.node),
      };
    });
}

// An element as the live site shows it (tag, attributes without a draft's
// marker and with renamed ids named back, and words), or, for a phrase's bare
// span, which the live site unwraps, just its words.
function publishSign(node) {
  const attrs = (node.attrs || []).filter((attr) => attr.name !== "data-draft");
  if (node.tagName === "span" && !attrs.length) return { words: collapse(textOf(node)) };
  const named = attrs.map((attr) => `${attr.name === "data-draft-id" ? "id" : attr.name}="${attr.value}"`).sort();
  return { element: `<${node.tagName} ${named.join(" ")}>${collapse(textOf(node))}` };
}

const signCounts = new WeakMap();
// How often a sign appears in a page's live view.
function occurrences(model, sign) {
  const root = model.main || model.document;
  if (sign.words !== undefined) return sign.words ? collapse(textOf(root)).split(sign.words).length - 1 : 0;
  if (!signCounts.has(model)) {
    const counts = new Map();
    const visit = (node) => {
      for (const child of elementChildren(node)) {
        const { element } = publishSign(child);
        if (element) counts.set(element, (counts.get(element) || 0) + 1);
        visit(child);
      }
    };
    visit(root);
    signCounts.set(model, counts);
  }
  return signCounts.get(model).get(sign.element) || 0;
}

// Drafts saved, edited or discarded. A draft that went was published when the
// live views show its sign arriving (new content) or leaving (a new version's
// live element, a removal); the live changes say so. Otherwise it was
// discarded. Whole elements are compared, so a draft that changed only a
// link's address, or words found elsewhere on the page, is told apart.
function editorDraftItems(a, b, liveA, liveB) {
  const items = [];
  const published = (from) => {
    const before = occurrences(liveA, from.sign);
    const after = occurrences(liveB, from.sign);
    return from.kind === "new" ? after > before : after < before;
  };
  for (const kind of EDITOR_DRAFT_KINDS) {
    const run = pairRun(
      editorDrafts(a).filter((draft) => draft.kind === kind),
      editorDrafts(b).filter((draft) => draft.kind === kind),
    );
    for (const [from, to] of run.pairs) {
      if (from.text !== to.text) items.push({ kind: "draft-edited", draft: kind, tag: to.tag, before: from.text, after: to.text });
    }
    for (const to of run.added) items.push({ kind: "draft-added", draft: kind, tag: to.tag, text: to.text, live: to.live });
    for (const from of run.removed) {
      if (!published(from)) items.push({ kind: "draft-discarded", draft: kind, tag: from.tag, text: from.text });
    }
  }
  return items;
}

// Drafts saved, edited or discarded change nothing live. (Taking content off
// the live site does, so it is listed with the live changes.)
const isDraftItem = (item) => ["draft-added", "draft-edited", "draft-discarded"].includes(item.kind);

// A file that isn't text the editor reads (a script, a stylesheet).
export function otherFile(path, status) {
  const kind = status === "added" ? "new-file" : status === "removed" ? "deleted-file" : "changed-file";
  return { path, label: path, page: false, items: [{ kind }] };
}

// Blocks, aligned by their text so an added or removed item doesn't make
// every later block look changed. A deletion next to an insertion is a
// rewording; the rest were added or removed. The Now section's Updated line
// is left to nowItems. Returns { items, gone }: gone holds the keys of the
// removed blocks, whose drafts went with them rather than being finished.
function blockItems(a, b) {
  const listOf = (model) =>
    model.blocks.filter((block) => block.key !== model.now?.lineKey).map((block) => ({ block, text: blockText(model, block.key) }));
  const listA = listOf(a);
  const listB = listOf(b);
  const items = [];
  const gone = new Set();
  let deleted = [];
  let inserted = [];
  const flush = () => {
    const run = pairRun(deleted, inserted);
    for (const [from, to] of run.pairs) items.push({ kind: "text", before: from.text, after: to.text });
    for (const { block } of run.removed) gone.add(block.key);
    items.push(...units("removed", a, run.removed), ...units("added", b, run.added));
    deleted = [];
    inserted = [];
  };
  for (const operation of diffSequences(listA, listB, (x, y) => x.text === y.text)) {
    if (operation.type === "delete") deleted.push(listA[operation.oldIndex]);
    else if (operation.type === "insert") inserted.push(listB[operation.newIndex]);
    else flush();
  }
  flush();
  return { items, gone };
}

// Added or removed blocks, one item per paragraph or list item (a dated list
// item's label and text are two blocks).
function units(kind, model, entries) {
  const groups = new Map();
  for (const { block, text } of entries) {
    const key = block.structuralKey ?? block.key;
    const group = groups.get(key) || { kind, tag: (model.nodeOf.get(key) || block.node).tagName, texts: [] };
    if (text) group.texts.push(text);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ kind: group.kind, tag: group.tag, text: group.texts.join(" — ") }));
}

// Drafts finished: fewer of a kind than before, not counting drafts whose
// block was removed. Those whose text is still found among the remaining
// drafts were not the ones finished.
function draftItems(a, b, gone) {
  const items = [];
  for (const kind of ["note", "inline", "check"]) {
    const before = a.drafts.filter((draft) => draft.kind === kind && !gone.has(draft.blockKey ?? draft.key));
    const after = b.drafts.filter((draft) => draft.kind === kind);
    let finished = before.length - after.length;
    if (finished <= 0) continue;
    const item = kind === "check" ? "approved" : "draft-done";
    const left = after.map((draft) => collapse(textOf(draft.node)));
    for (const draft of before) {
      if (!finished) break;
      const text = collapse(textOf(draft.node));
      const index = left.indexOf(text);
      if (index >= 0) {
        left.splice(index, 1);
        continue;
      }
      items.push({ kind: item, text });
      finished -= 1;
    }
    for (; finished > 0; finished -= 1) items.push({ kind: item, text: "" });
  }
  return items;
}

// Link addresses and tabs, when the page has the same links as before.
function linkItems(a, b) {
  if (a.links.length !== b.links.length) return [];
  const items = [];
  a.links.forEach((link, index) => {
    const other = b.links[index];
    const text = clip(textOf(other.node), 40);
    if ((link.href || "") !== (other.href || "")) items.push({ kind: "link", text, before: link.href || "", after: other.href || "" });
    const newTab = attribute(other.node, "target") === "_blank";
    if ((attribute(link.node, "target") === "_blank") !== newTab) items.push({ kind: "link-tab", text, newTab });
  });
  return items;
}

// Alt text and gallery captions, when the page has the same images as before.
function imageItems(a, b) {
  if (a.images.length !== b.images.length) return [];
  const items = [];
  const caption = (model, image) => (image.gallery ? attribute(model.nodeOf.get(image.gallery.buttonKey), "data-caption") ?? "" : "");
  a.images.forEach((image, index) => {
    const other = b.images[index];
    const altBefore = attribute(image.node, "alt") ?? "";
    const altAfter = attribute(other.node, "alt") ?? "";
    if (altBefore !== altAfter) items.push({ kind: "alt", before: altBefore, after: altAfter });
    const captionBefore = caption(a, image);
    const captionAfter = caption(b, other);
    if (captionBefore !== captionAfter) items.push({ kind: "caption", before: captionBefore, after: captionAfter });
  });
  return items;
}

function nowItems(a, b) {
  const before = a.now ? a.now.updated : null;
  const after = b.now ? b.now.updated : null;
  return after && before !== after ? [{ kind: "updated", before, after }] : [];
}

// Markdown (or a page that can't be parsed): changed lines, paired within
// each hunk as rewordings. A change to blank lines alone is still a change.
function lineItems(before, after) {
  const items = [];
  for (const hunk of lineHunks(before, after, 0)) {
    const removed = hunk.rows.filter((row) => row.type === "-" && row.text.trim()).map((row) => ({ text: row.text }));
    const added = hunk.rows.filter((row) => row.type === "+" && row.text.trim()).map((row) => ({ text: row.text }));
    const { pairs, removed: gone, added: fresh } = pairRun(removed, added);
    for (const [from, to] of pairs) items.push({ kind: "text", before: from.text, after: to.text });
    for (const { text } of gone) items.push({ kind: "removed", tag: "line", text });
    for (const { text } of fresh) items.push({ kind: "added", tag: "line", text });
  }
  if (!items.length && before !== after) items.push({ kind: "spacing" });
  return items;
}

// How many words two texts share (Dice's coefficient, ignoring case): 1 for
// the same words, 0 for none in common.
function similarity(a, b) {
  const words = (text) => text.toLowerCase().split(/\s+/).filter(Boolean);
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return 0;
  const counts = new Map();
  for (const word of x) counts.set(word, (counts.get(word) || 0) + 1);
  let common = 0;
  for (const word of y) {
    const left = counts.get(word) || 0;
    if (left) {
      common += 1;
      counts.set(word, left - 1);
    }
  }
  return (2 * common) / (x.length + y.length);
}

const PAIR_THRESHOLD = 0.4;

// One changed run: which deleted entry became which inserted one. Pairs are
// chosen by shared words, most alike first, in order (a later deletion never
// pairs with an earlier insertion), so a removal or an insertion next to a
// rewording is reported as what it is. With nothing alike, a run of equal
// length is paired in order (a paragraph rewritten outright). Entries are
// { text, ... }; returns { pairs: [[deleted, inserted]], removed, added }.
function pairRun(deleted, inserted) {
  const candidates = [];
  deleted.forEach((from, di) =>
    inserted.forEach((to, ii) => {
      const score = similarity(from.text, to.text);
      if (score >= PAIR_THRESHOLD) candidates.push({ di, ii, score });
    }),
  );
  candidates.sort((x, y) => y.score - x.score || x.di - y.di);
  let chosen = [];
  for (const { di, ii } of candidates) {
    const clash = chosen.some(([d, i]) => d === di || i === ii || d < di !== i < ii);
    if (!clash) chosen.push([di, ii]);
  }
  if (!chosen.length && deleted.length === inserted.length) chosen = deleted.map((_, index) => [index, index]);
  chosen.sort((x, y) => x[0] - y[0]);
  const pairedDeleted = new Set(chosen.map(([di]) => di));
  const pairedInserted = new Set(chosen.map(([, ii]) => ii));
  return {
    pairs: chosen.map(([di, ii]) => [deleted[di], inserted[ii]]),
    removed: deleted.filter((_, index) => !pairedDeleted.has(index)),
    added: inserted.filter((_, index) => !pairedInserted.has(index)),
  };
}

const NOUNS = {
  p: ["paragraph"],
  li: ["list item"],
  line: ["line"],
  h2: ["heading"],
  h3: ["heading"],
  h4: ["heading"],
  span: ["phrase"],
  a: ["link"],
  section: ["section"],
  article: ["article"],
  figure: ["figure"],
  picture: ["picture"],
};
const noun = (tag) => (NOUNS[tag] || ["block"])[0];
const month = (value) => {
  try {
    return updatedLabel(value).replace(/^Updated /, "");
  } catch {
    return value;
  }
};

// A text change that is one short run of words: "“see” → “watch”", "add
// “very”", "remove “really”". Null for anything longer or scattered.
export function wordChange(item) {
  if (item.kind !== "text") return null;
  const runs = wordDiff(item.before, item.after);
  const changed = runs.map((run, index) => (run.type === "equal" ? -1 : index)).filter((index) => index >= 0);
  if (!changed.length || changed[changed.length - 1] - changed[0] + 1 !== changed.length) return null;
  const removed = runs.filter((run) => run.type === "delete").map((run) => run.text).join(" ");
  const added = runs.filter((run) => run.type === "insert").map((run) => run.text).join(" ");
  if (removed.length > WORDS_LIMIT || added.length > WORDS_LIMIT) return null;
  if (removed && added) return `${quote(removed)} → ${quote(added)}`;
  return added ? `add ${quote(added)}` : `remove ${quote(removed)}`;
}

// One line of a commit body or pull request description.
export function itemLine(item) {
  switch (item.kind) {
    case "text": {
      const runs = trimEqualRuns(wordDiff(item.before, item.after), 4);
      const side = (type) => clip(runs.filter((run) => run.type === "equal" || run.type === type).map((run) => run.text).join(" "), 160);
      return `${quote(side("delete"))} → ${quote(side("insert"))}`;
    }
    case "added":
      return `Added a ${noun(item.tag)}: ${quote(clip(item.text))}`;
    case "removed":
      return `Removed a ${noun(item.tag)}: ${quote(clip(item.text))}`;
    case "draft-done":
      return item.text ? `Marked a draft done: ${quote(clip(item.text))}` : "Marked a draft done";
    case "approved":
      return item.text ? `Approved a checked draft: ${quote(clip(item.text))}` : "Approved a checked draft";
    case "link":
      return `Link ${quote(item.text)} now goes to ${item.after} (was ${item.before})`;
    case "link-tab":
      return `Link ${quote(item.text)} now opens in ${item.newTab ? "a new tab" : "the same tab"}`;
    case "alt":
      return `Alt text: ${quote(clip(item.before))} → ${quote(clip(item.after))}`;
    case "caption":
      return `Gallery caption: ${quote(clip(item.before))} → ${quote(clip(item.after))}`;
    case "updated":
      return `Now section updated: ${item.before ? `${month(item.before)} → ` : ""}${month(item.after)}`;
    case "new-file":
      return "New file";
    case "deleted-file":
      return "Deleted";
    case "changed-file":
      return "Changed";
    case "spacing":
      return "Changed only blank lines or spacing";
    case "draft-added":
      if (item.draft === "replace") return `Draft of a new version (not live): ${itemLine({ kind: "text", before: item.live, after: item.text })}`;
      if (item.draft === "remove") return `Draft to remove when published (still live): ${quote(clip(item.text))}`;
      return `Draft of a new ${noun(item.tag)} (not live): ${quote(clip(item.text))}`;
    case "draft-edited":
      return `Edited a draft: ${itemLine({ kind: "text", before: item.before, after: item.after })}`;
    case "draft-discarded":
      return `Discarded a draft: ${quote(clip(item.text))}`;
    case "unpublished":
      return `Took a ${noun(item.tag)} off the live site, kept as a draft: ${quote(clip(item.text))}`;
    default:
      return "Changed the page's markup (no text changed)";
  }
}

// A few words for a subject naming one change.
function shortLine(item) {
  const short = (text) => quote(clip(text, 36));
  switch (item.kind) {
    case "text":
      return wordChange(item) || `reword ${short(item.after)}`;
    case "added":
      return `add a ${noun(item.tag)} ${short(item.text)}`;
    case "removed":
      return `remove a ${noun(item.tag)} ${short(item.text)}`;
    case "draft-done":
      return item.text ? `finish the draft ${short(item.text)}` : "finish a draft";
    case "approved":
      return item.text ? `approve ${short(item.text)}` : "approve a checked draft";
    case "link":
      return `point ${quote(item.text)} at ${item.after}`;
    case "link-tab":
      return `${quote(item.text)} opens in ${item.newTab ? "a new tab" : "the same tab"}`;
    case "alt":
      return `alt text ${short(item.after)}`;
    case "caption":
      return `gallery caption ${short(item.after)}`;
    case "draft-added":
      if (item.draft === "replace") return `draft ${wordChange({ kind: "text", before: item.live, after: item.text }) || `a new version of ${short(item.live)}`}`;
      if (item.draft === "remove") return `draft removing ${short(item.text)}`;
      return `draft a new ${noun(item.tag)} ${short(item.text)}`;
    case "draft-edited":
      return `edit the draft ${short(item.after)}`;
    case "draft-discarded":
      return `discard the draft ${short(item.text)}`;
    case "unpublished":
      return `take ${short(item.text)} off the live site`;
    case "updated":
      return `Now section updated for ${month(item.after)}`;
    default:
      return itemLine(item).toLowerCase();
  }
}

// "2 wording changes, 1 draft done".
function counts(items) {
  const order = [];
  const tally = new Map();
  for (const item of items) {
    const key = item.kind === "added" || item.kind === "removed" ? `${item.kind}:${noun(item.tag)}` : item.kind;
    if (!tally.has(key)) order.push(key);
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  return order
    .map((key) => {
      const count = tally.get(key);
      const [kind, what] = key.split(":");
      if (kind === "added") return `${plural(count, what)} added`;
      if (kind === "removed") return `${plural(count, what)} removed`;
      const words = {
        text: plural(count, "wording change"),
        "draft-done": `${plural(count, "draft")} done`,
        approved: `${plural(count, "draft")} approved`,
        link: `${plural(count, "link")} changed`,
        "link-tab": `${plural(count, "link target")} changed`,
        alt: `${plural(count, "alt text")} changed`,
        caption: `${plural(count, "caption")} changed`,
        updated: "Now month updated",
        "new-file": plural(count, "new file"),
        "deleted-file": `${plural(count, "file")} deleted`,
        "changed-file": `${plural(count, "file")} changed`,
        spacing: plural(count, "spacing change"),
        "draft-added": `${plural(count, "draft")} saved`,
        "draft-edited": `${plural(count, "draft")} edited`,
        "draft-discarded": `${plural(count, "draft")} discarded`,
        unpublished: `${plural(count, "part")} taken off the live site`,
      };
      return words[kind] || plural(count, "markup change");
    })
    .join(", ");
}

// "Edit 2 pages and the Record".
function collective(files) {
  const pages = files.filter((file) => file.page).length;
  const record = files.some((file) => file.path === "docs/record.md");
  const sources = files.filter((file) => file.path.startsWith("docs/blog-sources/")).length;
  const other = files.length - pages - (record ? 1 : 0) - sources;
  const parts = [];
  if (pages) parts.push(plural(pages, "page"));
  if (record) parts.push("the Record");
  if (sources) parts.push(plural(sources, "blog source"));
  if (other) parts.push(plural(other, "other file"));
  return `Edit ${joinAnd(parts)}`;
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// The subject line (a commit's first line, a pull request's title): the most
// specific candidate that fits in `limit` characters.
export function summarise(files, limit = SUBJECT_LIMIT) {
  const described = files.filter((file) => file.items.length);
  if (!described.length) return "Edit the site";
  const labels = [...new Set(described.map((file) => (file.path === "docs/record.md" && described.length > 1 ? "the Record" : file.label)))];
  const items = described.flatMap((file) => file.items);
  const candidates = [];
  const changes = items.map(wordChange);
  if (changes.every((change) => change && change === changes[0])) {
    const change = changes[0];
    candidates.push(labels.length === 1 ? `${labels[0]}: ${change}` : `${change.charAt(0).toUpperCase()}${change.slice(1)} on ${joinAnd(labels)}`);
  }
  if (items.length === 1) candidates.push(`${labels[0]}: ${shortLine(items[0])}`);
  const tally = counts(items);
  candidates.push(`${joinAnd(labels)}: ${tally}`, `${collective(described)}: ${tally}`, collective(described));
  const fit = candidates.find((candidate) => candidate.length <= limit);
  return fit || truncate(candidates[candidates.length - 1], limit);
}

// "Physics & Ideas (physics.html)" and a line per change, per file.
export function bodyText(files) {
  return files
    .filter((file) => file.items.length)
    .map((file) => [`${file.label} (${file.path})`, ...file.items.map((item) => `- ${itemLine(item)}`)].join("\n"))
    .join("\n\n");
}

export function commitMessageFor(files) {
  return `${summarise(files)}\n\n${bodyText(files)}\n`;
}

// Page text in a pull request: no raw HTML, no emphasis or links, and no
// @mentions (a zero-width space after the @ keeps GitHub from notifying).
const markdown = (text) => text.replace(/[\\`*_<>[\]]/g, "\\$&").replace(/@/g, "@\u200b");

function changesSection(files, screenshots) {
  const lines = [CHANGES_START];
  const part = (heading, keep) => {
    const shown = files.map((file) => ({ ...file, items: file.items.filter(keep) })).filter((file) => file.items.length);
    if (!shown.length) return;
    lines.push(heading, "");
    for (const file of shown) {
      lines.push(`**${markdown(file.label)}** (\`${file.path}\`)`, "");
      for (const item of file.items) lines.push(`- ${markdown(itemLine(item))}`);
      lines.push("");
    }
  };
  part("### Changes", (item) => !isDraftItem(item));
  part("### Drafts (saved, left out of thomaswhite.me)", isDraftItem);
  if (screenshots.length) {
    lines.push("Screenshot baselines regenerated for the changed pages:", "");
    for (const path of screenshots) lines.push(`- \`${path.split("/").pop()}\``);
    lines.push("");
  }
  lines.push(CHANGES_END);
  return lines.join("\n");
}

// A title inside an HTML comment can't hold "--".
const markable = (title) => title.replace(/-{2,}/g, "–");

// The pull request's description: your note, then the changes between markers
// the editor refreshes on each save, then the footer and, in a comment, the
// title the editor generated (so a title you changed is never replaced).
export function prDescription({ note = "", files, screenshots = [], autoTitle }) {
  const parts = [note.trim(), changesSection(files, screenshots), FOOTER, `<!-- editor:title ${markable(autoTitle)} -->`];
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

// Your note in a description: the text before the changes. A description from
// before the markers existed was all generated, so it has none.
export function noteOf(body) {
  if (!body) return "";
  const start = body.indexOf(CHANGES_START);
  if (start >= 0) return body.slice(0, start).trim();
  if (body.startsWith(OLD_BODY_START)) return "";
  return body.replace(TITLE_MARK, "").replace(FOOTER, "").trim();
}

export function autoTitleOf(body) {
  const match = body ? body.match(TITLE_MARK) : null;
  return match ? match[1] : null;
}

// Whether a pull request still has the title the editor gave it.
export function hasAutoTitle(pr, legacyTitle) {
  const marked = autoTitleOf(pr.body);
  return pr.title === legacyTitle || (marked !== null && markable(pr.title) === marked);
}

// What an AI suggestion may see: the change lines of published files. A
// private file (the Record, a blog source) goes only as how many changes it
// has, under a neutral name: a blog source's file name comes from its post's
// title, so neither its label nor its path is sent.
export function forAi(files, { lines = 20 } = {}) {
  return files
    .filter((file) => file.items.length)
    .map((file) => {
      if (!isPrivatePath(file.path)) {
        return { file: file.label, path: file.path, changes: file.items.slice(0, lines).map((item) => itemLine(item)) };
      }
      const record = file.path === "docs/record.md";
      return {
        file: record ? "Record" : "Blog source",
        path: record ? "docs/record.md" : "docs/blog-sources/",
        changes: [`${plural(file.items.length, "change")} (private file: content not shared)`],
      };
    });
}
