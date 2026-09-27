// Finding 4. The editor always merges its pull request with a merge commit,
// but both site repositories also allow "Squash and merge" and "Rebase and
// merge" on GitHub's own page. After a squash, `edits` still holds commits
// main lacks, so the editor never deletes it; its next load merges main in.
// If main has meanwhile reverted one of those changes, does it come back?
//
// Exits 1 while the reverted change comes back.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "squash-audit-"));
const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=audit", "-c", "user.email=audit@example.invalid", ...args], { encoding: "utf8" });
const page = join(dir, "page.html");
const line = () => readFileSync(page, "utf8").split("\n")[1];
try {
  git("init", "-q", "-b", "main");
  writeFileSync(page, "one\nThe original sentence.\nthree\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "edits");
  writeFileSync(page, "one\nTom's edited sentence.\nthree\n");
  git("commit", "-q", "-am", "Save from the editor");
  git("switch", "-q", "main");
  git("merge", "--squash", "-q", "edits");
  git("commit", "-q", "-m", "Pull request squashed and merged on GitHub");
  writeFileSync(page, "one\nThe original sentence.\nthree\n");
  git("commit", "-q", "-am", "A Claude session reverts the sentence on main");
  const [behind, ahead] = git("rev-list", "--left-right", "--count", "main...edits").trim().split(/\s+/).map(Number);
  // What load() does: delete edits when it is 0 ahead, else merge main into it.
  git("switch", "-q", "edits");
  git("merge", "-q", "--no-edit", "main");
  const result = { editsAheadOfMain: ahead, editsBehindMain: behind, editorDeletesEdits: ahead === 0, mainSays: "The original sentence.", editsSaysAfterAutoMerge: line() };
  console.log(JSON.stringify(result, null, 1));
  const back = result.editsSaysAfterAutoMerge !== result.mainSays;
  console.log(back ? "UNSAFE: the reverted sentence is back on edits, and the next Publish would put it on main again." : "SAFE: the revert holds.");
  process.exitCode = back ? 1 : 0;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
