// Entry point for the vendored parse5 bundle (see scripts/bundle-parse5.mjs).
// Only what the editor uses is re-exported, so the bundle stays small and the
// public surface is explicit.
export { parse, parseFragment, serialize, serializeOuter, defaultTreeAdapter } from "parse5";
export { decodeHTML, escapeText, escapeAttribute } from "entities";
