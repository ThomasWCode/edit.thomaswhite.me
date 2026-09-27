// Git's own three-way merge of one file, as GitHub makes it (merge-ort, through
// `git merge-tree --write-tree`), for the audit's scenarios. The fake GitHub
// merges whole files instead: both sides changing one file is a conflict there,
// never a clean merge of different lines.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Returns { clean, text } for `ours` (edits) and `theirs` (main) from `base`.
export function gitMerge(base, ours, theirs, name = "page.html") {
  const dir = mkdtempSync(join(tmpdir(), "merge-audit-"));
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=audit", "-c", "user.email=audit@example.invalid", ...args], { encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, name), base);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("switch", "-q", "-c", "edits");
    writeFileSync(join(dir, name), ours);
    git("commit", "-q", "-am", "edits");
    git("switch", "-q", "main");
    writeFileSync(join(dir, name), theirs);
    git("commit", "-q", "-am", "main");
    let tree;
    try {
      tree = git("merge-tree", "--write-tree", "edits", "main").split("\n")[0];
    } catch {
      return { clean: false, text: null };
    }
    return { clean: true, text: git("show", `${tree}:${name}`) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
