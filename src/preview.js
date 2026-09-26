// The preview frame: the page rendered from the working source (render-copy.js)
// in a same-origin srcdoc iframe, with the editor listening from outside.
//
// No sandbox attribute: WebKit does not deliver events to listeners the parent
// attaches inside a sandboxed frame without allow-scripts (bug 218086), which
// would break editing on an iPhone. The frame is script-less anyway: every
// script is stripped and its own CSP meta says script-src 'none'.
//
// One block at a time is contenteditable. mousedown (or keyboard focus) on an
// editable block finishes the previous one and starts this one; focusout, Enter
// and Escape finish it, handing a DOM snapshot to `onCommit`. beforeinput lets
// only typing, deleting and undo through; paste becomes plain text. Every click
// is cancelled (links would otherwise navigate, through <base>, to the live
// site) and reported to `onSelect` instead.

import { renderCopy } from "./render-copy.js";
import { snapshotFromDom } from "./dom-snapshot.js";
import { h } from "./dom.js";

const ALLOWED_INPUT = new Set([
  "insertText",
  "insertCompositionText",
  "insertReplacementText",
  "historyUndo",
  "historyRedo",
  "deleteContent",
  "deleteContentBackward",
  "deleteContentForward",
  "deleteWordBackward",
  "deleteWordForward",
  "deleteSoftLineBackward",
  "deleteSoftLineForward",
  "deleteHardLineBackward",
  "deleteHardLineForward",
  "deleteEntireSoftLine",
  "deleteByCut",
]);

const roles = (element) => (element && element.getAttribute ? (element.getAttribute("data-edit-role") || "").split(" ") : []);
const hasRole = (element, role) => roles(element).includes(role);

function closestWithRole(start, role) {
  for (let element = start; element && element.nodeType === 1; element = element.parentElement) {
    if (hasRole(element, role)) return element;
  }
  return null;
}

function closestKeyed(start) {
  for (let element = start; element && element.nodeType === 1; element = element.parentElement) {
    if (element.hasAttribute("data-edit-key")) return element;
  }
  return null;
}

export function createPreview({ iframe, overlay, wrap, assetsOrigin, editorOrigin, onCommit, onSelect, onInput, onShortcut }) {
  let model = null;
  let doc = null;
  let editing = null;
  let selected = null;
  let toolbar = null;
  let toolbarFor = null;
  let pendingFocus = null;
  let changedKeys = new Set();

  const frameWindow = () => iframe.contentWindow;
  const elementFor = (key) => (doc && key !== null ? doc.querySelector(`[data-edit-key="${key}"]`) : null);

  function selectionFor(target) {
    const link = target.closest && target.closest("a[href]");
    const image = closestWithRole(target, "image") || closestWithRole(target, "gallery");
    const locked = closestWithRole(target, "locked");
    const block = closestWithRole(target, "block");
    const keyed = closestKeyed(target);
    if (!keyed) return { kind: "outside" };
    if (image) return { kind: "image", key: image.getAttribute("data-edit-key") };
    if (locked && !block) return { kind: "locked", key: locked.getAttribute("data-edit-key") };
    const blockKey = block ? block.getAttribute("data-edit-key") : null;
    if (link && link.hasAttribute("data-edit-key")) return { kind: "link", key: link.getAttribute("data-edit-key"), blockKey };
    if (block) return { kind: "block", key: blockKey };
    return { kind: "none", key: keyed.getAttribute("data-edit-key") };
  }

  function markSelected(key) {
    if (!doc) return;
    for (const element of doc.querySelectorAll("[data-edit-selected]")) element.removeAttribute("data-edit-selected");
    const element = elementFor(key);
    if (element) element.setAttribute("data-edit-selected", "");
  }

  function select(selection) {
    selected = selection;
    markSelected(selection && selection.key !== undefined ? selection.blockKey || selection.key : null);
    onSelect(selection);
    placeToolbar();
  }

  function startEditing(block, { caretAtEnd = false } = {}) {
    if (editing === block) return;
    finishEditing();
    block.setAttribute("contenteditable", "true");
    block.spellcheck = true;
    editing = block;
    if (caretAtEnd) {
      block.focus({ preventScroll: true });
      const range = doc.createRange();
      range.selectNodeContents(block);
      range.collapse(false);
      const selection = frameWindow().getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function selectAllIn(block) {
    const range = doc.createRange();
    range.selectNodeContents(block);
    const selection = frameWindow().getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // Ends the current edit and hands its snapshot over. Safe to call twice:
  // `editing` is cleared before anything that could fire focusout again.
  function finishEditing() {
    if (!editing) return;
    const element = editing;
    editing = null;
    element.removeAttribute("contenteditable");
    const key = element.getAttribute("data-edit-key");
    if (element.isConnected) onCommit(key, snapshotFromDom(element));
  }

  function wire() {
    const options = { capture: true };
    doc.addEventListener(
      "mousedown",
      (event) => {
        if (event.button !== 0) return;
        const block = closestWithRole(event.target, "block");
        const image = closestWithRole(event.target, "image") || closestWithRole(event.target, "gallery");
        if (image) {
          event.preventDefault();
          finishEditing();
          return;
        }
        if (block) startEditing(block);
        else finishEditing();
      },
      options,
    );
    doc.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        select(selectionFor(event.target));
      },
      options,
    );
    doc.addEventListener(
      "focusin",
      (event) => {
        const block = closestWithRole(event.target, "block");
        if (block && block !== editing && event.target === block) {
          startEditing(block, { caretAtEnd: true });
          select({ kind: "block", key: block.getAttribute("data-edit-key") });
        } else if (hasRole(event.target, "image") || hasRole(event.target, "gallery")) {
          finishEditing();
          select({ kind: "image", key: event.target.getAttribute("data-edit-key") });
        }
      },
      options,
    );
    doc.addEventListener(
      "focusout",
      (event) => {
        if (!editing) return;
        if (event.relatedTarget && editing.contains(event.relatedTarget)) return;
        finishEditing();
      },
      options,
    );
    doc.addEventListener(
      "keydown",
      (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          finishEditing();
          onShortcut("save");
          return;
        }
        if (!editing) return;
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          const element = editing;
          finishEditing();
          element.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          const element = editing;
          finishEditing();
          element.blur();
        }
      },
      options,
    );
    // Pasted content becomes plain text on one line. The paste event carries
    // the clipboard in every engine; cancelling it means no insertFromPaste
    // follows, so the beforeinput branch below is only a fallback.
    const insertPlain = (text) => {
      if (text) doc.execCommand("insertText", false, text.replace(/[ \t]*[\r\n]+[ \t]*/g, " "));
    };
    doc.addEventListener(
      "paste",
      (event) => {
        event.preventDefault();
        if (editing) insertPlain(event.clipboardData ? event.clipboardData.getData("text/plain") : "");
      },
      options,
    );
    doc.addEventListener(
      "beforeinput",
      (event) => {
        if (!editing) {
          event.preventDefault();
          return;
        }
        if (event.inputType === "insertFromPaste" || event.inputType === "insertFromPasteAsQuotation") {
          event.preventDefault();
          insertPlain(event.dataTransfer ? event.dataTransfer.getData("text/plain") : "");
          return;
        }
        if (!ALLOWED_INPUT.has(event.inputType)) event.preventDefault();
      },
      options,
    );
    doc.addEventListener(
      "input",
      () => {
        if (editing) onInput(editing.getAttribute("data-edit-key"));
      },
      options,
    );
    for (const type of ["submit", "dragstart", "drop"]) doc.addEventListener(type, (event) => event.preventDefault(), options);
    frameWindow().addEventListener("scroll", placeToolbar, { passive: true });
    frameWindow().addEventListener("resize", placeToolbar);
  }

  function applyChangedMarks() {
    if (!doc) return;
    for (const element of doc.querySelectorAll("[data-edit-changed]")) element.removeAttribute("data-edit-changed");
    for (const key of changedKeys) {
      const element = elementFor(key);
      if (element) element.setAttribute("data-edit-changed", "");
    }
  }

  // Waits for the frame's new document (srcdoc navigation replaces it) and
  // wires the listeners once it is parsed, well before images finish: a click
  // on the visible page must never go unheard.
  function whenParsed(previous, callback) {
    const check = () => {
      const current = iframe.contentDocument;
      if (current && current !== previous) {
        if (current.readyState === "loading") current.addEventListener("DOMContentLoaded", () => callback(current), { once: true });
        else callback(current);
        return;
      }
      setTimeout(check, 10);
    };
    check();
  }

  let renderToken = 0;
  let wiredDocument = null;

  // Adopts the frame's current document once per document.
  function adopt(document) {
    if (wiredDocument === document) return;
    wiredDocument = document;
    doc = document;
    wire();
    applyChangedMarks();
  }

  // Renders `next` in the frame. Keeps the scroll position; optionally puts
  // the caret in `focusKey` (selecting its text) or flashes `flashKey`.
  function render(next, { focusKey = null, flashKey = null, selectAll = false, keepScroll = true } = {}) {
    const scroll = doc && keepScroll ? { x: frameWindow().scrollX, y: frameWindow().scrollY } : null;
    const previous = iframe.contentDocument;
    const token = (renderToken += 1);
    editing = null;
    model = next;
    doc = null;
    pendingFocus = { focusKey, flashKey, selectAll, scroll };
    wrap.dataset.ready = "false";
    hideToolbar();
    return new Promise((resolve) => {
      whenParsed(previous, (parsed) => {
        if (token === renderToken) adopt(parsed);
      });
      iframe.addEventListener(
        "load",
        () => {
          if (token !== renderToken) return resolve();
          adopt(iframe.contentDocument);
          const { scroll: position } = pendingFocus;
          // The site sets scroll-behavior: smooth; a restore must not glide.
          if (position) frameWindow().scrollTo({ left: position.x, top: position.y, behavior: "instant" });
          applyChangedMarks();
          if (selected) markSelected(selected.blockKey || selected.key);
          const focusElement = elementFor(pendingFocus.focusKey);
          if (focusElement && hasRole(focusElement, "block")) {
            focusElement.scrollIntoView({ block: "nearest", behavior: "instant" });
            startEditing(focusElement, { caretAtEnd: true });
            if (pendingFocus.selectAll) selectAllIn(focusElement);
            select({ kind: "block", key: pendingFocus.focusKey });
          }
          const flash = elementFor(pendingFocus.flashKey);
          if (flash) {
            flash.scrollIntoView({ block: "center" });
            flash.setAttribute("data-edit-flash", "");
          }
          placeToolbar();
          wrap.dataset.ready = "true";
          resolve();
        },
        { once: true },
      );
      iframe.srcdoc = renderCopy(next, { assetsOrigin, editorOrigin });
    });
  }

  // ---- The toolbar over the selected block (drawn in the parent page) ----

  let toolbarActions = () => [];

  function hideToolbar() {
    if (toolbar) toolbar.hidden = true;
    toolbarFor = null;
  }

  function placeToolbar() {
    if (!doc || !selected || !["block", "link"].includes(selected.kind)) return hideToolbar();
    const key = selected.kind === "link" ? selected.blockKey : selected.key;
    const element = elementFor(key);
    const actions = key ? toolbarActions(key) : [];
    if (!element || !actions.length) return hideToolbar();
    if (!toolbar) {
      toolbar = h("div", { class: "edit-toolbar", role: "toolbar", "aria-label": "Block actions" });
      overlay.append(toolbar);
    }
    if (toolbarFor !== key) {
      toolbar.replaceChildren(
        ...actions.map((action) =>
          h(
            "button",
            {
              type: "button",
              class: `edit-toolbar-button${action.kind ? ` edit-toolbar-button--${action.kind}` : ""}`,
              title: action.title,
              "aria-label": action.title,
              onMousedown: (event) => event.preventDefault(),
              onClick: () => action.run(),
            },
            action.label,
          ),
        ),
      );
      toolbarFor = key;
    }
    toolbar.hidden = false;
    const rect = element.getBoundingClientRect();
    const frameRect = iframe.getBoundingClientRect();
    const width = toolbar.offsetWidth;
    const height = toolbar.offsetHeight;
    if (rect.bottom < 0 || rect.top > frameRect.height) return hideToolbar();
    const top = rect.top - height - 6 < 4 ? rect.bottom + 6 : rect.top - height - 6;
    const left = Math.max(4, Math.min(frameRect.width - width - 4, rect.right - width));
    toolbar.style.top = `${Math.round(top)}px`;
    toolbar.style.left = `${Math.round(left)}px`;
  }

  return {
    render,
    finishEditing,
    get model() {
      return model;
    },
    setModel(next) {
      model = next;
    },
    get selection() {
      return selected;
    },
    select(selection) {
      finishEditing();
      select(selection);
      const element = selection && elementFor(selection.blockKey || selection.key);
      if (element) element.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    clearSelection() {
      selected = null;
      markSelected(null);
      hideToolbar();
    },
    setChangedKeys(keys) {
      changedKeys = new Set(keys);
      applyChangedMarks();
    },
    setToolbarActions(provider) {
      toolbarActions = provider;
      toolbarFor = null;
      placeToolbar();
    },
    refreshToolbar() {
      toolbarFor = null;
      placeToolbar();
    },
    setWidth(width) {
      wrap.dataset.width = width;
      requestAnimationFrame(placeToolbar);
    },
    // For tests and the mock: the live element of a key.
    elementFor,
    isEditing: () => editing !== null,
  };
}
