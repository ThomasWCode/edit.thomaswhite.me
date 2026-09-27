// Git's own three-way merge of one file, as GitHub makes it, for the tests of
// merges the fake GitHub can't make: it merges whole files, so both sides
// changing one file is a conflict there, never a clean merge of different
// lines. `git merge-file` runs the same line merge as GitHub's merge-ort on a
// file both sides changed (the audit checked all 255 of its cases against
// `git merge-tree --write-tree`: identical), in one process per merge.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Returns { clean, text } for `ours` (edits) and `theirs` (main) from `base`.
export function gitMerge(base, ours, theirs) {
  const dir = mkdtempSync(join(tmpdir(), "merge-test-"));
  try {
    writeFileSync(join(dir, "ours"), ours);
    writeFileSync(join(dir, "base"), base);
    writeFileSync(join(dir, "theirs"), theirs);
    try {
      return { clean: true, text: execFileSync("git", ["merge-file", "-p", "ours", "base", "theirs"], { cwd: dir, encoding: "utf8" }) };
    } catch (error) {
      // The exit status is the number of conflicts; above 127, git failed.
      if (error.status > 0 && error.status < 128) return { clean: false, text: null };
      throw error;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
