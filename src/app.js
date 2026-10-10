// The editor once signed in: the file list, the preview, the side panel, and
// Save and Publish. Pure modules do the work (page-model, edits, structure,
// checks, publish-flow); this file keeps the state of each open file and draws
// the interface.

import { AuthNetworkError, SignedOutError } from "./auth.js";
import { changedLines, checkPage, checkSite, curlQuotes, isExternalRedirect, siteContext } from "./checks.js";
import { bodyText, commitMessageFor, describeFile, forAi, noteOf, summarise } from "./describe.js";
import { confirmAction, openDialog, promptText } from "./dialogs.js";
import {
  asDraft,
  discardDraft,
  draftAround,
  draftPhrase,
  hasWaitingVersion,
  liveAsItWas,
  liveChanged,
  makeDraft,
  markDraft,
  publishDraft,
  recordLive,
  refuseWaitingChange,
  WAITING,
} from "./drafting.js";
import { countLineChanges, lineHunks, trimEqualRuns, wordDiff } from "./diff-view.js";
import { $, button, externalLink, h } from "./dom.js";
import {
  commitTextEdit,
  completeDraft,
  EditRejectedError,
  MONTHS,
  openInNewTab,
  openInSameTab,
  setAttribute,
  setNowUpdated,
  updatedLabel,
} from "./edits.js";
import { GitHubError } from "./github-client.js";
import { newPostSource, normaliseMarkdown, recordSlugs } from "./markdown-files.js";
import { attribute, blockText, buildPageModel, collapse, EDITOR_DRAFT_KINDS, pageTitle, previousElementSibling, textOf } from "./page-model.js";
import { createPreview } from "./preview.js";
import { BusyError, createPublishFlow, SaveConflictError } from "./publish-flow.js";
import { fallbackLabel, isPublishedHtml, labelFromTitle, liveUrl, markdownFiles, readOnlyReason, sortPages } from "./site-files.js";
import { addAfter, removalInfo, removeBlock } from "./structure.js";
import { createWorkingStore } from "./working-store.js";

const POLL_MS = 30_000;
const DEPLOY_POLL_MS = 15_000;
const UNDO_LIMIT = 50;
const PREFETCH_CONCURRENCY = 4;

// Collapsed text cut at a word boundary, with an ellipsis when shortened.
export function snippet(text, length) {
  const clean = collapse(text);
  if (clean.length <= length) return clean;
  const cut = clean.slice(0, length);
  const space = cut.lastIndexOf(" ");
  return `${(space > length / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

const BLOCK_NAMES = {
  p: "Paragraph", li: "List item", h1: "Main heading", h2: "Heading", h3: "Subheading", h4: "Label",
  figcaption: "Caption", blockquote: "Quote", a: "Link text", span: "Text", aside: "Aside", div: "Text",
  cite: "Title", footer: "Attribution", dt: "Term", dd: "Description", td: "Table cell", th: "Table heading",
};

export function describeError(error, target) {
  if (error instanceof EditRejectedError) return error.message;
  if (error instanceof SaveConflictError) return error.message;
  if (error instanceof BusyError) return error.message;
  if (error instanceof GitHubError) {
    switch (error.code) {
      case "network":
        return "No connection to GitHub. Your edits are still in this tab.";
      case "not_found":
        return `The GitHub App can't see ${target.owner}/${target.repo}. Install “Homepage Site Editor” on it (GitHub → Settings → Applications), then reload.`;
      case "rate_limited":
        return `GitHub's rate limit was reached. Try again in ${Math.max(1, Math.ceil((error.retryAfter || 60) / 60))} minutes.`;
      case "unauthorized":
        return "GitHub no longer accepts this sign-in. Sign in again; unsaved edits stay in this tab.";
      default:
        return `GitHub said: ${error.message}`;
    }
  }
  return error && error.message ? error.message : String(error);
}

// `suggest(kind, changes)` asks for an AI suggestion (src/suggest.js); null
// hides the "Suggest with AI" buttons.
export function createApp({ target, client, user, onSignedOut, suggest = null }) {
  const store = createWorkingStore({ storage: sessionStorage, target });
  const entries = new Map();
  let currentPath = null;
  let selection = null;
  let generation = 0;
  let typing = false;
  let prefetching = null;
  let pollTimer = null;
  let publishDialogOpen = false;
  // The pull request's title and description fields: built once per opening
  // of the Publish dialog, then re-attached on every render so typing in them
  // survives the checks' polling.
  let publishFields = null;
  let describingBranch = false;
  let publishOpenings = 0;
  let draftMode = readDraftMode();

  const flow = createPublishFlow({
    client,
    target,
    onChange: () => {
      renderTopbar();
      if (publishDialogOpen) renderPublishDialog();
    },
  });

  const preview = createPreview({
    iframe: $("page-frame"),
    overlay: $("overlay"),
    wrap: $("frame-wrap"),
    assetsOrigin: target.assets,
    editorOrigin: location.origin,
    onCommit: commitBlock,
    onSelect: (next) => {
      selection = next;
      renderPanel();
    },
    onInput: () => {
      persistTyping();
      if (!typing) {
        typing = true;
        renderTopbar();
      }
    },
    onShortcut: (name) => {
      if (name === "save") startSave();
    },
  });
  preview.setToolbarActions(toolbarActions);

  // ---- Entries ----------------------------------------------------------------

  const current = () => (currentPath ? entries.get(currentPath) : null);
  const isDirty = (entry) => entry.status === "ready" && (entry.isNew || entry.working !== entry.original);
  const dirtyEntries = () => [...entries.values()].filter(isDirty);
  const pageEntries = () => [...entries.values()].filter((entry) => entry.kind === "page" && entry.status !== "gone");

  function makeEntry(path, kind, sha) {
    return {
      path,
      kind,
      loadedSha: sha ?? null,
      label: kind === "page" ? fallbackLabel(path) : markdownLabel(path),
      status: "unloaded",
      loading: null,
      original: null,
      working: null,
      originalModel: null,
      model: null,
      undo: [],
      log: [],
      stale: null,
      isNew: false,
      error: null,
    };
  }

  function markdownLabel(path) {
    if (path === target.markdown.record) return "Record";
    return path.slice(target.markdown.blogSources.length).replace(/\.md$/, "");
  }

  // Builds the list from a tree, keeping loaded files whose blob is unchanged.
  // Unsaved edits to a file that is no longer in the tree (renamed or deleted
  // on GitHub) are kept, under "No longer on GitHub", until they are
  // discarded; that file is never saved, so never recreated.
  function syncEntries(files) {
    const paths = [...files.keys()];
    const next = new Map();
    const keep = (path, kind) => {
      const sha = files.get(path) ?? null;
      const existing = entries.get(path);
      next.set(path, existing && existing.loadedSha === sha && existing.status === "ready" ? existing : makeEntry(path, kind, sha));
    };
    for (const path of sortPages(paths.filter(isPublishedHtml), { order: target.pageOrder, last: target.lockedFiles })) keep(path, "page");
    const markdown = markdownFiles(target, paths);
    if (markdown.record) keep(markdown.record, "markdown");
    for (const path of markdown.blogSources) keep(path, "markdown");
    for (const path of store.paths()) {
      const record = store.load(path);
      if (next.has(path) || !record) continue;
      if (record.isNew) {
        const entry = entries.get(path) || makeEntry(path, "markdown", null);
        entry.isNew = true;
        next.set(path, entry);
      } else {
        const entry = goneEntry(path, record);
        if (entry) next.set(path, entry);
        else store.remove(path);
      }
    }
    entries.clear();
    for (const [path, entry] of next) entries.set(path, entry);
  }

  // A file no longer on GitHub, with the edits kept for it: every set of
  // { original, working } in its record, the latest last. Null when the
  // record holds none.
  function goneEntry(path, record) {
    const sets = [...staleSets(record.stale), ...(record.working !== record.original ? [{ original: record.original, working: record.working }] : [])];
    if (!sets.length) return null;
    const entry = makeEntry(path, path.endsWith(".html") ? "page" : "markdown", null);
    return Object.assign(entry, { status: "gone", stale: sets, working: sets[sets.length - 1].working });
  }

  function buildModel(entry, text) {
    return buildPageModel(text, { path: entry.path, readOnlyReason: readOnlyReason(target, entry.path) });
  }

  async function ensureLoaded(entry) {
    if (entry.status === "ready" || entry.status === "error" || entry.status === "gone") return entry;
    if (entry.loading) return entry.loading;
    entry.status = "loading";
    entry.loading = (async () => {
      try {
        const text = entry.loadedSha ? await client.getBlobText(entry.loadedSha) : "";
        entry.original = text;
        entry.working = text;
        if (entry.kind === "page") {
          entry.originalModel = buildModel(entry, text);
          entry.model = entry.originalModel;
          const title = pageTitle(entry.model);
          if (title) entry.label = labelFromTitle(title);
        }
        restoreFromStore(entry);
        entry.status = "ready";
      } catch (error) {
        if (error instanceof SignedOutError) throw error;
        entry.status = "error";
        entry.error = error;
      } finally {
        entry.loading = null;
        renderFileList();
      }
      return entry;
    })();
    return entry.loading;
  }

  // Unsaved work from sessionStorage. Edits made to an older version of the
  // file (it changed on GitHub since) are kept aside in `stale`, a list of
  // { original, working }, shown in the panel and stored until discarded: new
  // typing, a Save, or the file changing again never overwrites them.
  const staleSets = (value) => (Array.isArray(value) ? [...value] : value ? [value] : []);
  function restoreFromStore(entry) {
    const record = store.load(entry.path);
    if (!record) return;
    const aside = staleSets(record.stale);
    if (entry.isNew || record.loadedSha === entry.loadedSha) {
      entry.working = record.working;
      entry.log = Array.isArray(record.log) ? record.log : [];
      entry.stale = aside.length ? aside : null;
      if (record.isNew) entry.isNew = true;
      if (entry.kind === "page") {
        try {
          entry.model = buildModel(entry, entry.working);
        } catch {
          entry.working = entry.original;
          entry.model = entry.originalModel;
          persist(entry);
        }
      }
    } else {
      if (record.working !== record.original) aside.push({ original: record.original, working: record.working });
      entry.stale = aside.length ? aside : null;
    }
  }

  function storedRecord(entry, working = entry.working) {
    return { loadedSha: entry.loadedSha, original: entry.original, working, log: entry.log, isNew: entry.isNew, stale: entry.stale };
  }

  function persist(entry) {
    if (isDirty(entry) || entry.stale) store.save(entry.path, storedRecord(entry));
    else store.remove(entry.path);
  }

  // While a block is being typed in, its text reaches sessionStorage after a
  // pause, so a crash mid-block loses at most the last few words. The model and
  // undo stack change only when the block is finished.
  let interimTimer = null;
  function persistTyping() {
    clearTimeout(interimTimer);
    interimTimer = setTimeout(() => {
      const entry = current();
      const live = preview.editingSnapshot();
      if (!entry || entry.kind !== "page" || entry.status !== "ready" || !live) return;
      try {
        const result = commitTextEdit(entry.model, live.key, live.snapshot);
        if (!result.changed) return;
        refuseWaitingChange(entry.model, result.model);
        // In draft mode the words are kept as the draft they will become, so a
        // reload mid-block never turns them into a live change.
        const kept = draftMode ? asDraft(entry.model, result.model) : result.model;
        store.save(entry.path, storedRecord(entry, kept.source));
      } catch {
        // The block's own commit reports anything wrong when it finishes.
      }
    }, 800);
  }

  // Loads every file in the background: labels, draft counts, and the whole
  // site for the checks that look beyond one page.
  function prefetchAll() {
    if (!prefetching) {
      prefetching = (async () => {
        const queue = [...entries.values()].filter((entry) => entry.status === "unloaded");
        const worker = async () => {
          while (queue.length) {
            const entry = queue.shift();
            try {
              await ensureLoaded(entry);
            } catch (error) {
              if (error instanceof SignedOutError) throw error;
            }
          }
        };
        await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
      })().finally(() => {
        prefetching = null;
      });
    }
    return prefetching;
  }

  // ---- Undo and the change log -------------------------------------------------

  function pushUndo(entry) {
    entry.undo.push({ working: entry.working, log: entry.log.map((item) => ({ ...item })) });
    if (entry.undo.length > UNDO_LIMIT) entry.undo.shift();
  }

  function recordText(entry, key, before, after) {
    const id = `${generation}:${key}`;
    let item = entry.log.find((candidate) => candidate.id === id);
    if (!item) {
      item = { id, key, label: blockName(entry.model, key), before, after };
      entry.log.push(item);
    } else {
      item.after = after;
    }
    if (item.after === item.before) entry.log = entry.log.filter((candidate) => candidate !== item);
  }

  function recordAction(entry, label, extra = {}) {
    entry.log.push({ id: `${generation}:action:${entry.log.length}`, label, before: null, after: null, ...extra });
  }

  // The part of a log made after `sent` (the log when Save was pressed): new
  // items, and a block changed again since, from the text that was saved.
  function unsavedLog(log, sent) {
    const saved = new Map(sent.map((item) => [item.id, item]));
    return log
      .filter((item) => !saved.has(item.id) || saved.get(item.id).after !== item.after)
      .map((item) => (saved.has(item.id) ? { ...item, before: saved.get(item.id).after } : item));
  }

  // Adding or removing a paragraph or list item shifts the keys after it, so
  // a key no longer names the same element in the file as loaded. The log
  // records it, and follows Undo, Save, Discard and reloads.
  const reshaped = (entry) => entry.log.some((item) => item.reshaped);

  function blockName(model, key) {
    const node = model.nodeOf.get(key);
    return node ? BLOCK_NAMES[node.tagName] || "Text" : "Text";
  }

  // Keys whose text differs from the file as loaded (for the gold tint).
  function changedKeys(entry) {
    if (!entry.model || !entry.originalModel || entry.model === entry.originalModel) return [];
    if (reshaped(entry) || entry.model.nodeOf.size !== entry.originalModel.nodeOf.size) {
      return entry.log.filter((item) => item.id.startsWith(`${generation}:`) && item.key).map((item) => item.key);
    }
    return entry.model.blocks
      .filter((block) => {
        const original = entry.originalModel.nodeOf.get(block.key);
        return !original || collapse(textOf(original)) !== blockText(entry.model, block.key);
      })
      .map((block) => block.key);
  }

  // ---- Editing -----------------------------------------------------------------

  function commitBlock(key, snapshot) {
    const entry = current();
    typing = false;
    clearTimeout(interimTimer);
    if (!entry || entry.kind !== "page" || entry.status !== "ready") return;
    const before = entry.model;
    try {
      const result = commitTextEdit(before, key, snapshot);
      if (!result.changed) {
        persist(entry); // replaces any interim copy of this block's typing
        renderTopbar();
        return;
      }
      // In draft mode a change to live text goes into a draft copy instead.
      let drafted = result.model;
      try {
        // A live element with a new version waiting stays as it is.
        refuseWaitingChange(before, result.model);
        if (draftMode) drafted = asDraft(before, result.model);
      } catch (error) {
        // Refused: the words typed are shown for copying.
        if (error instanceof EditRejectedError && !error.typedText) error.typedText = blockText(result.model, key);
        throw error;
      }
      pushUndo(entry);
      if (drafted !== result.model) {
        entry.model = drafted;
        entry.working = drafted.source;
        generation += 1;
        recordAction(entry, `Drafted a new version of a ${blockName(before, key).toLowerCase()}`, { reshaped: true });
        preview.render(entry.model);
        afterChange(entry);
        return;
      }
      entry.model = result.model;
      entry.working = result.model.source;
      if (result.restructured) generation += 1;
      recordText(entry, key, blockText(before, key), blockText(entry.model, key));
      preview.setModel(entry.model);
      if (result.restructured) preview.render(entry.model);
      afterChange(entry);
    } catch (error) {
      preview.render(entry.model);
      if (error instanceof EditRejectedError) showRejected(error);
      else toast(describeError(error, target), "error");
    }
  }

  function afterChange(entry) {
    persist(entry);
    renderFileList();
    renderTopbar();
    if (entry.kind === "page") preview.setChangedKeys(changedKeys(entry));
    renderPanel();
    preview.refreshToolbar();
  }

  // Runs a structural, draft or attribute change on the current page. In draft
  // mode a change to live content is kept as a draft copy (drafting "copy");
  // operations on drafts themselves pass drafting "none".
  async function applyOperation(label, operation, { reshapes = false, drafting = "copy", ...renderOptions } = {}) {
    preview.finishEditing();
    const entry = current();
    if (!entry || entry.kind !== "page" || entry.status !== "ready") return;
    let result;
    try {
      result = operation(entry.model);
      const made = result && result.model ? result.model : result;
      if (drafting === "copy" && made && made !== entry.model) refuseWaitingChange(entry.model, made);
      if (draftMode && drafting === "copy" && made && made !== entry.model) {
        const drafted = asDraft(entry.model, made);
        if (drafted !== made) {
          result = drafted;
          reshapes = true;
          label = `${label} (as a draft)`;
        }
      }
    } catch (error) {
      if (error instanceof EditRejectedError) toast(error.message, "error");
      else toast(describeError(error, target), "error");
      return;
    }
    const next = result && result.model ? result.model : result;
    if (!next || next === entry.model) return;
    pushUndo(entry);
    entry.model = next;
    entry.working = next.source;
    generation += 1;
    recordAction(entry, label, reshapes ? { reshaped: true } : {});
    selection = null;
    await preview.render(entry.model, { ...renderOptions, focusKey: result.key || renderOptions.focusKey || null });
    afterChange(entry);
  }

  function undo() {
    preview.finishEditing();
    const entry = current();
    if (!entry || !entry.undo.length) return;
    const previous = entry.undo.pop();
    entry.working = previous.working;
    entry.log = previous.log;
    generation += 1;
    if (entry.kind === "page") {
      entry.model = buildModel(entry, entry.working);
      preview.render(entry.model);
    } else {
      $("markdown-editor").value = entry.working;
    }
    afterChange(entry);
  }

  async function discardPage() {
    preview.finishEditing();
    const entry = current();
    if (!entry || !isDirty(entry)) return;
    const confirmed = await confirmAction($("confirm-dialog"), {
      title: "Discard this page's changes?",
      message: `Every unsaved change to ${entry.label} goes back to how it is on GitHub.`,
      confirm: "Discard changes",
      kind: "danger",
    });
    if (!confirmed) return;
    if (entry.isNew) {
      store.remove(entry.path);
      entries.delete(entry.path);
      renderFileList();
      await open(firstPagePath());
      return;
    }
    entry.working = entry.original;
    entry.model = entry.originalModel;
    entry.undo = [];
    entry.log = [];
    generation += 1;
    if (entry.kind === "page") await preview.render(entry.model);
    else $("markdown-editor").value = entry.working;
    afterChange(entry);
  }

  function revertBlock(key) {
    const entry = current();
    if (!entry || !canRevert(entry, key)) return;
    const original = entry.originalModel.nodeOf.get(key);
    const node = entry.model.nodeOf.get(key);
    if (!original || !node || original.tagName !== node.tagName) return;
    const from = original.sourceCodeLocation;
    const to = node.sourceCodeLocation;
    const originalInner = entry.original.slice(from.startTag.endOffset, from.endTag.startOffset);
    applyOperation(
      `Reverted a ${blockName(entry.model, key).toLowerCase()}`,
      (model) => buildModel(entry, model.source.slice(0, to.startTag.endOffset) + originalInner + model.source.slice(to.endTag.startOffset)),
      { drafting: "none" },
    );
  }

  const canRevert = (entry, key) =>
    entry.originalModel &&
    !reshaped(entry) &&
    entry.model.nodeOf.size === entry.originalModel.nodeOf.size &&
    entry.originalModel.nodeOf.has(key) &&
    collapse(textOf(entry.originalModel.nodeOf.get(key))) !== blockText(entry.model, key);

  async function runDraft(key) {
    const entry = current();
    const draft = entry.model.drafts.find((item) => item.key === key);
    if (!draft) return;
    // Still its placeholder: its text is that of a draft as loaded. Matched by
    // text, since adding or removing a paragraph above it shifts its key.
    const text = collapse(textOf(draft.node));
    const placeholder = entry.originalModel.drafts.some(
      (item) => item.kind === draft.kind && item.node.tagName === draft.node.tagName && collapse(textOf(item.node)) === text,
    );
    if (draft.kind !== "check" && placeholder) {
      const confirmed = await confirmAction($("confirm-dialog"), {
        title: "Still the placeholder",
        message: "This draft still has its placeholder text. Mark it done anyway?",
        confirm: "Mark done",
      });
      if (!confirmed) return;
    }
    await applyOperation(draft.kind === "check" ? "Approved a checked draft" : "Marked a draft done", (model) => completeDraft(model, key), {
      flashKey: draft.blockKey || null,
      drafting: "none",
    });
  }

  // ---- The editor's drafts ----------------------------------------------------------

  const DRAFT_NAMES = {
    new: { tag: "Draft", what: "a draft: not on thomaswhite.me until published", publish: "Publish draft", discard: "Discard draft" },
    replace: {
      tag: "New version",
      what: "a new version, waiting as a draft: the live one before it stays until this is published",
      publish: "Publish new version",
      discard: "Discard new version",
    },
    remove: { tag: "To remove", what: "marked to remove: it stays live until the removal is published", publish: "Remove now", discard: "Keep it" },
  };

  async function runPublishDraft(key) {
    const kind = attribute(current().model.nodeOf.get(key), "data-draft");
    // A new version whose live element changed since it was made waits: both are shown instead.
    if (kind === "replace" && liveChanged(current().model, key)) {
      await showLiveChanged(key);
      return;
    }
    const label = kind === "remove" ? "Removed content marked to remove" : kind === "replace" ? "Published a new version" : "Published a draft";
    await applyOperation(label, (model) => publishDraft(model, key), { reshapes: true, drafting: "none" });
  }

  async function runRecordLive(key) {
    await applyOperation("Recorded the live version as it is now", (model) => recordLive(model, key), { drafting: "none" });
  }

  // A new version (at `key`) whose live element has changed since it was made,
  // on main say: the live element as it was, as it is now, and the new
  // version, as word runs, so the change can be carried into the new version
  // by typing. Publishing waits until the live element is recorded as it is
  // now. The version as it was is looked up in the file's history on GitHub.
  async function showLiveChanged(key) {
    const entry = current();
    const draft = entry.model.nodeOf.get(key);
    const live = previousElementSibling(draft);
    const version = (node) => ({ text: collapse(textOf(node)), source: entry.model.source.slice(node.sourceCodeLocation.startOffset, node.sourceCodeLocation.endOffset) });
    const now = version(live);
    const mine = version(draft);
    const recorded = attribute(draft, "data-draft-of");
    const history = h("div", {}, h("p", { class: "small" }, "Looking up the live version as it was when this new version was made…"));
    const shown = openDialog($("save-dialog"), {
      title: "The live version has changed",
      body: h(
        "div",
        {},
        h("p", {}, "The live version before this new version has changed since the new version was made (in a Claude session, say). Publishing the new version now would undo that change, so it isn't published."),
        history,
        h("p", {}, "Carry the change into the new version by typing in it. Then record the live version as it is now, and publish."),
      ),
      actions: [
        { label: "Close", value: null },
        { label: "Record the live version as it is now", value: "record" },
      ],
    });
    (async () => {
      let was = null;
      try {
        if (recorded) was = await flow.searchHistory(entry.path, (text) => liveAsItWas(text, entry.path, recorded));
      } catch {
        was = null;
      }
      history.replaceChildren(
        ...(was
          ? [h("h3", {}, "What changed in the live version"), runsView(was, now), h("h3", {}, "Your new version, against the live version as it was"), runsView(was, mine)]
          : [
              h("p", { class: "small" }, "The live version as it was couldn't be found in the file's history."),
              h("h3", {}, "Your new version, against the live version now"),
              runsView(now, mine),
            ]),
      );
    })();
    if ((await shown) === "record") await runRecordLive(key);
  }

  // Word runs from one version of an element to another. When only markup
  // differs (a link's address, say), the sources are compared instead.
  function runsView(before, after) {
    const [a, b] = before.text === after.text ? [before.source, after.source] : [before.text, after.text];
    const runs = trimEqualRuns(wordDiff(a, b));
    return h("p", { class: "change-words" }, runs.map((run) => h("span", { class: `word word--${run.type}` }, `${run.text} `)));
  }

  async function runDiscardDraft(key) {
    const entry = current();
    const node = entry.model.nodeOf.get(key);
    const kind = attribute(node, "data-draft");
    if (kind !== "remove") {
      const confirmed = await confirmAction($("confirm-dialog"), {
        title: "Discard this draft?",
        message: `“${snippet(textOf(node), 120)}” will be deleted${kind === "replace" ? "; the live version stays as it is" : ""}. Undo brings it back.`,
        confirm: "Discard draft",
        kind: "danger",
      });
      if (!confirmed) return;
    }
    await applyOperation(kind === "remove" ? "Kept content marked to remove" : "Discarded a draft", (model) => discardDraft(model, key), {
      reshapes: true,
      drafting: "none",
    });
  }

  // Takes a block, or its section, off the live site until published again.
  async function runMakeDraft(key, what) {
    await applyOperation(`Made a ${what} a draft`, (model) => (what === "section" ? markDraft(model, key, "new") : makeDraft(model, key)), { drafting: "none" });
  }

  // The words last selected in the block being edited, as a draft phrase.
  // `key` is the block whose panel offered it: words selected in another block
  // (or before a click elsewhere) are not what is meant.
  async function runDraftPhrase(kind, key) {
    const words = preview.lastSelection();
    if (!words || words.key !== key) {
      toast("Select some words in this block first, then choose this.", "warning");
      return;
    }
    await applyOperation(
      kind === "new" ? "Kept words off the live site (as a draft)" : "Marked words to remove (as a draft)",
      (model) => draftPhrase(model, words.key, words.start, words.end, kind),
      { reshapes: true, drafting: "none" },
    );
  }

  async function runAddAfter(key) {
    const entry = current();
    const what = entry.model.nodeOf.get(key).tagName === "li" ? "list item" : "paragraph";
    // In draft mode a new item starts as a draft: off the live site until
    // published. It needs its own marker unless a draft is around the block:
    // after a block that is itself a draft, it lands outside that draft.
    const node = entry.model.nodeOf.get(key);
    const around = draftAround(entry.model, node);
    const asDraftItem = draftMode && (!around || around.node === node);
    const add = (model) => {
      const added = addAfter(model, key);
      return asDraftItem ? { model: markDraft(added.model, added.key, "new"), key: added.key } : added;
    };
    await applyOperation(asDraftItem ? `Added a ${what} (as a draft)` : `Added a ${what}`, add, { selectAll: true, reshapes: true, drafting: "none" });
  }

  async function runRemove(key) {
    const entry = current();
    const info = removalInfo(entry.model, key);
    const what = info.tag === "li" ? "list item" : "paragraph";
    // In draft mode it stays live, marked to go when the draft is published.
    if (draftMode && !draftAround(entry.model, entry.model.nodeOf.get(key))) {
      await applyOperation(`Marked a ${what} to remove (as a draft)`, (model) => markDraft(model, key, "remove"), { drafting: "none" });
      return;
    }
    const confirmed = await confirmAction($("confirm-dialog"), {
      title: `Remove this ${what}?`,
      message: info.lastItem
        ? "It's the list's only item, so the list will be left empty. Undo brings it back."
        : `“${blockText(entry.model, key).slice(0, 120)}” will be removed. Undo brings it back.`,
      confirm: `Remove ${what}`,
      kind: "danger",
    });
    if (confirmed) await applyOperation(`Removed a ${what}`, (model) => removeBlock(model, key), { reshapes: true, drafting: "none" });
  }

  // "Done" alone is ambiguous when a paragraph holds several inline drafts,
  // so an inline one is named by its first words.
  function draftLabel(draft, blockKey) {
    if (draft.kind === "check") return draft.key === blockKey ? "Approve" : `Approve “${snippet(textOf(draft.node), 18)}”`;
    return draft.key === blockKey ? "Done" : `Done: “${snippet(textOf(draft.node), 18)}”`;
  }

  function toolbarActions(key) {
    const entry = current();
    if (!entry || !entry.model || entry.model.readOnly) return [];
    const block = entry.model.blockByKey.get(key);
    if (!block || block.lock) return [];
    const actions = [];
    // The editor's own draft this block is in (itself or around it).
    const around = draftAround(entry.model, block.node);
    if (around && EDITOR_DRAFT_KINDS.has(around.kind)) {
      const draftKey = entry.model.keyOf.get(around.node);
      const names = DRAFT_NAMES[around.kind];
      actions.push({ label: names.publish, title: `This is ${names.what}.`, kind: "draft", run: () => runPublishDraft(draftKey) });
      actions.push({ label: names.discard, title: names.discard, kind: around.kind === "remove" ? "" : "danger", run: () => runDiscardDraft(draftKey) });
    }
    // Phrases in it kept as drafts.
    for (const draft of entry.model.drafts.filter((item) => EDITOR_DRAFT_KINDS.has(item.kind) && item.blockKey === key && item.key !== key && (!around || item.node !== around.node))) {
      actions.push({
        label: `${DRAFT_NAMES[draft.kind].publish}: “${snippet(textOf(draft.node), 14)}”`,
        title: `${DRAFT_NAMES[draft.kind].publish}: ${snippet(textOf(draft.node), 120)}`,
        kind: "draft",
        run: () => runPublishDraft(draft.key),
      });
    }
    for (const draft of entry.model.drafts.filter((item) => !EDITOR_DRAFT_KINDS.has(item.kind) && (item.key === key || item.blockKey === key))) {
      actions.push({
        label: draftLabel(draft, key),
        title: `${draft.kind === "check" ? "Approve" : "Mark done"}: ${snippet(textOf(draft.node), 120)}`,
        kind: "draft",
        run: () => runDraft(draft.key),
      });
    }
    if (block.structuralKey) {
      const what = entry.model.nodeOf.get(block.structuralKey).tagName === "li" ? "list item" : "paragraph";
      actions.push({ label: "+", title: `Add a ${what} after this`, run: () => runAddAfter(block.structuralKey) });
      actions.push({ label: "×", title: `Remove this ${what}`, kind: "danger", run: () => runRemove(block.structuralKey) });
    }
    return actions;
  }

  // ---- Opening files -------------------------------------------------------------

  const firstPagePath = () => (entries.has("index.html") ? "index.html" : pageEntries()[0]?.path);

  async function open(path) {
    if (!entries.has(path)) path = firstPagePath();
    if (!path) return;
    preview.finishEditing();
    syncMarkdown();
    currentPath = path;
    selection = null;
    preview.clearSelection();
    try {
      sessionStorage.setItem("siteEditor.currentPage", path);
    } catch {
      // Storage unavailable.
    }
    closeSidebar();
    const entry = entries.get(path);
    renderFileList();
    renderStageBar();
    if (entry.status === "gone") {
      // Its edited text, to copy from; nothing here can be saved.
      $("frame-wrap").hidden = true;
      const editor = $("markdown-editor");
      editor.hidden = false;
      editor.value = entry.working;
      editor.readOnly = true;
      stageMessage("No longer on GitHub: your edited text, to copy from. It can't be saved here.", "warning");
      renderPanel();
      renderTopbar();
      return;
    }
    if (entry.status !== "ready") {
      stageMessage(`Loading ${entry.label}…`);
      $("frame-wrap").hidden = true;
      $("markdown-editor").hidden = true;
      await ensureLoaded(entry);
      if (currentPath !== path) return;
    }
    renderStageBar();
    if (entry.status === "error") {
      stageMessage(describeError(entry.error, target), "error");
      renderPanel();
      return;
    }
    stageMessage("");
    if (entry.kind === "page") {
      $("markdown-editor").hidden = true;
      $("frame-wrap").hidden = false;
      await preview.render(entry.model, { keepScroll: false });
      preview.setChangedKeys(changedKeys(entry));
    } else {
      $("frame-wrap").hidden = true;
      const editor = $("markdown-editor");
      editor.hidden = false;
      editor.value = entry.working;
      editor.readOnly = false;
    }
    renderPanel();
    renderTopbar();
  }

  // The Markdown box into its file, and into sessionStorage at once: typing
  // otherwise reaches it only after a pause (the box's input handler).
  let markdownTimer = null;
  function syncMarkdown() {
    const entry = current();
    if (!entry || entry.kind !== "markdown" || entry.status !== "ready") return;
    const value = $("markdown-editor").value;
    if (value !== entry.working) {
      pushUndo(entry);
      entry.working = value;
    }
    clearTimeout(markdownTimer);
    persist(entry);
  }

  // ---- Checks and Save -------------------------------------------------------------

  function checkContext() {
    const pages = pageEntries()
      .filter((entry) => entry.status === "ready" && entry.model)
      .map((entry) => ({ permalink: entry.model.permalink, ids: entry.model.ids, externalRedirect: isExternalRedirect(entry.model) }));
    const files = [...flow.state.files.keys(), ...[...entries.values()].filter((entry) => entry.isNew).map((entry) => entry.path)];
    return siteContext({ pages, files });
  }

  function recordSlugsNow() {
    const record = entries.get(target.markdown.record);
    return record && record.status === "ready" ? recordSlugs(record.working) : null;
  }

  async function startSave() {
    preview.finishEditing();
    syncMarkdown();
    typing = false;
    const dirty = dirtyEntries();
    renderTopbar();
    if (!dirty.length || flow.state.busy) return;
    setStatus("Checking the site before saving…");
    // The site-wide checks need every page and the record. A file that failed
    // to load for a passing reason (GitHub, the network) gets one retry, then
    // blocks the save; one that can't be parsed is reported in the dialog.
    const transient = (entry) => entry.status === "error" && (entry.error instanceof GitHubError || entry.error instanceof AuthNetworkError);
    try {
      await prefetchAll();
      const retry = [...entries.values()].filter(transient);
      for (const entry of retry) Object.assign(entry, { status: "unloaded", error: null });
      if (retry.length) await prefetchAll();
    } catch (error) {
      if (error instanceof SignedOutError) onSignedOut(error.message);
      else toast(describeError(error, target), "error");
      renderTopbar();
      return;
    }
    const unavailable = [...entries.values()].filter(transient);
    if (unavailable.length) {
      toast(`Couldn't load ${unavailable.map((entry) => entry.label).join(", ")} from GitHub, so the site-wide checks can't run. Try Save again in a moment.`, "error");
      renderTopbar();
      return;
    }
    const unreadable = [...entries.values()].filter((entry) => entry.status === "error");
    const context = checkContext();
    const emptyFile = {
      level: "block",
      code: "empty-file",
      message: "This file is empty. Write something, or discard the changes.",
      key: null,
      line: null,
    };
    const results = dirty.map((entry) => ({
      entry,
      findings:
        entry.kind === "page"
          ? checkPage(entry.model, entry.originalModel, context)
          : entry.working.trim()
            ? []
            : [emptyFile],
    }));
    const siteFindings = checkSite(
      pageEntries().filter((entry) => entry.status === "ready").map((entry) => entry.model),
      { slugs: recordSlugsNow() },
    );
    for (const entry of unreadable) {
      siteFindings.push({
        level: "warn",
        code: "unreadable",
        message: `${entry.path} couldn't be read (${describeError(entry.error, target)}), so it isn't in the site-wide checks.`,
        key: null,
        line: null,
      });
    }
    const blocking = [...results.flatMap((result) => result.findings), ...siteFindings].filter((finding) => finding.level === "block");
    renderTopbar();
    const described = describeEntries(dirty);
    const message = messageFields({
      kind: "commit",
      title: summarise(described),
      body: bodyText(described),
      changes: forAi(described),
      titleLabel: "Commit message",
      bodyLabel: "Details",
    });
    const choice = await openDialog($("save-dialog"), {
      title: "Save to GitHub",
      body: (close) => saveDialogBody(results, siteFindings, close, message.element),
      actions: [
        { label: "Cancel", value: null },
        { label: `Save ${dirty.length} ${dirty.length === 1 ? "file" : "files"}`, value: "save", kind: "primary", disabled: blocking.length > 0 },
      ],
    });
    if (choice === "save") await doSave(dirty, message.read());
    else if (choice && typeof choice === "object") await choice.run();
  }

  // What changed in each file since it was loaded, for commit messages.
  function describeEntries(list) {
    return list.map((entry) =>
      describeFile({
        path: entry.path,
        label: entry.kind === "page" ? entry.label : null,
        before: entry.isNew ? null : entry.original || "",
        after: entry.kind === "markdown" ? normaliseMarkdown(entry.working) : entry.working,
        beforeModel: entry.kind === "page" ? entry.originalModel : null,
        afterModel: entry.kind === "page" ? entry.model : null,
      }),
    );
  }

  const commitText = ({ title, body }) => (body ? `${title}\n\n${body}\n` : `${title}\n`);

  // Editable words for a commit or a pull request: a one-line title and a
  // longer text, prefilled with what the editor generated. "Suggest with AI"
  // asks the Worker (Groq) and puts its answer in the fields, to check and edit
  // before use. `changes` is describe.js's forAi(): no private file content.
  function messageFields({ kind, title, body, changes, titleLabel, bodyLabel, bodyHint = null }) {
    const titleInput = h("input", { type: "text", class: "text-input message-title", maxlength: "120", spellcheck: "true" });
    titleInput.value = title;
    const bodyInput = h("textarea", { class: "text-input message-body", rows: kind === "commit" ? "5" : "3", spellcheck: "true", placeholder: bodyHint });
    bodyInput.value = body;
    const status = h("p", { class: "small message-status", role: "status" });
    const parts = [
      h("div", { class: "field" }, h("label", { class: "field-label" }, titleLabel, titleInput)),
      h("div", { class: "field" }, h("label", { class: "field-label" }, bodyLabel, bodyInput)),
    ];
    if (suggest && changes.length) {
      const ask = button(
        "Suggest with AI",
        async () => {
          ask.disabled = true;
          status.textContent = "Asking Groq…";
          try {
            const result = await suggest(kind, changes);
            titleInput.value = result.title;
            bodyInput.value = result.body;
            status.textContent = "Suggested by AI (Groq, through the editor's Worker). Check it before you use it.";
          } catch (error) {
            if (error instanceof SignedOutError) onSignedOut(error.message);
            status.textContent = error.message || "The suggestion failed.";
          } finally {
            ask.disabled = false;
          }
        },
        { small: true },
      );
      parts.push(
        h(
          "div",
          { class: "button-row message-actions" },
          ask,
          h("span", { class: "small" }, "Sends the page changes to Groq; the Record and blog sources only as a count."),
        ),
      );
    }
    parts.push(status);
    return {
      element: h("section", { class: "message-fields" }, parts),
      read: () => ({ title: titleInput.value.trim() || title, body: bodyInput.value.trim() }),
    };
  }

  function findingItem(finding, entry, close) {
    const actions = [];
    if (entry && finding.key !== null && finding.key !== undefined) {
      actions.push(button("Go to", () => close({ run: () => goTo(entry.path, finding.key) }), { small: true, kind: "quiet" }));
    }
    const fix = fixFor(finding, entry);
    if (fix) actions.push(button(fix.label, () => close({ run: async () => { await fix.run(); await startSave(); } }), { small: true }));
    return h(
      "li",
      { class: `finding finding--${finding.level}` },
      h("span", { class: "finding-level" }, finding.level === "block" ? "Must fix" : "Check"),
      h("span", { class: "finding-message" }, finding.message, finding.line ? h("span", { class: "small" }, ` (line ${finding.line})`) : null),
      actions.length ? h("span", { class: "finding-actions" }, actions) : null,
    );
  }

  function fixFor(finding, entry) {
    if (!entry || entry.kind !== "page") return null;
    const run = (label, operation) => ({ label, run: async () => { await open(entry.path); await applyOperation(label, operation); } });
    if (finding.fix === "now") {
      const month = thisMonth();
      return run(`Set Updated to ${updatedLabel(month).replace("Updated ", "")}`, (model) => setNowUpdated(model, month));
    }
    if (finding.fix === "new-tab") return run("Open in a new tab", (model) => openInNewTab(model, finding.key));
    if (finding.fix === "same-tab") return run("Open in the same tab", (model) => openInSameTab(model, finding.key));
    if (finding.fix === "absolute") {
      return run(`Use ${finding.value}`, (model) => setAttribute(model, finding.key, "href", finding.value));
    }
    if (finding.fix === "gallery-caption") {
      return run("Copy the caption", (model) => {
        const image = model.images.find((item) => item.gallery && item.gallery.buttonKey === finding.key);
        if (!image || !image.gallery.captionKey) return model;
        const caption = collapse(textOf(model.nodeOf.get(image.gallery.captionKey)));
        return setAttribute(model, finding.key, "data-caption", caption);
      });
    }
    if (finding.fix === "curl-quotes") return { label: "Curl the quotes", run: () => curlChangedQuotes(entry) };
    return null;
  }

  // Curls straight quotes in the blocks that changed. Text edits keep every
  // key, so the keys collected first stay valid as each block is committed.
  async function curlChangedQuotes(entry) {
    await open(entry.path);
    const lines = changedLines(entry.original, entry.working);
    const keys = entry.model.blocks
      .filter((block) => {
        const { startLine, endLine } = block.node.sourceCodeLocation;
        for (let line = startLine; line <= endLine; line += 1) if (lines.has(line)) return /['"]/.test(textOf(block.node));
        return false;
      })
      .map((block) => block.key);
    let model = entry.model;
    for (const key of keys) model = commitTextEdit(model, key, curledSnapshot(model, model.nodeOf.get(key))).model;
    if (model !== entry.model) await applyOperation("Curled quotes", () => model);
  }

  // A block's snapshot with its text nodes' quotes curled.
  function curledSnapshot(model, node) {
    const visit = (item) => {
      if (item.nodeName === "#text") return { type: "text", text: curlQuotes(item.value) };
      return {
        type: "element",
        key: model.keyOf.get(item) ?? null,
        tag: item.tagName,
        attrs: [],
        children: (item.childNodes || []).map(visit).filter(Boolean),
      };
    };
    return visit(node);
  }

  function saveDialogBody(results, siteFindings, close, messageElement) {
    const sections = [];
    const siteBlocking = siteFindings.filter((finding) => finding.level === "block");
    if (siteFindings.length) {
      sections.push(
        h("section", { class: "save-file" }, h("h3", {}, "Across the site"), h("ul", { class: "finding-list" }, siteFindings.map((finding) => findingItem(finding, entries.get(finding.path), close)))),
      );
    }
    const baseline = results.some(({ entry }) => target.visualBaselinePages.includes(entry.path));
    for (const { entry, findings } of results) {
      const text = entry.kind === "markdown" ? normaliseMarkdown(entry.working) : entry.working;
      const counts = countLineChanges(entry.original || "", text);
      sections.push(
        h(
          "section",
          { class: "save-file" },
          h("h3", {}, entry.label, " ", h("span", { class: "small" }, `${entry.path} · +${counts.added} −${counts.removed} lines${entry.isNew ? " · new file" : ""}`)),
          findings.length ? h("ul", { class: "finding-list" }, findings.map((finding) => findingItem(finding, entry, close))) : null,
          entry.log.length ? h("ul", { class: "change-list" }, entry.log.map((item) => changeItem(item))) : null,
          h("details", { class: "hunks" }, h("summary", {}, "The lines that change"), hunksView(entry.original || "", text)),
        ),
      );
    }
    const notes = [];
    if (baseline) notes.push("The homepage, Programming or Gallery changed: Publish refreshes their screenshot baselines on GitHub first.");
    if (flow.state.pr) notes.push("The pull request is open, so its checks run again on this save (about 19 minutes of Windows Actions time).");
    else notes.push("Saving commits to the edits branch only. Nothing runs on GitHub until you publish.");
    if (siteBlocking.length || results.some((result) => result.findings.some((finding) => finding.level === "block"))) {
      notes.unshift("Fix the items marked “Must fix” first: the site's own checks would fail on them.");
    }
    return h("div", { class: "save-body" }, notes.map((note) => h("p", { class: "notice" }, note)), messageElement, sections);
  }

  function changeItem(item) {
    if (item.before === null) return h("li", { class: "change" }, h("span", { class: "change-label" }, item.label));
    const runs = trimEqualRuns(wordDiff(item.before, item.after));
    return h(
      "li",
      { class: "change" },
      h("span", { class: "change-label" }, item.label),
      h("span", { class: "change-words" }, runs.map((run) => h("span", { class: `word word--${run.type}` }, `${run.text} `))),
    );
  }

  function hunksView(before, after) {
    const hunks = lineHunks(before, after, 2);
    if (!hunks.length) return h("p", { class: "small" }, "No line changes.");
    return h(
      "div",
      { class: "hunk-list" },
      hunks.map((hunk) =>
        h(
          "pre",
          { class: "hunk" },
          h("span", { class: "hunk-header" }, `@@ line ${hunk.newStart} @@\n`),
          hunk.rows.map((row) => h("span", { class: `hunk-row hunk-row--${row.type === "+" ? "add" : row.type === "-" ? "remove" : "same"}` }, `${row.type} ${row.text}\n`)),
        ),
      ),
    );
  }

  // `message` is { title, body } from the Save dialog; without one (saving the
  // other files after a conflict) the generated message is used.
  //
  // Typing goes on while GitHub answers. Each file keeps what it held when
  // Save was pressed (`working`, `model`, the log and the undo steps then), so
  // a file changed meanwhile keeps those changes, unsaved, on top of the text
  // that was saved.
  async function doSave(dirty, message = null) {
    const changes = dirty.map((entry) => ({
      entry,
      path: entry.path,
      text: entry.kind === "markdown" ? normaliseMarkdown(entry.working) : entry.working,
      loadedSha: entry.isNew ? null : entry.loadedSha,
      working: entry.working,
      model: entry.model,
      log: entry.log.map((item) => ({ ...item })),
      undo: new Set(entry.undo),
    }));
    try {
      const { files } = await flow.save(
        changes.map(({ path, text, loadedSha }) => ({ path, text, loadedSha })),
        message ? commitText(message) : commitMessageFor(describeEntries(dirty)),
      );
      for (const change of changes) {
        const { entry, text } = change;
        entry.loadedSha = files.get(entry.path);
        entry.original = text;
        entry.isNew = false;
        if (entry.working === change.working) {
          entry.working = text;
          if (entry.kind === "page") entry.originalModel = entry.model;
          entry.undo = [];
          entry.log = [];
        } else {
          if (entry.kind === "page") entry.originalModel = change.model;
          entry.undo = entry.undo.filter((step) => !change.undo.has(step)).map((step) => ({ ...step, log: unsavedLog(step.log, change.log) }));
          entry.log = unsavedLog(entry.log, change.log);
        }
        persist(entry);
      }
      generation += 1;
      toast(flow.state.notice || "Saved.", "success");
      const entry = current();
      if (entry && entry.kind === "page") preview.setChangedKeys(changedKeys(entry));
      // The box is reset to the text saved only if nothing was typed in it since.
      const saved = changes.find((change) => change.entry === entry);
      if (entry && entry.kind === "markdown" && saved && $("markdown-editor").value === saved.working) $("markdown-editor").value = entry.working;
      renderFileList();
      renderPanel();
      renderTopbar();
    } catch (error) {
      if (error instanceof SaveConflictError) await resolveConflict(error, dirty);
      else if (error instanceof SignedOutError) onSignedOut(error.message);
      else toast(describeError(error, target), "error");
    }
  }

  async function resolveConflict(error, dirty) {
    const gone = error.gone || [];
    const changed = error.conflicts.filter((path) => !gone.includes(path));
    const choice = await openDialog($("confirm-dialog"), {
      title: "Changed on GitHub",
      body: h(
        "div",
        {},
        changed.length ? h("p", {}, `${changed.join(", ")} changed on GitHub since this tab loaded ${changed.length === 1 ? "it" : "them"} (another device, or a Claude session).`) : null,
        gone.length
          ? h("p", {}, `${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} no longer on GitHub: renamed or deleted there (in a Claude session, say). The editor won't recreate ${gone.length === 1 ? "it" : "them"}.`)
          : null,
        h("p", {}, "Reload loads GitHub's version of those files and keeps your unsaved edits to them aside, to copy from. Your other files keep their edits."),
        gone.length ? h("p", {}, "Edits to a file no longer on GitHub are listed under “No longer on GitHub” until you discard them.") : null,
      ),
      actions: [
        { label: "Cancel", value: null },
        dirty.length > error.conflicts.length ? { label: "Save the other files", value: "others" } : null,
        { label: "Reload those files", value: "reload", kind: "primary" },
      ].filter(Boolean),
    });
    if (choice === "reload") {
      // Their stored records name the old blob, so the reload sets them aside.
      await reload();
    } else if (choice === "others") {
      await doSave(dirty.filter((entry) => !error.conflicts.includes(entry.path)));
    }
  }

  // ---- Publish -----------------------------------------------------------------------

  async function openPublish() {
    preview.finishEditing();
    syncMarkdown();
    if (dirtyEntries().length) {
      toast("Save your changes before publishing.", "warning");
      return;
    }
    publishDialogOpen = true;
    publishFields = null;
    describingBranch = flow.state.onBranch && flow.state.phase !== "published";
    renderPublishDialog();
    if (describingBranch) prepareDescription();
    const dialog = $("publish-dialog");
    dialog.oncancel = () => {
      publishDialogOpen = false;
    };
    dialog.onclose = () => {
      publishDialogOpen = false;
    };
    if (!dialog.open) dialog.showModal();
    if (flow.state.pr && !flow.state.busy) runFlow(() => flow.refreshChecks());
  }

  // The title and description fields, from the branch's changes: the generated
  // title (or the open pull request's title and your note in it). Publish
  // still works without them, with the generated title.
  async function prepareDescription() {
    const opening = (publishOpenings += 1);
    let fields = null;
    try {
      const described = await flow.describeBranch();
      const pr = flow.state.pr;
      const opened = { title: pr && pr.title ? pr.title : described.title, note: pr ? noteOf(pr.body) : "" };
      fields = {
        ...messageFields({
          kind: "pr",
          title: opened.title,
          body: opened.note,
          changes: forAi(described.files),
          titleLabel: "Pull request title",
          bodyLabel: "Description",
          bodyHint: "Optional: a note above the list of changes, which the editor adds and keeps up to date on each save.",
        }),
        opened,
      };
    } catch {
      fields = null;
    }
    if (opening !== publishOpenings) return;
    publishFields = fields;
    describingBranch = false;
    if (publishDialogOpen) renderPublishDialog();
  }

  // What was changed in the title and note since the dialog opened; null for
  // the rest, which stays as it is on GitHub (changed there meanwhile, say).
  const publishWords = () => {
    if (!publishFields) return {};
    const words = publishFields.read();
    const { opened } = publishFields;
    return { title: words.title !== opened.title.trim() ? words.title : null, note: words.body !== opened.note.trim() ? words.body : null };
  };

  // Bringing main in changes files on edits: it needs everything saved, and
  // reloads the files from the merged branch once GitHub has made the merge.
  async function updateFromMain() {
    preview.finishEditing();
    syncMarkdown();
    if (dirtyEntries().length) {
      toast("Save your changes before updating from main.", "warning");
      return;
    }
    await runFlow(async () => {
      await flow.updateFromMain();
      const brought = flow.state.notice;
      // Only once the pages hold main's changes: a failed reload has said why.
      if ((await reload()) && brought) toast(brought, "success");
    });
  }

  // Runs a flow action, then follows where it left the repository: after a
  // merge (here or on GitHub) wait for the deployment and reload; after the
  // pull request was closed on GitHub, reload.
  async function runFlow(action) {
    const hadPr = Boolean(flow.state.pr);
    try {
      await action();
      if (flow.state.phase === "published") await afterPublish();
      else if (hadPr && !flow.state.pr) await reload();
    } catch (error) {
      if (error instanceof SignedOutError) onSignedOut(error.message);
      else toast(describeError(error, target), "error");
    } finally {
      if (publishDialogOpen) renderPublishDialog();
    }
  }

  let followingPublish = null;
  function afterPublish() {
    if (!followingPublish) {
      followingPublish = (async () => {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, attempt ? DEPLOY_POLL_MS : 2_000));
          const deploy = await flow.refreshDeploy().catch(() => null);
          if (deploy && deploy.status === "completed") break;
        }
        await reload();
      })().finally(() => {
        followingPublish = null;
      });
    }
    return followingPublish;
  }

  function renderPublishDialog() {
    const dialog = $("publish-dialog");
    const state = flow.state;
    const pr = state.pr;
    const captured = state.changedPaths.some((path) => target.visualBaselinePages.includes(path));
    const stepState = (done, active) => (done ? "done" : active ? "active" : "todo");
    const icons = { passed: "✓", failed: "✗", running: "…", waiting: "·" };
    const steps = [];
    if (captured) {
      const run = state.baselineRun;
      steps.push(
        h(
          "li",
          { class: `step step--${stepState(Boolean(run && run.status === "completed"), state.phase === "baselines")}` },
          h("span", { class: "step-title" }, "Screenshot baselines"),
          h("span", { class: "small" }, run ? `${run.status}${run.conclusion ? `: ${run.conclusion}` : ""}` : "Updated before the pull request opens (about four minutes)."),
          run && run.url ? externalLink(run.url, "Run on GitHub") : null,
          state.changedImages.length ? h("ul", { class: "small" }, state.changedImages.map((image) => h("li", {}, image.url ? externalLink(image.url, image.path.split("/").pop()) : image.path))) : null,
        ),
      );
    }
    steps.push(
      h(
        "li",
        { class: `step step--${stepState(Boolean(pr) || state.phase === "published", state.phase === "opening-pr")}` },
        h("span", { class: "step-title" }, "Pull request"),
        pr ? externalLink(pr.html_url || `https://github.com/${target.owner}/${target.repo}/pull/${pr.number}`, `#${pr.number} ${pr.title || ""}`) : h("span", { class: "small" }, "Opens with the changes on edits."),
      ),
    );
    steps.push(
      h(
        "li",
        { class: `step step--${stepState(state.phase === "publishable" || state.phase === "published", state.phase === "checking")}` },
        h("span", { class: "step-title" }, "Checks"),
        state.checks.length
          ? h("ul", { class: "check-list" }, state.checks.map((check) => h("li", { class: `check check--${check.state}` }, h("span", { class: "check-icon", "aria-hidden": "true" }, icons[check.state]), check.url ? externalLink(check.url, check.name) : check.name, h("span", { class: "small" }, ` ${check.state}`))))
          : h("span", { class: "small" }, pr ? "Waiting for GitHub Actions to start." : "Run on the pull request (about fifteen minutes)."),
      ),
    );
    steps.push(
      h(
        "li",
        { class: `step step--${stepState(state.phase === "published", state.phase === "publishing")}` },
        h("span", { class: "step-title" }, "Merge and publish"),
        h("span", { class: "small" }, state.phase === "published" ? state.notice : `A merge commit into main, then ${new URL(target.assets).host} updates in about a minute.`),
        state.deploy ? h("span", { class: "small" }, ` Deploy: ${state.deploy.status}${state.deploy.conclusion ? ` (${state.deploy.conclusion})` : ""}.`) : null,
      ),
    );

    const busy = state.busy;
    const actions = [button("Close", () => dialog.close(), { kind: "quiet" })];
    if (!pr && state.phase !== "published") {
      actions.push(button("Publish", () => runFlow(() => flow.publish(publishWords())), { kind: "primary", disabled: busy || state.aheadBy === 0 }));
    }
    if (pr && publishFields) {
      actions.push(button("Update title and description", () => runFlow(() => flow.updatePullRequest(publishWords())), { disabled: busy }));
    }
    if (pr) actions.push(button("Refresh", () => runFlow(() => flow.refreshChecks()), { disabled: busy }));
    if (state.onBranch && state.behindBy > 0) actions.push(button("Update from main", updateFromMain, { disabled: busy }));
    if (state.canRefreshScreenshots) actions.push(button("Refresh screenshots", () => runFlow(() => flow.refreshScreenshots()), { disabled: busy }));
    if (pr && state.canStartChecks && state.phase === "checking") actions.push(button("Start checks", () => runFlow(() => flow.startChecks()), { disabled: busy }));
    if (pr) actions.push(button("Merge", () => runFlow(() => flow.merge()), { kind: "primary", disabled: busy || state.phase !== "publishable" }));

    const summary = state.changedPaths.length
      ? h("p", {}, `${state.changedPaths.length} ${state.changedPaths.length === 1 ? "file differs" : "files differ"} from main: `, state.changedPaths.map((path, index) => [index ? ", " : "", h("code", {}, path)]))
      : h("p", {}, state.phase === "published" ? "" : "The edits branch matches main: nothing to publish.");
    const words =
      state.phase === "published"
        ? null
        : publishFields
          ? publishFields.element
          : describingBranch
            ? h("p", { class: "small" }, "Describing the changes…")
            : null;
    // Re-rendering detaches the fields: keep the caret where it was.
    const active = document.activeElement;
    const typing =
      publishFields && active && publishFields.element.contains(active) && "selectionStart" in active
        ? { element: active, start: active.selectionStart, end: active.selectionEnd }
        : null;
    dialog.setAttribute("aria-labelledby", "publish-dialog-title");
    dialog.replaceChildren(
      h(
        "div",
        { class: "dialog-inner" },
        h(
          "header",
          { class: "dialog-header" },
          h("h2", { id: "publish-dialog-title", class: "dialog-title" }, "Publish"),
          h("button", { type: "button", class: "button button--quiet dialog-close", "aria-label": "Close", onClick: () => dialog.close() }, "×"),
        ),
        h(
          "div",
          { class: "dialog-body" },
          summary,
          state.onBranch && state.behindBy > 0
            ? h(
                "p",
                { class: "small" },
                `main has ${state.behindBy} newer ${state.behindBy === 1 ? "commit" : "commits"} than your saved edits. Update from main brings ${state.behindBy === 1 ? "it" : "them"} in${pr ? ", and the checks run again" : ""}.`,
              )
            : null,
          state.notice ? h("p", { class: `notice${state.phase === "attention" ? " notice--warning" : ""}`, role: "status" }, state.notice) : null,
          state.error ? h("p", { class: "notice notice--error", role: "alert" }, describeError(state.error, target)) : null,
          words,
          h("ol", { class: "steps" }, steps),
          h("p", { class: "small" }, "Each publish runs the site's checks on the pull request and again on main after the merge: about 40 minutes of Windows Actions time, plus about 4 when screenshots are refreshed."),
        ),
        h("footer", { class: "dialog-actions" }, actions),
      ),
    );
    if (typing && typing.element.isConnected) {
      typing.element.focus();
      typing.element.setSelectionRange(typing.start, typing.end);
    }
  }

  // ---- Reload ------------------------------------------------------------------------

  // Unsaved work: a block being typed in (its words reach sessionStorage a
  // moment later), and what sessionStorage holds (kept-aside edits, new files).
  // With none, main's newer changes can be brought into saved edits before the
  // pages load.
  const nothingUnsaved = () => !typing && store.paths().length === 0 && !dirtyEntries().length;

  // True once the files are reloaded; a failure is reported and false returned.
  // The block being typed in, and the Markdown box, are finished first, so
  // every word reaches the file it was typed in, and is kept aside with it if
  // that file changed on GitHub.
  async function reload() {
    preview.finishEditing();
    syncMarkdown();
    try {
      const { files } = await flow.load({ autoUpdate: nothingUnsaved() });
      syncEntries(files);
      renderFileList();
      await open(currentPath && entries.has(currentPath) ? currentPath : firstPagePath());
      prefetchAll().catch(() => {});
      return true;
    } catch (error) {
      if (error instanceof SignedOutError) onSignedOut(error.message);
      else toast(describeError(error, target), "error");
      return false;
    }
  }

  // A background refresh: quiet about passing failures, but it follows a pull
  // request merged or closed on GitHub, like runFlow.
  async function followRefresh() {
    if (flow.state.busy || !flow.state.pr) return;
    const hadPr = Boolean(flow.state.pr);
    try {
      await flow.refreshChecks();
    } catch (error) {
      if (error instanceof SignedOutError) onSignedOut(error.message);
      return;
    }
    if (flow.state.phase === "published") await afterPublish();
    else if (hadPr && !flow.state.pr) await reload();
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") followRefresh();
    }, POLL_MS);
  }

  // ---- Drawing -----------------------------------------------------------------------

  function setStatus(text) {
    $("status-line").textContent = text;
  }

  function stageMessage(text, tone = "info") {
    const box = $("stage-message");
    box.replaceChildren();
    if (text) box.append(h("p", { class: tone === "info" ? "notice" : `notice notice--${tone}` }, text));
  }

  let toastTimer = null;
  function toast(text, tone = "info") {
    let element = $("toast");
    if (!element) {
      element = h("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" });
      document.body.append(element);
    }
    element.className = `toast toast--${tone}`;
    element.textContent = text;
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      element.hidden = true;
    }, tone === "error" ? 12_000 : 5_000);
  }

  function showRejected(error) {
    openDialog($("confirm-dialog"), {
      title: "That change couldn't be saved exactly",
      body: h(
        "div",
        {},
        h("p", {}, error.message),
        error.typedText ? h("p", {}, "What you typed, so you can copy it:") : null,
        error.typedText ? h("textarea", { class: "copy-box", readonly: true, rows: 5 }, error.typedText) : null,
      ),
      actions: [{ label: "OK", value: null, kind: "primary" }],
    });
  }

  function renderTopbar() {
    const dirty = dirtyEntries();
    const count = dirty.length + (typing && !dirty.some((entry) => entry.path === currentPath) ? 1 : 0);
    const state = flow.state;
    const save = $("save-button");
    save.textContent = count ? `Save (${count})` : "Save";
    save.disabled = !count || state.busy;
    const publish = $("publish-button");
    publish.disabled = count > 0 || state.busy || (!state.pr && state.aheadBy === 0 && state.phase !== "published");
    const entry = current();
    $("undo-button").disabled = !entry || !entry.undo.length;
    $("discard-button").disabled = !entry || !isDirty(entry);

    let status;
    if (state.busy) status = state.notice || "Working on GitHub…";
    else if (count) status = `${count} ${count === 1 ? "file has" : "files have"} unsaved changes.`;
    else if (state.phase === "published") {
      status = state.deploy && state.deploy.status === "completed" ? `Published: ${new URL(target.assets).host} is up to date.` : state.notice;
    }
    else if (state.pr) {
      const done = state.checks.filter((check) => check.state === "passed" || check.state === "failed").length;
      status = state.phase === "publishable"
        ? `Pull request #${state.pr.number} is ready to merge.`
        : state.phase === "attention"
          ? `Pull request #${state.pr.number}: ${state.notice}`
          : `Pull request #${state.pr.number}: checks running (${done} of ${target.requiredChecks.length} done).`;
    } else if (state.aheadBy > 0) {
      const behind = state.behindBy > 0 && !state.notice ? " main has moved on since: Update from main is in Publish." : "";
      status = `${state.notice ? `${state.notice} ` : ""}Saved on edits: ${state.changedPaths.length} ${state.changedPaths.length === 1 ? "file differs" : "files differ"} from main. Publish when ready.${behind}`;
    }
    else status = state.notice || `Editing ${target.owner}/${target.repo}.`;
    if (draftMode && !state.busy) status = `Drafts on: changes are kept off thomaswhite.me until you publish them. ${status}`;
    setStatus(status);
  }

  // ---- Draft mode ----------------------------------------------------------------------
  // While on, every change to live content is saved as a draft (drafting.js),
  // left out of thomaswhite.me until published. Remembered for this tab only.

  function readDraftMode() {
    try {
      return sessionStorage.getItem("siteEditor.draftMode") === "on";
    } catch {
      return false;
    }
  }

  function setDraftMode(on) {
    draftMode = on;
    try {
      sessionStorage.setItem("siteEditor.draftMode", on ? "on" : "off");
    } catch {
      // A convenience only: the mode still applies until the tab closes.
    }
    const toggle = $("draft-mode-button");
    toggle.setAttribute("aria-pressed", String(on));
    toggle.textContent = on ? "Drafts: on" : "Drafts: off";
    renderTopbar();
    renderPanel();
  }

  // ---- Collapsing the bars -----------------------------------------------------------
  // On a phone the top bars, and wherever the panel sits under the page the
  // panel, fold away to give the page the room. Remembered for this tab only.

  const BAR_LABELS = {
    top: { toggle: "topbar-toggle", open: "▴", closed: "▾", openTitle: "Hide the top bars", closedTitle: "Show the top bars" },
    panel: { toggle: "panel-toggle", open: "▾ Hide panel", closed: "▴ Show panel" },
  };

  function readCollapsed(bar) {
    try {
      return sessionStorage.getItem(`siteEditor.collapsed.${bar}`) === "yes";
    } catch {
      return false;
    }
  }

  function setCollapsed(bar, collapsed) {
    $("app").dataset[bar] = collapsed ? "collapsed" : "open";
    try {
      sessionStorage.setItem(`siteEditor.collapsed.${bar}`, collapsed ? "yes" : "no");
    } catch {
      // A convenience only: the bar stays as it is until the tab closes.
    }
    const labels = BAR_LABELS[bar];
    const toggle = $(labels.toggle);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.textContent = collapsed ? labels.closed : labels.open;
    if (labels.openTitle) toggle.title = collapsed ? labels.closedTitle : labels.openTitle;
  }

  function renderFileList() {
    const lists = { page: $("page-list"), record: $("record-list"), blog: $("blog-source-list"), gone: $("gone-list") };
    for (const list of Object.values(lists)) list.replaceChildren();
    for (const entry of entries.values()) {
      const list = entry.status === "gone" ? lists.gone : entry.kind === "page" ? lists.page : entry.path === target.markdown.record ? lists.record : lists.blog;
      const badges = [];
      if (isDirty(entry)) badges.push(h("span", { class: "file-badge file-badge--changed", title: "Unsaved changes" }, "edited"));
      if (entry.status === "gone") badges.push(h("span", { class: "file-badge file-badge--changed", title: "Unsaved edits kept aside" }, "kept"));
      if (entry.model && entry.model.readOnly) badges.push(h("span", { class: "file-badge file-badge--locked", title: entry.model.readOnly }, "read-only"));
      else if (entry.model && entry.model.drafts.length) badges.push(h("span", { class: "file-badge file-badge--drafts", title: `${entry.model.drafts.length} drafts` }, String(entry.model.drafts.length)));
      if (entry.status === "error") badges.push(h("span", { class: "file-badge file-badge--locked" }, "error"));
      list.append(
        h(
          "li",
          {},
          h(
            "button",
            {
              type: "button",
              class: "file-link",
              "aria-current": entry.path === currentPath ? "page" : null,
              title: entry.path,
              onClick: () => open(entry.path),
            },
            h("span", { class: "file-link-label" }, entry.label),
            badges,
          ),
        ),
      );
    }
    if (!lists.record.children.length) lists.record.append(h("li", { class: "small" }, "No record file."));
    if (!lists.blog.children.length) lists.blog.append(h("li", { class: "small" }, "No blog sources yet."));
    lists.gone.hidden = !lists.gone.children.length;
    $("gone-heading").hidden = lists.gone.hidden;
  }

  function renderStageBar() {
    const entry = current();
    if (!entry) return;
    $("stage-title").textContent = entry.label;
    $("stage-path").textContent = entry.path;
    const live = $("live-link");
    if (entry.kind === "page" && entry.model && entry.model.permalink) {
      live.hidden = false;
      live.href = liveUrl(target, entry.model.permalink);
    } else {
      live.hidden = true;
    }
    $("width-toggle").hidden = entry.kind !== "page" || entry.status === "gone";
  }

  // ---- The side panel ------------------------------------------------------------------

  function renderPanel() {
    const panel = $("panel");
    const entry = current();
    panel.replaceChildren();
    if (entry && entry.status === "gone") {
      panel.append(goneNotice(entry));
      return;
    }
    if (!entry || entry.status !== "ready") return;
    if (entry.kind === "markdown") {
      if (entry.stale) panel.append(staleNotice(entry));
      panel.append(markdownPanel(entry));
      return;
    }
    const model = entry.model;
    const parts = [];
    if (entry.stale) parts.push(staleNotice(entry));
    if (model.readOnly) parts.push(h("p", { class: "notice notice--warning" }, "Read-only: ", model.readOnly));
    const kind = selection && selection.kind;
    if (kind === "block" || kind === "link") parts.push(blockPanel(entry, selection.kind === "link" ? selection.blockKey : selection.key));
    if (kind === "link") parts.push(linkPanel(entry, selection.key));
    if (kind === "image") parts.push(imagePanel(entry, selection.key));
    if (kind === "locked") parts.push(h("section", { class: "panel-section" }, h("h2", {}, "Locked"), h("p", {}, model.lockReasons.get(selection.key) || "This part can't be edited here.")));
    if (kind === "outside") parts.push(h("section", { class: "panel-section" }, h("h2", {}, "Header and footer"), h("p", {}, "The header, navigation and footer are the same on every page. Change them in a Claude session.")));
    parts.push(pagePanel(entry));
    panel.append(...parts.filter(Boolean));
  }

  function staleNotice(entry) {
    const view = () =>
      openDialog($("save-dialog"), {
        title: "Your earlier edits",
        body: h(
          "div",
          {},
          h("p", {}, `These unsaved edits were made to ${entry.stale.length === 1 ? "an older version" : "older versions"} of this file. Copy what you need, then discard them.`),
          entry.stale.map((set) => hunksView(set.original || "", set.working)),
        ),
        actions: [{ label: "Close", value: null }],
      });
    return h(
      "section",
      { class: "panel-section notice notice--warning" },
      h("p", {}, "This file changed on GitHub after your unsaved edits to it, so they weren't applied. They're kept until you discard them."),
      h("div", { class: "button-row" }, button("Show them", view, { small: true }), button("Discard them", () => {
        entry.stale = null;
        persist(entry);
        renderPanel();
      }, { small: true, kind: "quiet" })),
    );
  }

  // A file no longer on GitHub: the edits kept for it, and Discard.
  function goneNotice(entry) {
    const view = () =>
      openDialog($("save-dialog"), {
        title: "Your edits to a file no longer on GitHub",
        body: h(
          "div",
          {},
          h("p", {}, `${entry.path} is no longer on GitHub. These are your unsaved edits to it. Copy what you need, then discard them.`),
          entry.stale.map((set) => hunksView(set.original || "", set.working)),
        ),
        actions: [{ label: "Close", value: null }],
      });
    return h(
      "section",
      { class: "panel-section notice notice--warning" },
      h("h2", {}, entry.label),
      h(
        "p",
        {},
        `${entry.path} is no longer on GitHub (renamed or deleted there, in a Claude session, say), so your unsaved edits to it weren't applied, and the editor won't save or recreate it. They're kept until you discard them: copy what you need into the file where it lives now.`,
      ),
      h("div", { class: "button-row" }, button("Show them", view, { small: true }), button("Discard them", () => discardGone(entry), { small: true, kind: "quiet" })),
    );
  }

  async function discardGone(entry) {
    const confirmed = await confirmAction($("confirm-dialog"), {
      title: "Discard these edits?",
      message: `Your unsaved edits to ${entry.path}, which is no longer on GitHub, will be deleted from this tab. Copy anything you need first.`,
      confirm: "Discard edits",
      kind: "danger",
    });
    if (!confirmed) return;
    store.remove(entry.path);
    entries.delete(entry.path);
    renderFileList();
    if (currentPath === entry.path) await open(firstPagePath());
    renderTopbar();
  }

  function blockPanel(entry, key) {
    const model = entry.model;
    const block = key ? model.blockByKey.get(key) : null;
    if (!block) return null;
    const section = h("section", { class: "panel-section" });
    const name = blockName(model, key);
    section.append(h("h2", {}, block.lock ? `${name} (locked)` : name));
    if (block.lock) {
      section.append(h("p", {}, block.lock));
      return section;
    }
    const drafts = model.drafts.filter((item) => !EDITOR_DRAFT_KINDS.has(item.kind) && (item.key === key || item.blockKey === key));
    for (const draft of drafts) {
      section.append(
        h(
          "div",
          { class: "panel-row" },
          h("span", { class: `tag tag--${draft.kind}` }, draft.kind === "check" ? "To check" : "To write"),
          draft.key === key ? null : h("span", { class: "panel-row-text" }, `“${snippet(textOf(draft.node), 40)}”`),
          button(draft.kind === "check" ? "Approve" : "Done", () => runDraft(draft.key), { small: true }),
        ),
      );
    }
    if (block.shared) section.append(h("p", { class: "small" }, "This call to action is repeated on Home, Programming, Volunteering and Contact."));
    const text = blockText(model, key);
    if (/Year 1[0-3]\b/.test(text)) {
      const reviewed = [block.node, ...ancestorsWithin(block.node, model.main)].find((node) => attribute(node, "data-review"));
      section.append(h("p", { class: "small" }, reviewed ? `Mentions a school year; re-read after ${attribute(reviewed, "data-review")}.` : "Mentions a school year: it needs a data-review date."));
    }
    const row = h("div", { class: "button-row" });
    if (block.structuralKey) {
      const what = model.nodeOf.get(block.structuralKey).tagName === "li" ? "item" : "paragraph";
      row.append(button(`Add ${what} after`, () => runAddAfter(block.structuralKey), { small: true }));
      row.append(button(`Remove ${what}`, () => runRemove(block.structuralKey), { small: true, kind: "danger" }));
    }
    if (canRevert(entry, key)) row.append(button("Revert this block", () => revertBlock(key), { small: true, kind: "quiet" }));
    if (row.children.length) section.append(row);
    section.append(draftsPart(model, block));
    const enclosing = ancestorsWithin(block.node, model.main).find((node) => node.tagName === "a" && attribute(node, "href") !== null);
    if (enclosing) section.append(hrefEditor(entry, model.keyOf.get(enclosing), "This block is inside a link to"));
    section.append(h("p", { class: "small hint" }, "Type to edit. Enter or clicking elsewhere finishes the block."));
    return section;
  }

  // The panel's drafts part: the draft this block is in, with Publish and
  // Discard; or, for live content, ways to make it (or its section, or some
  // selected words) a draft; and any phrases in it kept as drafts.
  function draftsPart(model, block) {
    const part = h("div", { class: "panel-drafts" }, h("h3", {}, "Drafts"));
    const around = draftAround(model, block.node);
    if (around && EDITOR_DRAFT_KINDS.has(around.kind)) {
      const draftKey = model.keyOf.get(around.node);
      const names = DRAFT_NAMES[around.kind];
      part.append(
        h("p", { class: "small" }, `${around.node === block.node ? "This" : `The ${blockName(model, draftKey).toLowerCase()} this is in`} is ${names.what}.`),
        h(
          "div",
          { class: "button-row" },
          button(names.publish, () => runPublishDraft(draftKey), { small: true }),
          button(names.discard, () => runDiscardDraft(draftKey), { small: true, kind: around.kind === "remove" ? "quiet" : "danger" }),
        ),
      );
      if (around.kind === "replace" && liveChanged(model, draftKey)) {
        part.append(
          h("p", { class: "notice notice--warning" }, "The live version has changed since this new version was made, so it isn't published yet. Carry the change into this version, then record the live version as it is now."),
          h(
            "div",
            { class: "button-row" },
            button("Show both", () => showLiveChanged(draftKey), { small: true }),
            button("Record the live version", () => runRecordLive(draftKey), { small: true }),
          ),
        );
      }
    } else if (!around) {
      const section = [block.node, ...ancestorsWithin(block.node, model.main)].find((node) => node.tagName === "section");
      const whole = h("div", { class: "button-row" }, button("Make this a draft", () => runMakeDraft(block.key, blockName(model, block.key).toLowerCase()), { small: true }));
      if (section) whole.append(button("Make the section a draft", () => runMakeDraft(model.keyOf.get(section), "section"), { small: true }));
      part.append(
        h("p", { class: "small" }, "A draft is saved but left out of thomaswhite.me until you publish it. Turn on Drafts in the top bar to keep every change as one."),
        whole,
        h("p", { class: "small" }, "Or select some words in the text, then:"),
        h(
          "div",
          { class: "button-row" },
          button("Keep them off the live site", () => runDraftPhrase("new", block.key), { small: true }),
          button("Remove them when published", () => runDraftPhrase("remove", block.key), { small: true }),
        ),
      );
    }
    for (const draft of model.drafts.filter((item) => EDITOR_DRAFT_KINDS.has(item.kind) && item.blockKey === block.key && (!around || item.node !== around.node))) {
      const names = DRAFT_NAMES[draft.kind];
      part.append(
        h(
          "div",
          { class: "panel-row" },
          h("span", { class: `tag tag--draft-${draft.kind}` }, names.tag),
          h("span", { class: "panel-row-text" }, `“${snippet(textOf(draft.node), 40)}”`),
          button(names.publish, () => runPublishDraft(draft.key), { small: true }),
          button(names.discard, () => runDiscardDraft(draft.key), { small: true, kind: "quiet" }),
        ),
      );
    }
    return part;
  }

  function ancestorsWithin(node, stop) {
    const list = [];
    for (let item = node.parentNode; item && item !== stop; item = item.parentNode) list.push(item);
    return list;
  }

  function hrefEditor(entry, key, label = "Goes to") {
    const node = entry.model.nodeOf.get(key);
    const input = h("input", { type: "text", class: "text-input", value: attribute(node, "href") || "", "aria-label": "Link address", spellcheck: "false" });
    const apply = () => {
      const value = input.value.trim();
      if (value && value !== attribute(node, "href")) applyOperation("Changed a link", (model) => setAttribute(model, key, "href", value));
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") apply();
    });
    const newTab = attribute(node, "target") === "_blank";
    return h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, label, input),
      h("div", { class: "button-row" }, button("Apply", apply, { small: true })),
      h("p", { class: "small" }, newTab ? "Opens in a new tab." : "Opens in the same tab."),
    );
  }

  function linkPanel(entry, key) {
    const node = entry.model.nodeOf.get(key);
    if (!node) return null;
    const section = h("section", { class: "panel-section" }, h("h2", {}, "Link"));
    section.append(h("p", {}, "Text: ", h("strong", {}, collapse(textOf(node)) || "(no text)")));
    if (entry.model.readOnly) return section;
    if (hasWaitingVersion(entry.model, node)) {
      section.append(h("p", {}, WAITING));
      return section;
    }
    section.append(hrefEditor(entry, key));
    const href = attribute(node, "href") || "";
    const external = /^[a-z]+:/i.test(href) || /\.pdf($|[?#])/i.test(href);
    const newTab = attribute(node, "target") === "_blank";
    if (external && !newTab) {
      section.append(button("Open in a new tab", () => applyOperation("Made a link open in a new tab", (model) => openInNewTab(model, key)), { small: true }));
    }
    if (!external && newTab) {
      section.append(button("Open in the same tab", () => applyOperation("Made a link open in the same tab", (model) => openInSameTab(model, key)), { small: true }));
    }
    return section;
  }

  function imagePanel(entry, key) {
    const model = entry.model;
    const image = model.images.find((item) => item.key === key);
    if (!image) return null;
    const section = h("section", { class: "panel-section" }, h("h2", {}, image.gallery ? "Gallery photo" : "Image"));
    if (!model.readOnly && hasWaitingVersion(model, image.node)) {
      section.append(h("p", {}, WAITING));
      return section;
    }
    const field = (label, value, name, targetKey, multiline = false) => {
      const input = multiline
        ? h("textarea", { class: "text-input", rows: 3, "aria-label": label }, value || "")
        : h("input", { type: "text", class: "text-input", value: value || "", "aria-label": label });
      const apply = () => {
        const next = input.value.trim();
        if (next !== (value || "")) applyOperation(`Changed ${label.toLowerCase()}`, (current) => setAttribute(current, targetKey, name, next));
      };
      return h("div", { class: "field" }, h("label", { class: "field-label" }, label, input), model.readOnly ? null : h("div", { class: "button-row" }, button("Apply", apply, { small: true })));
    };
    section.append(field("Alt text", attribute(image.node, "alt"), "alt", key, true));
    if (image.gallery) {
      const buttonNode = model.nodeOf.get(image.gallery.buttonKey);
      const caption = image.gallery.captionKey ? collapse(textOf(model.nodeOf.get(image.gallery.captionKey))) : "";
      if (attribute(buttonNode, "data-caption") !== null) section.append(field("Expanded caption", attribute(buttonNode, "data-caption"), "data-caption", image.gallery.buttonKey));
      section.append(field("Button label", attribute(buttonNode, "aria-label"), "aria-label", image.gallery.buttonKey));
      section.append(h("p", { class: "small" }, "Visible caption: ", h("strong", {}, caption || "(none)"), ". Edit it on the page."));
    }
    return section;
  }

  function pagePanel(entry) {
    const model = entry.model;
    const section = h("section", { class: "panel-section panel-section--page" }, h("h2", {}, entry.label));
    if (model.now && !model.readOnly) {
      const month = thisMonth();
      const input = h("input", { type: "month", class: "text-input", value: month, "aria-label": "Month" });
      section.append(
        h(
          "div",
          { class: "field" },
          h("p", { class: "field-label" }, "Now section: ", h("strong", {}, updatedLabel(model.now.updated))),
          h("div", { class: "button-row" }, input, button("Set Updated", () => applyOperation("Updated the Now section's month", (current) => setNowUpdated(current, input.value || month), { flashKey: model.now.lineKey }), { small: true })),
          h("p", { class: "small" }, "Changes data-updated and the visible “Updated Month Year” line together."),
        ),
      );
    }
    if (model.drafts.length) {
      section.append(h("h3", {}, `Drafts on this page (${model.drafts.length})`));
      section.append(
        h(
          "ul",
          { class: "draft-list" },
          model.drafts.map((draft) => {
            const go = h("button", { type: "button", class: "draft-go", onClick: () => goTo(entry.path, draft.blockKey || draft.key) }, snippet(textOf(draft.node), 80) || "(empty)");
            const names = DRAFT_NAMES[draft.kind];
            // The editor's own drafts are published (or discarded, from the block's panel);
            // the content-strategy placeholders are finished with Done or Approve.
            if (names) {
              return h(
                "li",
                { class: "draft-item" },
                h("span", { class: `tag tag--draft-${draft.kind}` }, names.tag),
                go,
                model.readOnly ? null : button(draft.kind === "remove" ? "Remove now" : "Publish", () => runPublishDraft(draft.key), { small: true, title: names.publish }),
              );
            }
            return h(
              "li",
              { class: "draft-item" },
              h("span", { class: `tag tag--${draft.kind}` }, draft.kind === "check" ? "Check" : "Write"),
              go,
              model.readOnly ? null : button(draft.kind === "check" ? "Approve" : "Done", () => runDraft(draft.key), { small: true }),
            );
          }),
        ),
      );
    } else if (!model.readOnly) {
      section.append(h("p", { class: "small" }, "No drafts on this page."));
    }
    if (!model.readOnly) {
      section.append(h("p", { class: "small hint" }, "Click any text on the page to edit it. Links and images open here when clicked. Save commits every changed file at once."));
    }
    return section;
  }

  function markdownPanel(entry) {
    const section = h("section", { class: "panel-section" }, h("h2", {}, entry.label));
    if (entry.path === target.markdown.record) {
      section.append(h("p", {}, "Your private record. Not published: the site's _config.yml excludes docs/."));
      section.append(h("p", { class: "small" }, "The “### slug” headings are what the pages' data-record attributes point at; renaming one would fail the site's checks, and Save will say so."));
    } else {
      section.append(h("p", {}, "A blog post source. Not published; a Claude session turns it into the post page."));
      section.append(h("p", { class: "small" }, "Start with the month, year and age, then “# Title” and a lede. Add a “##” subheading every 300 to 400 words and end with a Related list."));
    }
    if (entry.isNew) section.append(h("p", { class: "notice" }, "New file: it's created on GitHub when you save."));
    return section;
  }

  function thisMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  async function goTo(path, key) {
    if (currentPath !== path) await open(path);
    const entry = current();
    if (!entry || entry.kind !== "page" || entry.status !== "ready" || !entry.model.nodeOf.has(key)) return;
    const kind = entry.model.blockByKey.has(key) ? "block" : "none";
    preview.select({ kind, key });
  }

  async function newPost() {
    syncMarkdown();
    const title = await promptText($("confirm-dialog"), {
      title: "New post source",
      label: "Post title",
      confirm: "Create",
      hint: "The file goes in docs/blog-sources/ and is created on GitHub when you save.",
    });
    if (!title) return;
    const record = entries.get(target.markdown.record);
    if (record) await ensureLoaded(record);
    let created;
    try {
      created = newPostSource({
        title,
        today: new Date(),
        recordText: record && record.status === "ready" ? record.working : null,
        folder: target.markdown.blogSources,
        existing: [...entries.keys(), ...flow.state.files.keys()],
      });
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    const entry = makeEntry(created.path, "markdown", null);
    Object.assign(entry, { status: "ready", original: "", working: created.text, isNew: true });
    entries.set(created.path, entry);
    persist(entry);
    renderFileList();
    await open(created.path);
  }

  function closeSidebar() {
    $("sidebar").dataset.open = "false";
    $("sidebar-toggle").setAttribute("aria-expanded", "false");
  }

  // ---- Wiring --------------------------------------------------------------------------

  function wireInterface() {
    $("save-button").onclick = () => startSave();
    $("publish-button").onclick = () => openPublish();
    $("undo-button").onclick = () => undo();
    $("draft-mode-button").onclick = () => setDraftMode(!draftMode);
    $("draft-mode-button").setAttribute("aria-pressed", String(draftMode));
    $("draft-mode-button").textContent = draftMode ? "Drafts: on" : "Drafts: off";
    $("discard-button").onclick = () => discardPage();
    $("new-post-button").onclick = () => newPost();
    $("sidebar-toggle").onclick = () => {
      const sidebar = $("sidebar");
      const open = sidebar.dataset.open !== "true";
      sidebar.dataset.open = String(open);
      $("sidebar-toggle").setAttribute("aria-expanded", String(open));
    };
    for (const bar of Object.keys(BAR_LABELS)) {
      setCollapsed(bar, readCollapsed(bar));
      $(BAR_LABELS[bar].toggle).onclick = () => setCollapsed(bar, $("app").dataset[bar] !== "collapsed");
    }
    for (const toggle of $("width-toggle").querySelectorAll("button")) {
      toggle.onclick = () => {
        for (const other of $("width-toggle").querySelectorAll("button")) other.setAttribute("aria-pressed", String(other === toggle));
        preview.setWidth(toggle.dataset.width);
      };
    }
    const editor = $("markdown-editor");
    editor.oninput = () => {
      const entry = current();
      if (!entry || entry.kind !== "markdown" || entry.status !== "ready") return;
      clearTimeout(markdownTimer);
      entry.working = editor.value;
      renderTopbar();
      markdownTimer = setTimeout(() => {
        persist(entry);
        renderFileList();
        renderTopbar();
      }, 400);
    };
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        startSave();
      }
    });
    window.addEventListener("beforeunload", (event) => {
      preview.finishEditing();
      syncMarkdown();
      if (dirtyEntries().length) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") followRefresh();
    });
  }

  async function start() {
    wireInterface();
    $("account-summary").textContent = user.login;
    $("account-name").textContent = `Signed in as ${user.login}`;
    const host = new URL(target.assets).host;
    $("site-link").href = `${target.assets}/`;
    $("site-link").textContent = host;
    setStatus("Loading the site from GitHub…");
    stageMessage(`Loading ${target.owner}/${target.repo}…`);
    try {
      const { files } = await flow.load({ autoUpdate: nothingUnsaved() });
      syncEntries(files);
      renderFileList();
      let remembered = null;
      try {
        remembered = sessionStorage.getItem("siteEditor.currentPage");
      } catch {
        remembered = null;
      }
      await open(remembered && entries.has(remembered) ? remembered : firstPagePath());
      renderTopbar();
      prefetchAll().catch(() => {});
      startPolling();
      followRefresh();
    } catch (error) {
      if (error instanceof SignedOutError) {
        onSignedOut(error.message);
        return;
      }
      stageMessage(describeError(error, target), "error");
      setStatus("");
    }
  }

  return {
    start,
    flow,
    preview,
    entries,
    open,
    startSave,
    stop() {
      clearInterval(pollTimer);
    },
    // Used by tests and the mock's panel.
    get current() {
      return current();
    },
    toast,
    months: MONTHS,
  };
}
