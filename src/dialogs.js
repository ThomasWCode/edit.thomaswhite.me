// Modal dialogs on the page's <dialog> elements.

import { button, h } from "./dom.js";

// Shows a dialog and resolves with the value of the action chosen, or null
// when it is dismissed (Escape or ×). `actions`: [{ label, value, kind, disabled }].
// `body` is a node, or a function given `close(value)` for buttons inside it.
export function openDialog(dialog, { title, body, actions = [{ label: "Close", value: null }] }) {
  return new Promise((resolve) => {
    const titleId = `${dialog.id}-title`;
    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(value);
    };
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.replaceChildren(
      h(
        "div",
        { class: "dialog-inner" },
        h(
          "header",
          { class: "dialog-header" },
          h("h2", { id: titleId, class: "dialog-title" }, title),
          h("button", { type: "button", class: "button button--quiet dialog-close", "aria-label": "Close", onClick: () => close(null) }, "×"),
        ),
        h("div", { class: "dialog-body" }, typeof body === "function" ? body(close) : body),
        actions.length
          ? h(
              "footer",
              { class: "dialog-actions" },
              actions.map((action) => button(action.label, () => close(action.value), { kind: action.kind, disabled: action.disabled })),
            )
          : null,
      ),
    );
    dialog.oncancel = (event) => {
      event.preventDefault();
      close(null);
    };
    dialog.showModal();
    const preferred = dialog.querySelector(".dialog-actions .button--primary:not(:disabled)") || dialog.querySelector(".dialog-actions .button:not(:disabled)");
    if (preferred) preferred.focus();
  });
}

// Asks for one line of text; resolves with it, or null.
export async function promptText(dialog, { title, label, value = "", confirm = "OK", hint = "" }) {
  const input = h("input", { type: "text", class: "text-input", value, "aria-label": label });
  const body = h(
    "div",
    { class: "form-row" },
    h("label", { class: "field-label" }, label, input),
    hint ? h("p", { class: "small" }, hint) : null,
  );
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dialog.querySelector(".dialog-actions .button--primary").click();
    }
  });
  const chosen = openDialog(dialog, { title, body, actions: [{ label: "Cancel", value: null }, { label: confirm, value: "ok", kind: "primary" }] });
  input.focus();
  input.select();
  return (await chosen) === "ok" ? input.value : null;
}

export function confirmAction(dialog, { title, message, confirm, kind = "primary" }) {
  return openDialog(dialog, {
    title,
    body: h("p", {}, message),
    actions: [{ label: "Cancel", value: false }, { label: confirm, value: true, kind }],
  }).then((value) => value === true);
}
