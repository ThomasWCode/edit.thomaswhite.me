// What the Save dialog shows: for each changed block, the words that changed;
// then the raw line hunks of every file, as git will see them.

import { diffSequences } from "./sequence-diff.js";

const words = (text) => (text ? text.split(/[ \t\n\f\r]+/).filter(Boolean) : []);

// Word-level runs for display: [{ type: "equal" | "delete" | "insert", text }].
export function wordDiff(before, after) {
  const a = words(before);
  const b = words(after);
  const runs = [];
  for (const operation of diffSequences(a, b)) {
    const text = operation.type === "insert" ? b[operation.newIndex] : a[operation.oldIndex];
    const last = runs[runs.length - 1];
    if (last && last.type === operation.type) last.text += ` ${text}`;
    else runs.push({ type: operation.type, text });
  }
  return runs;
}

// Long unchanged stretches are shortened to their ends ("… ").
export function trimEqualRuns(runs, keep = 6) {
  return runs.map((run, index) => {
    if (run.type !== "equal") return run;
    const list = run.text.split(" ");
    if (list.length <= keep * 2) return run;
    const first = index === 0;
    const last = index === runs.length - 1;
    if (first) return { ...run, text: `… ${list.slice(-keep).join(" ")}` };
    if (last) return { ...run, text: `${list.slice(0, keep).join(" ")} …` };
    return { ...run, text: `${list.slice(0, keep).join(" ")} … ${list.slice(-keep).join(" ")}` };
  });
}

// Unified-diff hunks with `context` unchanged lines around each change:
// [{ oldStart, newStart, rows: [{ type: " " | "-" | "+", text }] }].
export function lineHunks(before, after, context = 2) {
  const a = before.split("\n");
  const b = after.split("\n");
  const rows = diffSequences(a, b).map((operation) => {
    if (operation.type === "equal") return { type: " ", text: a[operation.oldIndex], oldLine: operation.oldIndex + 1, newLine: operation.newIndex + 1 };
    if (operation.type === "delete") return { type: "-", text: a[operation.oldIndex], oldLine: operation.oldIndex + 1 };
    return { type: "+", text: b[operation.newIndex], newLine: operation.newIndex + 1 };
  });

  // Widen each changed row by `context` rows and merge ranges that touch.
  const ranges = [];
  rows.forEach((row, index) => {
    if (row.type === " ") return;
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  });

  return ranges.map(({ start, end }) => {
    const slice = rows.slice(start, end + 1);
    const firstOld = slice.find((row) => row.oldLine !== undefined);
    const firstNew = slice.find((row) => row.newLine !== undefined);
    return {
      oldStart: firstOld ? firstOld.oldLine : 0,
      newStart: firstNew ? firstNew.newLine : 0,
      rows: slice.map(({ type, text }) => ({ type, text })),
    };
  });
}

export function countLineChanges(before, after) {
  let added = 0;
  let removed = 0;
  for (const operation of diffSequences(before.split("\n"), after.split("\n"))) {
    if (operation.type === "insert") added += 1;
    if (operation.type === "delete") removed += 1;
  }
  return { added, removed };
}

// The commit message for a save: "Edit 2 files in the editor" and the list.
export function commitMessage(paths) {
  const noun = paths.length === 1 ? "file" : "files";
  return `Edit ${paths.length} ${noun} in the editor\n\n${paths.map((path) => `- ${path}`).join("\n")}\n`;
}
