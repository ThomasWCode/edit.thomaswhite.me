// Exact string surgery on a page's source. Every edit the editor makes is a
// list of { start, end, text } replacements against one version of the source,
// applied back to front so earlier offsets stay valid.

export function applySplices(source, splices) {
  const ordered = [...splices].sort((a, b) => b.start - a.start || b.end - a.end);
  let previousStart = Infinity;
  let result = source;
  for (const { start, end, text } of ordered) {
    if (!(start >= 0 && end >= start && end <= source.length)) {
      throw new RangeError(`Splice ${start}–${end} is outside the source.`);
    }
    if (end > previousStart) throw new RangeError(`Splices overlap at ${start}–${end}.`);
    result = result.slice(0, start) + text + result.slice(end);
    previousStart = start;
  }
  return result;
}

export function lineStart(source, offset) {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

export function lineEnd(source, offset) {
  const next = source.indexOf("\n", offset);
  return next < 0 ? source.length : next;
}

// 1-based line number of an offset.
export function lineNumber(source, offset) {
  let line = 1;
  for (let index = source.indexOf("\n"); index >= 0 && index < offset; index = source.indexOf("\n", index + 1)) line += 1;
  return line;
}

// The whitespace between the start of the line and `offset`, or null when
// something other than whitespace precedes it on that line.
export function indentationBefore(source, offset) {
  const text = source.slice(lineStart(source, offset), offset);
  return /^[ \t]*$/.test(text) ? text : null;
}

// HTML-escapes text content: only & < > need it.
export function escapeText(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// HTML-escapes a double-quoted attribute value.
export function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// No line may end in spaces or tabs (html-validate's no-trailing-whitespace).
export function stripTrailingSpaces(text) {
  return text.replace(/[ \t]+\n/g, "\n");
}
