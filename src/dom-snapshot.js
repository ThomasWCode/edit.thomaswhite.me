// Reads an edited block from the preview's DOM as a snapshot (see
// snapshot.js). Elements from the page keep their data-edit-key; their
// attributes are not needed because their original tags are reused. Elements
// the browser created have no key and keep their attributes, so sanitise can
// tell a style-only wrapper from anything else.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const EDITOR_ATTRIBUTES = /^(data-edit-|contenteditable$|spellcheck$)/;

export function snapshotFromDom(element) {
  const visit = (node) => {
    if (node.nodeType === TEXT_NODE) return { type: "text", text: node.data };
    if (node.nodeType !== ELEMENT_NODE) return null;
    const key = node.getAttribute("data-edit-key");
    const attrs = key === null
      ? Array.from(node.attributes, (attribute) => [attribute.name, attribute.value]).filter(([name]) => !EDITOR_ATTRIBUTES.test(name))
      : [];
    return {
      type: "element",
      key,
      tag: node.localName,
      attrs,
      children: Array.from(node.childNodes, visit).filter(Boolean),
    };
  };
  return visit(element);
}
