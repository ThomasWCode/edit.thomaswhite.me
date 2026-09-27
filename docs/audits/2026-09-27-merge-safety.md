# Merge feature and data-safety audit, 27 September 2026

The question: can the merge feature (bringing `main` into `edits`, pull request #4 `keep-up-with-main`) or any other feature of the editor and the site repositories ever delete, corrupt or overwrite edits, in `main`, in `edits` or anywhere else?

**No, that can't be claimed.** The save path itself is sound: a Save never overwrites a newer commit on `edits`. But four paths lose or overwrite edits silently in ordinary or plausible use, and several narrower ones exist. Each is reproduced by a script in [`2026-09-27-merge-safety/`](2026-09-27-merge-safety/).

Nothing was fixed. Nothing was written to `main` or `edits` in any repository; the live repositories were only read.

## Scope and method

- **Code read in full:** `src/publish-flow.js`, `src/github-client.js`, `src/app.js`, `src/working-store.js`, `src/drafting.js`, `src/structure.js`, `src/markdown-files.js`, `dev/fake-github.js`, the relevant parts of `src/edits.js`, `src/describe.js`, `src/editor.js` and `src/auth.js`.
- **Site repositories:** every workflow in both, `scripts/drafts.mjs`, the content review, `AGENTS.md`, and `docs/implementation-notes.md` §6 (the content-strategy merge).
- **Claims checked against GitHub's REST documentation:** Merge a branch, Update a pull request branch, Merge a pull request, and the permissions GitHub Apps need.
- **Reproductions, three kinds:**
  - the real publish flow against the fake GitHub;
  - git's own merge (merge-ort, as GitHub uses it) on the fixture pages;
  - the real editor in Chromium through the e2e harness.
- **Live state, read only:** branches, open pull requests and merge settings of both site repositories.

## Findings

| # | Severity | What | Status |
| --- | --- | --- | --- |
| 1 | High | Edits made while a Save is still running are silently discarded: a block finished on a page, any typing in the Record and blog-source tabs | Reproduced in Chromium |
| 2 | High | Publishing a waiting `replace` draft undoes a change merged from `main` into its live element | Reproduced: 94 of 128 cases |
| 3 | Medium | Unsaved edits to a file renamed or deleted on GitHub disappear after "Reload those files" | Reproduced in Chromium |
| 4 | Medium, conditional | A squash or rebase merge on GitHub, then a revert on `main`: the auto-merge brings the reverted change back | Reproduced with git |
| 5 | Low | The documented branch-delete race is wider than documented; the lost save was reported "Saved" | Reproduced against the fake |
| 6 | Low, latent | The live build strips any element whose attribute *value* mentions `data-draft` | Reproduced; nothing triggers it today |
| 7 | Low | Pull request text below the generated list, and title or note changes made on GitHub, are overwritten | From the code |
| 8 | Low | The monthly content review overwrites the open review issue's body, ticked boxes included | From the workflow |
| 9 | Low | A reload while a block is being typed can drop up to 0.8 s of typing | From the code |
| 10 | Medium, process | Content-strategy merge: nothing enforces the no-save window; step 6 silently changes the preview's `CNAME` | From the procedure and git |
| 11 | Unverified | GitHub may refuse the auto-merge on today's `edits`, which lacks `main`'s new workflow file (no data loss either way) | Needs one live check |

### 1. Edits made while a Save is running are discarded

**What happens:**

- Save commits the text each file had when Save was pressed.
- When GitHub answers, `doSave` (`src/app.js:1064-1078`) sets every saved entry's `working` and `original` to that older text, and `originalModel` to the current model.
- Anything made on those files in the meantime no longer counts as unsaved. The Save button reads "Save", and the sessionStorage copy is removed.
- On a page, this hits a block finished (Enter, or a click elsewhere) during the save. A block still being typed when the save ends is unaffected.
  - The preview still shows the words, but closing or reloading the tab loses them without a warning, because nothing is dirty.
  - They come back only if another edit is made to the same page first, since commits build on `entry.model`.
- In the Record and blog-source tabs, every keystroke counts, and the textarea is reset (`src/app.js:1078`): the words vanish from the screen.

**When:**

- Any time Tom keeps typing after pressing Save; nothing blocks editing while GitHub answers.
- The window is all of `flow.save`, follow-up reads included: at least seven sequential requests. With a pull request open, the description is also rebuilt from every changed file before Save returns.

**Evidence:** `typing-during-save.spec.mjs` (both tests fail today):

- **Record tab:** the line typed during the save is gone from the box, from sessionStorage and from GitHub.
- **Page:** the paragraph is shown but not counted, not stored, and gone after a reload.

**Direction (not implemented):**

- After a save, reset only the entries whose `working` still equals the text that was saved. For the others, advance `original` and `loadedSha` and keep them dirty.
- Rebuild `originalModel` from the saved text.
- Leave a Markdown box alone if it changed. Or make the preview and textarea read-only while saving.

### 2. Publishing a `replace` draft undoes changes merged from `main`

**What happens:**

- In Drafts mode a change to live element L is saved as a copy L′ straight after it, marked `data-draft="replace"`.
- If `main` then changes L (a Claude session fixing a word, say), git merges the two cleanly whenever the lines differ: L′ is inserted after L, and `main`'s change is inside L.
- The merge happens on the next editor load (the auto-merge), on Update from main, or at the pull request's own merge.
- "Publish new version" (`publishDraft`, `src/drafting.js:341-347`) then cuts L, with `main`'s change, and keeps L′, which was copied from the old L. It checks only that the element before L′ has the same tag and is not a draft.
- Nothing warns. The Save dialog's line hunks show the change being reverted, but as part of Tom's own edit.

**Evidence:** `replace-draft-merge.mjs`, over 128 blocks of 8 fixture pages. Each had a replace draft for one word on `edits` and a different word of the same element changed on `main`:

| Outcome | Cases |
| --- | --- |
| git merged cleanly | 94 |
| … and publishing the draft lost `main`'s change | 94 of those 94 |
| git conflicted (the editor asks for a Claude session) | 34 |
| `main` deleted the live element instead: git conflicted | 127 of 127 |

So cutting the wrong element was not observed.

**Contradicts:**

- the site's `AGENTS.md`, "Editor": "A file changed elsewhere … shows there as a conflict, never as an overwrite";
- the editor's `refuseWaitingChange`, which protects L from the editor's own changes only.

The site's `AGENTS.md` "Drafts" does not tell a Claude session that changing L also means changing L′.

**Direction:**

- Record in L′ what L was when the draft was made (a hash of L's source, say). Refuse or warn at "Publish new version" when L has changed since, showing the difference.
- Add a rule to the site's "Drafts" section for Claude sessions.
- The auto-merge could also name any live element with a waiting version that the merge changed.

### 3. Unsaved edits to a file that is no longer on GitHub disappear

**What happens:**

- After a reload, `syncEntries` (`src/app.js:171-193`) builds the file list from the tree. It keeps sessionStorage records only for files marked new (`isNew`).
- A file with unsaved edits that was renamed or deleted upstream therefore drops out of the list. No kept-aside notice appears anywhere, and Save shows nothing unsaved.
- The text survives only in a sessionStorage key the interface never reads, and that dies with the tab.
- The conflict dialog had just promised that "Reload … keeps your unsaved edits to them aside" (`src/app.js:1096`).
- Side effect: that hidden key makes `nothingUnsaved()` false for the rest of the tab's life, so the tab silently never auto-merges again.

**When:**

- A Claude session renames or removes a page or blog source while Tom has unsaved edits to it.
- Or `edits` is deleted while it held a file created there that Tom is editing.

**Evidence:** `file-gone-upstream.spec.mjs` fails today: after "Reload those files" no blog source shows the kept-aside edits, and Save reads "Save".

**Direction:** keep stored records for vanished files and show them as kept aside ("no longer on GitHub"), with the text to copy.

### 4. After a squash or rebase merge, the auto-merge can resurrect a reverted change

**What happens:**

- The editor always merges its pull request with a merge commit. But both site repositories allow "Squash and merge" and "Rebase and merge" (`allow_squash_merge` and `allow_rebase_merge` are true, read from the API today), so GitHub's own merge button offers them.
- After a squash or rebase, `edits`' commits never become ancestors of `main`: `load()` sees `edits` ahead and never deletes it (`src/publish-flow.js:243-247`). It merges `main` in instead.
- If `main` has meanwhile reverted one of Tom's changes, git sees that side of the revert as unchanged since the merge base and keeps Tom's version.
- The next Publish puts it back on `main`, undoing the revert. The pull request lists it as an ordinary change.

**Evidence:** `squash-revert.mjs`: after squash, revert and auto-merge, `edits` again holds the reverted sentence.

**Direction:**

- Turn off squash and rebase merging in both site repositories (Settings → General → Pull Requests).
- Or have `load()` recognise a merged pull request whose branch isn't an ancestor of `main`, and reset `edits` when its tree adds nothing to `main`'s.

### 5. The branch-delete race is wider than documented

**What happens:**

- `load()` deletes an `edits` that holds nothing `main` lacks. It decides from the SHA read first, then lists open pull requests, compares that SHA, and deletes the branch (`src/publish-flow.js:240-247`).
- A save from another device that lands anywhere after that first read is deleted with the branch. That device had already said "Saved" and cleared its stored copy.
- If that device edits the same file again, its next Save reports a conflict with its own lost work, and "Reload those files" replaces the file with `main`'s version. Otherwise the loss goes unnoticed.
- `merge()` re-reads just before deleting (`src/publish-flow.js:503-505`), so its window is one round trip.
- `docs/how-it-works.md:249` documents the limit as "a second at most … between the check and the delete". The window really starts three requests earlier.

**Evidence:** `delete-race.mjs`: a second save landing during the pull-request lookup, or during the compare, is gone from every branch in both timings.

**Direction:**

- Re-read the ref just before deleting in `load()`.
- Better, never delete: fast-forward `edits` to `main` with `force: false`. A concurrent save makes that update fail instead of being lost, and a branch equal to `main` is harmless.
- The same works after `merge()`.

### 6. The live build strips elements whose attribute values mention `data-draft`

**What happens:**

- `scripts/drafts.mjs` in the site repositories finds the marker with a regular expression over each start tag's raw attribute text, quoted values included (`draftAttribute`, line 37, used in `opened()`).
- So `<p title="how data-draft works">`, `<img alt="… data-draft …">` or `<a aria-label="… data-draft …">` counts as a draft. The "Publish the live site" workflow leaves the whole element out of thomaswhite.me.
- The editor reads real attributes and reports the element as live, so its descriptions and checks don't see the loss. The preview repository's CI doesn't strip, so it can't see it either.

**Evidence:** `drafts-attribute-value.mjs`: 3 of 3 live elements are removed by the site's code and kept by the editor's. No file has such a value today (searched).

**When:** alt text, a caption, a label or a meta description that mentions the attribute, for example in the "How this site works" post. That includes alt text typed in the editor's image panel.

**Direction:**

- Match the attribute name only outside quoted values: lex attributes properly, or parse with parse5 in the build.
- Add a contract case with such a value.

### 7. Pull request text is overwritten

- **Every Save with a pull request open** rewrites its description (`refreshPr`, `src/publish-flow.js:213-219`). `noteOf` (`src/describe.js:657-663`) keeps only the text *above* the generated list. Anything added on GitHub below the list, or inside it, is replaced.
- **"Update title and description"** and a Publish onto an already-open pull request send the dialog's title and note as they were when the dialog opened. A title or note changed on GitHub since is overwritten, and an emptied note box sends an empty note.
- The first point is partly documented ("keeping your note"); the second isn't.

### 8. The content review overwrites the open review issue

`.github/workflows/content-review.yml:55-57` finds the first open issue titled "Content review: …" and replaces its title and whole body with the new report. The report is a checklist (`- [ ]`), so boxes ticked on an issue left open are reset each month. Comments are unaffected.

### 9. A reload while a block is being typed

- `reload()` (`src/app.js:1346-1359`) replaces entries whose file changed on GitHub before `open()` finishes the block being typed.
- The finished block is then committed to nothing (`commitBlock` finds the new, unloaded entry).
- Typing older than 0.8 s reaches sessionStorage and is kept aside; the last 0.8 s is lost.

Background triggers: following a pull request merged or closed on GitHub, the reload after Publish, and the reload after Update from main. Low impact.

### 10. Content-strategy merge procedure

- **Between steps 2 and 7** of the site's `docs/implementation-notes.md` §6, nothing stops a save through the editor. It would land on the preview repository and miss the merge.
- After step 7 the editor targets the main repository, whose sessionStorage scope is different. Unsaved work for the preview is then invisible too.
- **Step 6** ("pull `main` … into it (and keep its own `CNAME`)") relies on the operator. The revert of `f2e3fc3` is the only change to `CNAME` on either side since the merge base, so a plain pull merges it without a conflict: the preview's `CNAME` silently becomes `thomaswhite.me`.
- What GitHub Pages then does with a domain another repository already serves could not be checked here; at best the preview breaks.
- **Verified safe:**
  - `f2e3fc3` touches only `CNAME`;
  - the main repository is still at `49b9582`, the fork point, so step 3's `git merge main` is a no-op;
  - the merge overwrites nothing on `main`.

### 11. Unverified: GitHub may refuse the auto-merge on today's branch

- The App has no Workflows permission (`docs/setup.md:28`).
- GitHub's permission table lists branch-ref updates (`POST`/`PATCH /git/refs`) as needing Workflows in addition when workflow files change. It lists `POST /merges` under Contents only, so for merges it is undocumented.
- Since today's `edits` branched, `main` has added `.github/workflows/pages.yml`.
- If GitHub applies the rule to merges, every load and every Update from main fails on this branch: "couldn't be brought in just now", or an error. Nothing is lost, but the feature does nothing until the branch is published.
- The fake GitHub has no permissions, so the tests can't show it.
- **Direction:** one live check on a throwaway branch before relying on it.

## Assumptions of the merge feature

| Assumption | Verdict | Evidence |
| --- | --- | --- |
| Nothing runs on GitHub when `main` is merged into `edits` without a pull request | True today | `ci.yml` runs on `pull_request`, `push` to `main`, dispatch; `pages.yml` on `push` to `main`; the rest on schedule or dispatch (both site repositories) |
| `POST /merges` makes the merge commit at once; 204 when already merged, 404 when a branch is missing, 409 on a conflict | True | GitHub's REST reference, as mapped in `github-client.js` |
| A clash leaves `edits` as it was | True | The merge is refused whole; nothing is written |
| "Both changed the same lines" is when GitHub refuses | True for git; the fake refuses whenever both changed the same *file* | `dev/fake-github.js:173-189`; so no test covers a clean merge of one page from both sides, which is where finding 2 lives |
| A lost answer is recovered by re-reading `edits` | True, but another device's save also reads as "brought in" (a wrong notice, nothing lost) | `src/publish-flow.js:256-262` |
| Update branch answers before merging, so waiting for `edits` to move is enough | Mostly; a concurrent save also moves it and ends the wait early (a wrong notice, protected by the conflict check) | GitHub's reference (202); the fake merges synchronously |
| A stale page never overwrites `main`'s changes | True for Save (whole-file blob check against the head, fast-forward-only ref update); false for replace drafts (2) and after squash merges (4) | `src/publish-flow.js:299-333` |
| "Nothing unsaved" gates the auto-merge | True for this tab (typing, dirty entries, stored records); other tabs' unsaved edits then conflict and are kept aside, to be redone by hand | `src/app.js:1343` |
| `ahead_by == 0` tells when `edits` has been published and can go | True only when pull requests are merged with a merge commit (4); deleting on it is racy (5) | `src/publish-flow.js:245-247` |
| The editor's view of the live page equals the site's build | True for every kind the editor writes: 925 comparisons, no difference; false for attribute values (6) | `live-equivalence.mjs` |
| The App can merge branches | Contents write: yes. Workflows: unverified (11) | `docs/setup.md:28` |

## Verified safe

- **Saves never overwrite a newer `edits`.** Each file's blob on the head must be the one the edit started from; the ref update is fast-forward only (`force: false`), retried from the new head; a retried save doesn't commit twice.
- **The auto-merge** runs only with no pull request and nothing unsaved in the tab. It uses GitHub's merge, never a force, and leaves `edits` alone on a clash.
- **Another tab's unsaved edits** to files the merge changed become conflicts, kept aside, never overwrites (commit `21a325d`).
- **The pull request merge** passes the checked head SHA (409 if it moved), and `edits` is deleted only if it is still that head.
- **The baseline workflow** pushes without force, so a concurrent save makes it fail rather than be overwritten, and it never runs on `main`.
- **Text edits and attributes** re-parse and verify every change, and the property tests over every fixture block pass. **Structural changes** are re-parsed; removing a paragraph asks first and is undoable, and locked parts can't be removed.
- **Sign-out** clears only the session, not unsaved work. Leaving the page commits the block being typed first.
- **sessionStorage's quota** is not a realistic limit: the whole site's HTML and Markdown come to about 406 KB, against about 5 MB.
- **No site file** holds a BOM or a CR today; the editor would drop a BOM silently if one appeared (`TextDecoder`).

## The live branch today (read only)

- The preview repository's `edits` holds 8 saves from 26 September and is 19 commits behind `main`, with no open pull request. The next editor load with nothing unsaved will try the auto-merge.
- Simulated with git, that merge is clean. The 6 pages Tom edited come out byte for byte as on `edits`, and the result passes all 96 of the site's static contracts.
- `main`'s side includes the new `.github/workflows/pages.yml` (finding 11).
- Both site repositories: merge commits, squash and rebase all allowed; merged branches kept; no open pull requests.

## Test results

- **Editor unit tests:** 166 of 166 pass (Node 24.21.0).
- **Editor browser suite:** 22 of 23 pass in Chromium. It ran on Chromium build 1194 through `executablePath`, because this sandbox lacks the pinned build 1243.
  - The failure, "a placeholder still asks before Done after an item is added above it", passed on one of two re-runs. It is a toolbar visibility flake, not data-related.
  - Firefox and WebKit were not run.
- **The audit's scripts:** four report the unsafe behaviour and exit 1 (`replace-draft-merge`, `squash-revert`, `delete-race`, `drafts-attribute-value`). `live-equivalence` passes. The three browser tests fail as described.

## Reproducing

Install first:

- Node 24;
- git 2.38 or later (for `git merge-tree --write-tree`);
- the editor's tools: `npm ci`, then `npx playwright install chromium`;
- the site repository checked out next to this one as `ThomasWCode.github.io-revised`, or its path in `SITE_REPO`.

From this repository's root:

```bash
node docs/audits/2026-09-27-merge-safety/replace-draft-merge.mjs     # finding 2
node docs/audits/2026-09-27-merge-safety/squash-revert.mjs           # finding 4
node docs/audits/2026-09-27-merge-safety/delete-race.mjs             # finding 5
node docs/audits/2026-09-27-merge-safety/drafts-attribute-value.mjs  # finding 6 (needs the site repository)
node docs/audits/2026-09-27-merge-safety/live-equivalence.mjs        # the equivalence assumption (needs the site repository)
npx playwright test --config=docs/audits/2026-09-27-merge-safety/playwright.config.mjs   # findings 1 and 3
```

- Each script exits 1, and each browser test fails, for as long as its finding stands. They are outside `tests/`, so `npm test` and CI don't run them.
- Where Playwright's own Chromium is missing, set `CHROMIUM_PATH` to another Chromium.

## Limits of this audit

- **No live GitHub writes:** the App's token was not used. What only the live GitHub can show is marked unverified:
  - whether the Workflows rule applies to merges;
  - update-branch's asynchronous merge with a concurrent push;
  - Pages with an already-claimed `CNAME`.
- **The flow-level reproductions use the fake GitHub.** Its whole-file merge is replaced by git's own merge wherever that matters (findings 2 and 4).
- **Not run:** the site's browser, visual and Lighthouse suites.
