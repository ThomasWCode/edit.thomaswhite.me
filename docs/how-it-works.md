# How the editor works

What was built, in enough detail to change it safely. The approved plan is [`plan.md`](plan.md); where this file and the plan differ, this file describes the code. The owner's one-time setup is [`setup.md`](setup.md).

## The pieces

| Piece | Where | What it does |
| --- | --- | --- |
| Editor site | this repository, published by GitHub Pages at `https://edit.thomaswhite.me` | Static page: `index.html`, `editor.css`, `frame.css`, ES modules in `src/`, the vendored parser in `vendor/`. No framework, no build step, no runtime CDN. |
| Sign-in Worker | `worker/index.mjs`, deployed as `site-editor-auth` to `https://site-editor-auth.thomaswhite.workers.dev` | Holds the GitHub App's client secret and does the OAuth handshake; holds the Groq key and answers the AI suggestions (`/describe`). Stores nothing. |
| GitHub App | "Homepage Site Editor" (App ID 5079588, client ID `Iv23lixP9BDtnDivY3vr`), owned by ThomasWCode | Installed on the target repository only. Its user tokens can do what Tom can do, and only in installed repositories. |
| Target repository | `src/config.js`, `active` | `ThomasWCode/ThomasWCode.github.io-revised` (published at `new.thomaswhite.me`) until the content-strategy merge, then `ThomasWCode/ThomasWCode.github.io` (see "Switching targets"). |

Browser modules (`src/*.js`) load in the page; files ending in `.mjs` (scripts, Worker, tests) run in Node. The pure modules run in both, which is how the unit tests cover them.

| Module | Role |
| --- | --- |
| `editor.js` | Entry point: sign-in, then `app.js`. `?mock=1` on loopback swaps GitHub for the fake. |
| `app.js` | The signed-in editor: open files and their working copies, undo, the change log, the file list, the side panel, and the Save and Publish dialogs. |
| `preview.js` | The preview frame: render, listen, one editing block at a time, the toolbar. |
| `dom-snapshot.js` | Reads an edited block out of the DOM. |
| `auth.js` | Stores and refreshes the session; signs out. |
| `github-client.js` | The REST calls, with retry after a 401 and coded errors. |
| `publish-flow.js` | Load, Save, Publish, checks, merge. |
| `page-model.js` | Parses a page and finds its blocks, locks and markers. |
| `render-copy.js` | The copy of a page the frame shows. |
| `snapshot.js`, `text-merge.js`, `sequence-diff.js`, `splice.js`, `edits.js` | Turning a typed change into the smallest source change. |
| `structure.js` | Adding and removing paragraphs and list items. |
| `drafting.js` | Drafts: changes kept off thomaswhite.me until published, publishing and discarding them, and the page as thomaswhite.me will serve it. |
| `checks.js` | The pre-save checks. |
| `diff-view.js` | The Save dialog's word runs and line hunks. |
| `describe.js` | What changed, in words: commit messages, pull request titles and descriptions, and what the AI suggestions may see. |
| `suggest.js` | Asks the Worker's `/describe` for an AI suggestion. |
| `markdown-files.js` | The Record and blog-source tabs. |
| `site-files.js` | Which files are pages, their order and labels, and which are read-only. |
| `config.js` | The targets, the Worker URL and the App's public identifiers. |
| `dialogs.js`, `dom.js`, `working-store.js` | Dialog helpers, a safe element builder, the sessionStorage mirror of unsaved edits. |

## Signing in

1. **Sign in with GitHub** sends the browser to the Worker's `/login?return_to=<editor origin>`. The Worker accepts only the exact origins in `EDITOR_ORIGINS` (`https://edit.thomaswhite.me` and `http://127.0.0.1:4174`), makes a random `state` and a PKCE verifier, keeps both in a `__Host-editor_oauth` cookie (HttpOnly, Secure, SameSite=Lax, ten minutes) and redirects to GitHub's authorize page with `code_challenge` (S256) and `login=ThomasWCode`.
2. GitHub returns to `/callback?code&state`. The Worker checks the state against the cookie, exchanges the code (form-encoded body with `client_id`, `client_secret`, `code`, `redirect_uri`, `code_verifier`; GitHub answers errors with HTTP 200 and an `error` field), reads `GET /user` and requires both the numeric id (172206513) and the login (ThomasWCode). A stranger's grant is revoked and they see a 403 page. GitHub errors (a cancelled sign-in, an expired code) go back to the editor as `#error=<code>`.
3. The Worker redirects to `<editor>/#access_token=…&expires_in=…&refresh_token=…&refresh_token_expires_in=…&login=…&user_id=…`. The fragment never reaches a server or a log. `auth.js` stores the session in `localStorage["siteEditor.session.v1"]` (expiries a minute early) and removes the fragment with `history.replaceState`.
4. Access tokens last eight hours. Five minutes before expiry `auth.js` posts the refresh token to the Worker's `/refresh` inside a Web Lock (`siteEditor.refresh`), re-reading storage first because another tab may have rotated the pair already; GitHub rotates the refresh token every time. The old one is spent as soon as GitHub answers, so the Worker retries the `GET /user` check after it twice (after 250 milliseconds and a second) on a network error, a 5xx or a 429, rather than lose the new pair to a passing failure. After a 401 from GitHub the client forces one refresh and retries once. A rejected refresh token signs the tab out; unsaved edits stay in sessionStorage.
5. **Sign out** clears the device, then asks the Worker to revoke the token; **Sign out everywhere** revokes the whole grant (every device). A lost device can also be cut off at github.com/settings/apps/authorizations.

Why localStorage and not a cookie: a refresh-token cookie would be a third-party cookie on `workers.dev`, which Safari blocks and Firefox partitions. The defence is that nothing can run script on the editor's origin: a strict CSP, no inline or third-party script, and a preview frame that runs no script at all.

The Worker answers `GET /` with `site-editor-auth is running. Client secret: set. AI suggestions: on (openai/gpt-oss-120b).` (or `missing`, `off`), which is the quickest check after a deploy or a secret change. Every response carries `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`; `/refresh`, `/logout` and `/describe` answer CORS only for the exact editor origins.

## From a click to a one-line diff

**Loading.** `publish-flow.load` reads `edits` if it exists, otherwise `main`, and that commit's whole tree (path → blob SHA). An `edits` holding nothing `main` lacks, with no pull request open, is deleted first: a pull request merged on GitHub itself leaves its branch behind (the site repositories keep merged branches), and loading it would show an older copy of the site. Files are read as blobs by SHA (the JSON form, base64, which `api.github.com` always serves itself; decoded as strict UTF-8), so the bytes always match the SHA kept for stale-file detection. The open page loads first; the rest follow in the background, four at a time, for their titles, draft counts and the site-wide checks.

**Parsing** (`page-model.js`). Files must be LF (a `\r` is refused) and start with the three-line front matter. The front matter is blanked (every character but newlines becomes a space) rather than stripped, so parse5's offsets are file offsets. Every element under `main#main-content` gets a key: its element-child index path from `main` ("3.0.1"). `main` holds no scripts or comments (a test checks every fixture), so parse5's tree and the browser's agree. A page without front matter, without `main`, or with an element under `main` lacking an explicit end tag is read-only, as are the CV and the three redirects (`lockedFiles`).

**Blocks.** A block is what one person types in one go. From `main` down: hidden elements (`hidden`, `aria-hidden="true"`) are ignored; form controls, buttons, media and the like are locked regions (images inside them still open in the panel); elements with no text are skipped; an element with a block-level descendant is recursed into; a block-level element with no text of its own and only inline children is recursed into (a compact-list item gives its label, text and arrow link separately); anything else is a block. An inline parent stays one block, so text can be typed after a `<cite>` inside a compact-list span. Every fixture page has no text outside a block (tested).

**Locks**, each with its reason in the panel: everything outside `main` (the shared header and footer); the `h1` (the test manifest and the status-page monitor pin it); any block containing "I was honestly so impressed" (Analisa's words are contract-tested); the Now section's "Updated Month Year" line (set by the Now helper); proof-block `h4` labels; forms, buttons and media.

**The preview** (`render-copy.js`, `preview.js`). The copy is spliced, never re-serialised: every `script`, `noscript`, `base` and `meta http-equiv` removed; a `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; form-action 'none'">` and `<base href="<site>/">` first in `<head>`; `frame.css` last in `<head>` by absolute URL; `data-edit-key` on every element under `main`, `data-edit-role` (block, locked, draft-note, draft-inline, draft-check, draft-new, draft-replace, draft-remove, link, image, gallery) where it applies, `tabindex="0"` on editable blocks and images, and `data-editor` on `<html>` (the site's stylesheet then shows a live element and its drafted new version side by side; see "Drafts"). It is set as the iframe's `srcdoc`, so it shares the editor's origin and CSP (`frame-src 'self'`; `base-uri` names both site origins). There is deliberately no `sandbox` attribute: WebKit does not deliver events to listeners the parent attaches inside a sandboxed frame without `allow-scripts` (WebKit bug 218086), which would break editing on an iPhone. The frame runs no script anyway. Listeners are attached when the frame's document is parsed (`DOMContentLoaded`), not at `load`, so a click on the visible page is never lost while images load; scroll and focus are restored at `load`, instantly, because the site sets `scroll-behavior: smooth`. `frame.css` also hides the site's phone menu at 1024 pixels and below, which the site's own script would have closed on load.

**Editing.** One block at a time is `contenteditable`: `mousedown` (or keyboard focus) on an editable block finishes the previous one and starts this one, and focuses it before the click places the caret (Firefox otherwise leaves focus on the frame's body when the click follows one on the editor's own buttons); Enter, Shift+Enter, Escape, Tab or clicking elsewhere finishes it. `beforeinput` lets through only typing, composition, spelling replacement, deletions and undo/redo; formatting, line breaks, lists, links and drops are cancelled. A paste is cancelled at the `paste` event and its plain text inserted with `execCommand("insertText")` (newlines become spaces), which keeps native undo; `insertFromPaste` is handled the same way as a fallback. Every click inside the frame is cancelled (with the `<base>`, a link would otherwise navigate to the live site) and reported as a selection: a link or image opens in the panel, a locked part shows its reason.

**Committing a block** (`edits.commitTextEdit`). The block is read from the DOM as a snapshot (`dom-snapshot.js`); `snapshot.sanitise` maps non-breaking spaces to spaces, drops Chrome's `<br>` in an emptied block, unwraps elements the browser created that carry only a `style` attribute, and merges adjacent text. Nothing visible changed → no-op. The same element skeleton (by key) → each text slot (the text between two tags) is merged with `text-merge.mergeText`: both texts are split into words, a Myers diff (`sequence-diff.js`) finds what changed, unchanged words are re-emitted exactly as written with the whitespace before them (so `&amp;`, curly quotes and line wraps stay byte-identical), inserted words are escaped (`&`, `<`, `>` only) and joined with single spaces, and around a changed run the separator carrying a line break is kept, so a one-word edit changes one line. Whitespace just inside the block's own tags is formatting and kept; whitespace next to an inline element (a link, `<strong>`, a draft span) is visible and follows what was typed. No line ends in spaces afterwards (html-validate's `no-trailing-whitespace`). A changed skeleton (a deletion took a link or a `<strong>` with it) → the block's inner HTML is re-serialised, reusing each surviving element's original start and end tags verbatim, and the frame re-renders. Every commit re-parses the result and checks the block's tag, start tag, structure and text against what the browser showed, the bytes before and after the block, and the element count; any difference refuses the edit (the block resets and the typed text is offered for copying).

**Attributes and drafts** (`edits.js`). Setting an attribute splices only its value between the quotes, or adds it after the last attribute (on its own line, with the tag's indentation, when the tag spans several lines); removing one takes the whitespace before it. **Done** on a draft note removes `data-draft` and the `draft-note` class token (a class list like `draft-note prose` keeps `prose`); **Done** on an inline slot removes the span's start and end tags and keeps its text, prettier's hugging `</span\n>` included; **Approve** removes `data-draft="check"` and nothing else. Done on a draft whose text is still the placeholder asks first; the placeholder is recognised by its text among the drafts as loaded, since adding or removing an item above a draft shifts its key. The **Now helper** sets `data-updated` and the "Updated Month Year" line together. The new-tab and same-tab fixes set or remove `target="_blank"` and add or remove only the `noopener` and `noreferrer` tokens of `rel`, keeping any others (`nofollow`, `author`); a `rel` left empty is removed.

**Paragraphs and list items** (`structure.js`). **+** inserts a copy of the list item or plain paragraph after it: same tag and attributes (a dated compact-list item keeps `data-record`, `data-when` and `data-review`, which the contracts require, plus its label and text spans, without its arrow link), minus draft markers and the `id`, with "New paragraph" or "New item" selected for typing over, at the block's own indentation. Paragraphs with a styling class (eyebrows, the hero lede) are not copied. **×** removes the item with its lines when it has them to itself; removing a list's last item asks first. Headings cannot be added. Every change pushes the page's source onto its undo stack (Undo in the top bar); Save clears it. Once an item has been added or removed, keys no longer name the same elements as in the file as loaded, so **Revert this block** is not offered until the next Save or Discard (or an Undo back past the change); the action log records it, so this survives a reload.

**Unsaved work** is mirrored to sessionStorage per file (`working-store.js`) with the blob SHA it started from, so a reload or a sign-in round trip keeps it. The block being typed is mirrored too, 800 milliseconds after the last keystroke, without finishing it. If the file (a page or a Markdown file) changed on GitHub meanwhile, the old edits are not applied: they are kept aside, across reloads, and the panel shows them as a diff for copying until they are discarded. New typing, a Save and further changes on GitHub all leave them there (a second set joins the first).

**Markdown tabs** (`markdown-files.js`). The Record (`docs/record.md`) and each blog source (`docs/blog-sources/*.md`, not the README) open in a plain textarea and save in the same commit as pages, with LF endings and one final newline (an emptied file is refused at Save). **New post source** creates `docs/blog-sources/<slug>.md` from the README's conventions: the eyebrow line (month, year and age, computed from the birth date in the record), the title, a lede, a `##` section and a Related list.

## Drafts

A draft is saved to the site but left out of thomaswhite.me until it is published. The rule is the site's (its `AGENTS.md`, "Drafts", and `scripts/drafts.mjs`): an element marked `data-draft` is a draft. The workflow that builds thomaswhite.me ("Publish the live site", the site's `.github/workflows/pages.yml`) leaves drafts out, except that a `remove` draft only loses its marker. The preview site, `new.thomaswhite.me`, is GitHub's automatic build and shows drafts as written, styled by the site's stylesheet. `drafting.js` writes three kinds:

- `new`: content that isn't live. It was added as a draft, is a phrase kept off the site, or is live content taken off until it is published again.
- `replace`: a new version of the live element straight before it. The live one stays until the draft is published.
- `remove`: live content that goes when the draft is published.

Placeholders (`draft-note`, `draft-inline`) and `data-draft="check"` come from the content-strategy work and are still finished with Done and Approve.

**Draft mode.** The **Drafts** toggle in the top bar, remembered for the tab, keeps every change to live content as a draft:

- **Typing, a link's address or tab, alt text, a caption or the Now month** (`asDraft`): the smallest whole element around the change stays as it is. The changed version goes in a copy straight after it, marked `replace`. That element is a link, paragraph, list item, heading, quote, figure, picture, list, table, details, section or article.
  - The copy's ids become `data-draft-id`, so no id is on the preview twice; publishing names them back.
  - The copy goes on lines of its own when the live element has its lines to itself, as the site's build cuts drafts. Otherwise it hugs the live element, so leaving it out or publishing it adds no whitespace.
  - When that element holds something the site pins (the h1, Analisa's words, a proof label), only the changed block is copied. The home page's portrait note shares its section with the h1, for example. If neither can be copied, the change is refused and what was typed is shown for copying.
  - Until the new version is published or discarded, the live element stays as it is, drafts on or off. A block is locked, with its reason in the panel, and dimmed in the preview. A link or image says why in its panel instead of offering changes. Any other change that would touch it is refused (`refuseWaitingChange`): published, the new version would undo the change, and as a draft it would make a second version. When the Now section has a new version waiting, the Now helper sets that version.
- **+** adds the paragraph or item as a `new` draft, unless it lands inside a draft already. After an element that is itself a draft it lands outside it, so it gets its own marker.
- **×** marks the block `remove`, without asking, since nothing leaves the live site until the removal is published.
- **A change inside a draft** edits that draft, except in content marked to remove: that is still live, so with Drafts on a change to it is refused until **Keep it**.

**The panel's Drafts part**, with the toggle on or off:

- **Make this a draft** marks the smallest whole element around the block `new`, which takes it off the live site. **Make the section a draft** does the same to the whole section.
- With words selected in the block being typed in, **Keep them off the live site** wraps them in `<span data-draft="new">`. **Remove them when published** wraps them in `<span data-draft="remove">`.
  - The words must be in one run of text, not across a link or other formatting.
  - Left out (a `new` phrase on the live site, or a removal published), a phrase takes the spacing with it: the space before it when punctuation or the end of a line follows, so the live page never reads "a bit .".
  - Selecting the block's whole text marks the block itself.
  - The preview remembers the last selection (`selectionchange`), because clicking a panel button moves focus out of the frame.
- The page's h1 and anything holding Analisa's words can't be made drafts or marked to remove: the live page needs them. Nor can anything that holds a draft already: publishing the outer draft would leave the inner one behind.

**Publishing and discarding** are in the panel and, for the draft a block is in, the toolbar:

| Kind | Publish | Discard |
| --- | --- | --- |
| `new` | **Publish draft**: the marker goes (a phrase's span is unwrapped) | **Discard draft**: deleted, after asking |
| `replace` | **Publish new version**: the live element before it is cut, then the marker goes and ids are named back | **Discard new version**: the copy is deleted, after asking |
| `remove` | **Remove now**: deleted | **Keep it**: the marker goes |

Publishing a new version refuses if the element before it is no longer a live one with the same tag.

**What thomaswhite.me will show.** `liveSource()` leaves drafts out exactly as the site's `scripts/drafts.mjs` does, spacing included. A check of both over thousands of drafted variants of the fixture pages found them byte for byte the same. A unit test covers every block of six fixture pages: drafting a change leaves the live page unchanged, publishing the draft gives the direct edit, and discarding it gives the original.

- **Descriptions:** `describe.js` compares the live views for **Changes**, what thomaswhite.me will show once published. A draft that went was published, or discarded, by what the live views show. A new version's live element leaves when it is published, and new content arrives. Whole elements are compared, attributes deep inside included, so a draft that changed only a link's address or a caption is told apart correctly. The drafts are listed apart, under **Drafts (saved, left out of thomaswhite.me)**: new versions, new content, removals, drafts edited or discarded, and content taken off the live site. A draft commit's subject says so, for example `Home: draft add “Really.”`.
- **Checks:** the check for locked parts ignores draft copies and live elements waiting on a new version. A paragraph or list item whose words are all `new` drafts is blocked, because the live page would keep an empty element: one draft or several between them, even inside an `<em>`. The fix is to make the whole element a draft. The site's CI checks the same rules.

## Checks before Save

`checks.js` runs on every changed page when Save is pressed; every page and the record are loaded first. A file that GitHub or the network failed to deliver is tried once more; if it still can't be loaded, Save stops and says so, because the site-wide checks would be incomplete. A file that arrived but can't be read (not UTF-8, for example) is listed as a warning. A blocking finding disables the Save button; each finding can jump to its block, and several have a one-click fix.

Blocking, mirroring the site's CI (`tests/static/*.test.mjs` in the site repository), so a Save that passes here does not turn the pull request red:

- `{{` or `{%` anywhere (GitHub Pages runs pages through Liquid).
- The banned words (impressive, incredible, journey, leverage, showcase), in text and in `alt`, `content`, `title`, `aria-label` and `data-caption`; "passionate" more than once across the whole site.
- A "Year 10" to "Year 13" without a `data-review` on the element or around it.
- A `data-updated` section without its matching "Updated Month Year" (fix: the Now helper).
- A link to a site page that opens in a new tab, or any other link without `target="_blank"` and `noopener` (fix: one click either way). External redirects such as `/gravatar/` are exempt, as in CI.
- A local reference (a root path in `href`, `src`, `poster`, `data-full-src` or any `srcset` candidate; other URLs aren't checked) that is neither a page nor a file in the repository.
- A `data-record` value that is not a `### slug` heading in the record (this is how a renamed heading in the Record tab is caught).

Blocking, the editor's own: a link on a changed line to a missing `#anchor`; a relative link (the site writes every link from the root, and the local-reference check reads them that way; fix: the root form, resolved against the page's address); an emptied heading; an emptied Markdown file; any byte changed outside `main` or inside a locked block (the Now helper's line, draft copies and live elements waiting on a new version excepted); a paragraph or list item whose words are all `new` drafts (see "Drafts").

Warnings (Save still allowed): more than one exclamation mark on a page; straight quotes typed (fix: curl them); a Now line changed without its month; the call to action shared by Home, Programming, Volunteering and Contact; an emptied paragraph; a school-year mention edited (check its `data-review`); a gallery `data-caption` that no longer matches its figcaption (fix: copy it).

The Save dialog then shows, per file, the changed blocks as word runs and the raw line hunks as git will see them, plus notes on what Save and Publish will cost.

## Save and Publish

`publish-flow.js` is a state machine the interface renders: `loading → ready ⇄ saving`, and from `ready`: `baselines? → opening-pr → checking → publishable | attention → publishing → published`. One GitHub mutation runs at a time; every write re-reads the ref it depends on first.

**Save** makes one commit of every changed file on `edits` through the Git Data API (`POST /git/trees` with a `base_tree`, `POST /git/commits`, then `PATCH /git/refs/heads/edits` with `force: false`), creating `edits` from `main` when missing. The message is the one in the Save dialog's **Commit message** and **Details** boxes, prefilled by `describe.js` (see "Commit messages and pull requests"). If `edits` moved since the files were loaded, each file's blob on the new head is compared with the one loaded: unchanged (the baseline bot only touches PNGs) → the commit goes on top; changed → a conflict dialog offers to reload those files (their unsaved edits are kept aside, as above) or save the others. A non-fast-forward during the write is retried from the new head, up to three times. Each file's new blob SHA is computed before writing, and a file whose blob on the head already matches counts as saved, so a Save retried after a lost response neither reports a conflict with itself nor commits twice. Once the branch has moved, the save has happened: a follow-up read that fails (the branch summary, the pull request body) is reported as such, not as a failed save. Without an open pull request nothing runs on GitHub; with one, the push runs its CI (a person's push to a pull request's branch always does).

**Publish** (only when nothing is unsaved):

1. If a page captured by a visual baseline changed (`index.html`, `programming.html`, `gallery.html`) and the head is not already the bot's commit, it dispatches **Update visual baselines** on `edits` and polls its run (every 15 seconds, 30 minutes at most), then links the regenerated PNGs. The dispatch doesn't name its run and GitHub lists it a few seconds later, so the run followed is the first one not listed before the dispatch, never an earlier run on the branch.
2. It opens the pull request from `edits` with the title and description in the Publish dialog (which starts CI by itself), or refreshes an open one's. A commit pushed by the baseline workflow's `GITHUB_TOKEN` starts no workflow, so for an already-open pull request moved by the bot it dispatches **Test suite** (`ci.yml`). Never both.
3. It polls the pull request and the latest run of each required check ("Static contracts and lint", "Browser and visual tests", "Lighthouse budgets") every 30 seconds while the tab is visible, or at once with **Refresh**. `mergeable: null` is retried. Publishable = every required check passed and `mergeable` is true. A failed check shows its link; a failed browser job on a captured page offers **Refresh screenshots** (baselines, then CI). A conflict with `main` asks for a Claude session. **Update from main** appears when `edits` is behind; it needs everything saved, asks GitHub to merge `main` in (`update-branch`, which answers before merging), waits for `edits` to move, and reloads the files from it, so nothing is checked or saved against the old ones. **Start checks** appears when no check has started on the head (for example if `update-branch` does not trigger the workflow). A pull request merged or closed on GitHub itself is followed, on the next poll, on returning to the tab, or at start-up: merged → the published state and a reload from `main`; closed → back to ready, with the saves still on `edits` for the next Publish.
4. **Merge** passes the head SHA whose checks passed (GitHub refuses with 409 if it moved; the flow re-checks), merges with a merge commit, deletes `edits` unless another tab or device has saved on top of the merged head meanwhile (then it is kept, with those saves, for the next Publish), follows the deployment run and reloads from `main`. The deployment run is GitHub's `pages-build-deployment` for the preview site. For thomaswhite.me, once its Pages source is GitHub Actions, it is the site's **Publish the live site** workflow, which leaves drafts out.

Actions cost per publish in the site repository: about 19 Windows-weighted minutes for the pull request's CI, about 19 more for the push-to-main CI after the merge (the site's existing policy), about 3 for Pages, plus about 4 when baselines are refreshed. Saving costs nothing until a pull request is open.

## Commit messages and pull requests

`describe.js` reads each changed file as it was and as it is. For a page it lines up the blocks of both versions by their text (a sequence diff, so an added item doesn't make every later block look changed). Within a changed run, deleted and inserted blocks are paired by the words they share, most alike first and in order, so a removal next to a rewording is reported as what it is. A run with nothing alike is paired in order only when it has as many of each. It reports:

- rewordings as trimmed before → after excerpts;
- paragraphs, list items and headings added or removed;
- drafts finished or approved (fewer of a kind, not counting drafts whose block was removed);
- link addresses and tabs, alt text, gallery captions;
- the Now month;
- the editor's drafts, apart from the live changes (see "Drafts"): pages are compared as thomaswhite.me will serve them, so a draft never reads as a live change.

Markdown gets changed lines, paired the same way; a change to blank lines alone is reported as a spacing change.

- **The subject** (a commit's first line, a pull request's title) is the most specific of these that fits in 72 characters:
  - the one small change everywhere, such as `“see” → “watch” on Physics & Ideas and Programming`;
  - one change, named: `Programming: finish the draft “Two or three screenshots of the…”`;
  - the pages and counts: `Programming and Physics & Ideas: 2 wording changes`;
  - `Edit 3 pages and the Record: …`.
- **The Save dialog** prefills **Commit message** with the subject and **Details** with a line per change, grouped by file. Both are editable. Saving the other files after a conflict uses the generated message.
- **The Publish dialog** describes the whole branch as the pull request shows it, from the merge base with `main` to `edits`, and lists files in the editor's order. It prefills **Pull request title** and leaves **Description** for an optional note.
- **The pull request's description** has three parts:
  - your note;
  - the list of changes (and any regenerated screenshots) between `<!-- editor:changes -->` markers, under **Changes** and **Drafts (saved, left out of thomaswhite.me)**, each shown only when it has something;
  - the Record reminder, and the generated title in an `<!-- editor:title … -->` comment.

  Page text in it is escaped, and an `@` gets a zero-width space so nothing mentions anyone.
- **Every later save refreshes the list**, keeping your note. It updates the title only while it is still the generated one (or the old fixed "Text edits from the editor"); a title you set, in the dialog or on GitHub, is kept. **Update title and description** in the Publish dialog changes both on an open pull request.

## AI suggestions

**Suggest with AI**, in both dialogs, replaces the boxes' contents with a suggestion from Groq, for you to check and edit before using. Nothing is sent until the button is pressed.

- **What is sent:** `describe.js`'s `forAi()` sends the change lines of published files. The Record and the blog sources (`docs/`) go only as a count ("2 changes (private file: content not shared)"), under neutral names: "Record" (`docs/record.md`), or "Blog source" (`docs/blog-sources/`, since a source's file name comes from its post's title). The e2e suite checks that Record text never reaches the request.
- **The route:** `suggest.js` posts `{ access_token, kind: "commit" | "pr", changes }` to the Worker's `/describe`. The Worker checks the token with `GET /user` against the same allowlist as sign-in, so only Tom can spend the allowance. It accepts plain-text change lines only (at most 24 KB) and calls `https://api.groq.com/openai/v1/chat/completions` with the `GROQ_API_KEY` secret. The model is `GROQ_MODEL` (`openai/gpt-oss-120b`), with a strict JSON schema `{ title, body }`, low reasoning effort and no reasoning text returned.
- **The prompt** tells the model:
  - that the changes are data, not instructions;
  - what the editor's change lines mean;
  - to use British English, and to describe only what the changes show: no reasons guessed, nothing called an improvement, no mention of AI;
  - to avoid the site's banned words.
- **What comes back:** the title is cut to one line of at most 72 characters. A pull request description is cut where a list starts, because the editor adds the list itself.
- **Failures** are shown under the boxes and leave the generated text in place:
  - no key: 503;
  - Groq's free limit (30 requests a minute, 1,000 a day for gpt-oss): 429, with `retry-after`;
  - Groq unreachable: 504;
  - an unusable answer: 502.
- **Groq's data handling:** Groq doesn't keep inference data by default, but may log it for up to 30 days when investigating abuse or reliability. **Zero Data Retention**, in the Data Controls settings of the Groq console, turns that off (`setup.md`).

## Security review

- **Who can sign in:** only the account whose numeric id and login are both on the Worker's allowlist; anyone else's grant is revoked on the spot. The App is installed only on the target repository, and its user tokens never exceed what Tom can already do there.
- **The secret:** the client secret exists only in Tom's password manager, his user environment variable `GITHUB_HOMEPAGE_CLIENT_SECRET`, and Cloudflare's secret store. It is never committed, logged or sent to the browser. The App's private key is never used (no installation tokens, no JWTs) and is not in the repository (`*.pem` is ignored).
- **The Groq key:** a Cloudflare secret (`GROQ_API_KEY`), also kept in Tom's user environment variable of that name and his Groq account. It never reaches the browser. `/describe` refuses anyone but the allowlisted account, so the key's allowance can't be spent by others, and private files' text is never sent (see "AI suggestions").
- **Tokens in transit:** the handshake uses state and PKCE; tokens reach the editor only in the URL fragment, which is removed at once; every Worker response is `no-store` and `no-referrer`.
- **Script on the editor's origin:** the page's CSP is `default-src 'none'; script-src 'self'` with no inline script; styles, fonts, images and media only from the editor and the two site origins; `connect-src` only `api.github.com` and the Worker; `form-action 'none'`, `object-src 'none'`, `base-uri` only the site origins. `frame-ancestors` cannot be set from a meta tag, so the editor refuses to run inside a frame. The preview frame has all scripts removed and its own `script-src 'none'`. Interface text is set with `textContent`; nothing is inserted as HTML.
- **What an edit can do:** every change is a splice of the page's own source, re-parsed and verified; text is escaped; the checks mirror CI; locked parts and everything outside `main` must be byte-identical. CI in the site repository remains the gate before anything is published.
- **Local development:** the dev server adds `'self'` and `http://127.0.0.1:8787` to `connect-src` in memory only. `?mock=1` and the `dev/` folder exist only on loopback: `_config.yml` excludes `dev/`, so they are not published.

## Browser behaviour checked

The plan's day-1 checks, run as the Playwright suite in Chromium, Firefox and WebKit (`npm run test:e2e:all`; CI runs Chromium):

- listeners attached by the parent fire inside the unsandboxed srcdoc frame, and its CSP meta blocks scripts;
- the frame loads under `frame-src 'self'`, its `<base>` passes `base-uri`, and the site's CSS, fonts and images load cross-origin (`Access-Control-Allow-Origin: *` on new.thomaswhite.me);
- a click after `contenteditable` is switched on places the caret; Tab reaches a block and types at its end;
- Control+B, Shift+Enter and pasted markup never reach the page; non-breaking spaces typed at the end of a line are saved as spaces;
- a click on a link never navigates; the form cannot submit;
- a re-render restores focus (the "+" journey types straight into the new paragraph).

Found and fixed while checking: WebKit ignores script-made data on a constructed `beforeinput`, so paste is handled at the `paste` event; listeners attached at `load` missed early clicks, so they are attached at `DOMContentLoaded`; Firefox left focus on the frame's body when a click into the page followed one on the editor's own buttons, so typing went nowhere, and a block is now focused at `mousedown`. Still to see on real devices: a paste on an iPhone, and Safari on macOS (the live checks in `setup.md`).

## Tests

- `npm run test:unit` (Node's test runner, `tests/unit/`): the Worker (every route, exact exchange bodies, cookies, CORS, strangers, the exact Groq request and its failures), `auth.js` (expiry, the lock, rotation, the 401 retry), the client (headers, error codes, the commit sequence, `gitBlobSha`), the page model (pinned block, link, image and draft counts for each of the 18 fixture pages, locks, the render copy), text edits (one-line diffs, `&amp;`, hugging tags, NBSP, emptied blocks, the re-serialising fallback, UTF-16 offsets, refusals, and a property test over every editable block of every fixture), drafts and attributes, the editor's drafts (a property test over every block of six fixture pages: the live page unchanged, publishing is the direct edit, discarding restores the file; copies, locks, marks and phrases), structure (+ then × restores the file byte for byte), Markdown, the checks (the unmodified fixtures raise nothing; every rule fires), the descriptions (each kind of change on the fixtures, subjects within 72 characters, the note and title rules, what the AI may see), the suggestion client, the publish flow against the fake GitHub, the vendored bundle (rebuilt and compared byte for byte) and the publish allowlist.
- `npm run test:e2e` (Playwright): twenty-two journeys against the fake GitHub through `page.route`, signing in for real from a Worker-style fragment.
- Fixtures: `tests/fixtures/site/` holds verbatim LF copies of the site's pages and Markdown at the commit named in `SOURCE.md`, and `FILES.txt` lists that commit's files.
- `dev/fake-github.js` is an in-memory GitHub (git objects, fast-forward-only refs, three-dot compare, pull requests, check runs, workflow runs, the baseline bot) used by the unit tests, the Playwright suite and `?mock=1`.

## Switching targets

Before the content-strategy merge into `ThomasWCode/ThomasWCode.github.io` (the site repository's `docs/implementation-notes.md` §6, step 2), publish or discard everything pending in the editor: anything left on the preview repository's `edits` would miss the merge. After the merge:

1. On GitHub: Settings → Applications → Installed GitHub Apps → Homepage Site Editor → Configure → add `ThomasWCode.github.io` (keep or remove the preview repository). Its Settings → Pages → Source must already be **GitHub Actions** (set just before the merge, the site's §6 step 4), or thomaswhite.me would show drafts; the site's production test fails if it does.
2. In `src/config.js`, change `active` from `"preview"` to `"main"`. The CSP already allows both site origins; nothing else names a repository.
3. Refresh the fixtures from the main repository if its markup has moved on (see `tests/fixtures/site/SOURCE.md`), run `npm test`, and publish through the usual pull request.
4. Publish a one-word test edit through the editor and check thomaswhite.me.

## Known limits

- The preview is the page without its script: the navigation shows its no-script layout, Details panels are open, and the gallery and YouTube dialogs don't open.
- Text merge never re-wraps lines; a long insertion lengthens one line (no CI rule limits line length).
- A word written with `&nbsp;` would be saved with a plain space if that word is edited (the site has none).
- Headings cannot be added; images cannot be added or replaced; the header, footer and `<head>` are never editable. Those stay Claude-session work.
- A draft phrase stays within one run of text (not across a link or `<strong>`), and a draft can't be made around another: publish or discard the inner one first.
- GitHub has no conditional branch delete: `edits` is checked just before it is deleted (after a merge, or when a load finds it merged), but a save from another device landing between the check and the delete, a second at most, would be lost with it.
- Whether revoking one token also invalidates its refresh token is still to be seen live; if it does not, Sign out should default to "everywhere" (`setup.md`, live checks).
