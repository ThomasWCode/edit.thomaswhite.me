// Myers' O(ND) difference algorithm over two arrays (E. W. Myers, "An O(ND)
// Difference Algorithm and Its Variations", 1986). The editor diffs words, so
// the arrays are short; common prefixes and suffixes are trimmed first.
//
// Returns a list of operations in order:
//   { type: "equal", oldIndex, newIndex } | { type: "delete", oldIndex } | { type: "insert", newIndex }
// Deletions come before insertions within a changed run.

export function diffSequences(before, after, equals = (a, b) => a === b) {
  let start = 0;
  while (start < before.length && start < after.length && equals(before[start], after[start])) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && equals(before[endBefore - 1], after[endAfter - 1])) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const operations = [];
  for (let index = 0; index < start; index += 1) operations.push({ type: "equal", oldIndex: index, newIndex: index });
  operations.push(...middle(before, after, start, endBefore, start, endAfter, equals));
  for (let offset = 0; offset < before.length - endBefore; offset += 1) {
    operations.push({ type: "equal", oldIndex: endBefore + offset, newIndex: endAfter + offset });
  }
  return operations;
}

function middle(before, after, beforeStart, beforeEnd, afterStart, afterEnd, equals) {
  const n = beforeEnd - beforeStart;
  const m = afterEnd - afterStart;
  if (n === 0 && m === 0) return [];
  if (n === 0) return Array.from({ length: m }, (_, index) => ({ type: "insert", newIndex: afterStart + index }));
  if (m === 0) return Array.from({ length: n }, (_, index) => ({ type: "delete", oldIndex: beforeStart + index }));

  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && equals(before[beforeStart + x], after[afterStart + y])) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }

  // Walk the trace backwards to recover the path, then emit it forwards.
  const reversed = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const snapshot = trace[d];
    const k = x - y;
    const previousK =
      k === -d || (k !== d && snapshot[offset + k - 1] < snapshot[offset + k + 1]) ? k + 1 : k - 1;
    const previousX = snapshot[offset + previousK];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      reversed.push({ type: "equal", oldIndex: beforeStart + x, newIndex: afterStart + y });
    }
    if (d > 0) {
      if (x === previousX) reversed.push({ type: "insert", newIndex: afterStart + previousY });
      else reversed.push({ type: "delete", oldIndex: beforeStart + previousX });
    }
    x = previousX;
    y = previousY;
  }
  return normaliseRuns(reversed.reverse());
}

// Within each run of changes, put every deletion before every insertion so a
// replaced word reads as "delete old, insert new".
function normaliseRuns(operations) {
  const result = [];
  let deletes = [];
  let inserts = [];
  const flush = () => {
    result.push(...deletes, ...inserts);
    deletes = [];
    inserts = [];
  };
  for (const operation of operations) {
    if (operation.type === "equal") {
      flush();
      result.push(operation);
    } else if (operation.type === "delete") {
      deletes.push(operation);
    } else {
      inserts.push(operation);
    }
  }
  flush();
  return result;
}
