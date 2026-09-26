// A small element builder for the editor's interface. Text is always set with
// textContent, never parsed as HTML, and nothing uses a style attribute (the
// CSP blocks them; positions are set through element.style instead).

export const $ = (id) => document.getElementById(id);

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name === "class") element.className = value;
    else if (name === "text") element.textContent = value;
    else if (name === "dataset") Object.assign(element.dataset, value);
    else if (name.startsWith("on") && typeof value === "function") element.addEventListener(name.slice(2).toLowerCase(), value);
    else if (value === true) element.setAttribute(name, "");
    else element.setAttribute(name, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

export const externalLink = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);

export function button(label, onClick, { kind = "", small = false, disabled = false, title = null } = {}) {
  const classes = ["button", kind ? `button--${kind}` : "", small ? "button--small" : ""].filter(Boolean).join(" ");
  return h("button", { type: "button", class: classes, onClick, disabled, title }, label);
}
