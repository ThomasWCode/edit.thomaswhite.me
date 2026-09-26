# Plan: build edit.thomaswhite.me

Approved on 25 September 2026 after five clarifying questions. This copy is the working reference for the build; `docs/how-it-works.md` describes what was actually built where it differs.

## Status

- 25 September 2026: plan approved. Stages 0 (scaffold, pinned dependencies, LF fixtures) and 1 (the vendored parse5 bundle) committed locally.
- 25 September 2026, later: Tom added the `edit` CNAME at Spaceship and set the Cloudflare workers.dev subdomain to `thomaswhite`, so the Worker is `https://site-editor-auth.thomaswhite.workers.dev`. The GitHub App was registered as "Homepage Site Editor": App ID `5079588`, client ID `Iv23lixP9BDtnDivY3vr` (both public identifiers). GitHub's post-creation page also produced a private key, which the design never uses (no installation tokens, no JWTs); the `.pem` was moved out of the working folder to `C:\Users\thoma\.secrets` and `*.pem` is git-ignored here. The App is installed on `ThomasWCode.github.io-revised`.
- 25 September 2026, evening: Tom enabled GitHub Pages on this repository (source `main`, root, legacy build) with the custom domain and Enforce HTTPS. The certificate is approved and the domain protected; GitHub committed a `CNAME` file to the remote `main`, and the local commits sit on top of it.
- 26 September 2026: built, stages 2 to 12, on the local branch `build-editor`. Tom ran `npx wrangler login`; the session deployed the Worker and stored the client secret from Tom's `GITHUB_HOMEPAGE_CLIENT_SECRET` user environment variable with `wrangler secret put` (never printed). Checked live: the health check reports the secret set, `/login` redirects to GitHub with state and PKCE, and a bogus code comes back as `bad_verification_code` (GitHub accepts the client credentials). Locally: 122 unit tests, and 15 Playwright journeys in Chromium, Firefox and WebKit against the in-memory fake GitHub. Next: the pull request into `main` (Codex review), then Tom's live checks in `docs/setup.md`, then the preview repository's documentation pull request.
- 26 September 2026, later: pull request #1 opened. Codex's first review raised nine points, all fixed: Save waits until every page has loaded (one retry, then it stops); a stale Markdown draft is kept aside like a page's; relative links are refused with their root form as the fix; a Save retried after a lost response is recognised; an emptied Markdown file is refused; a pull request merged or closed on GitHub is followed; the merge keeps `edits` when another device saved on top of it (the P1); the block being typed is mirrored to sessionStorage; the tab fixes keep other `rel` tokens. Found alongside: a merged `edits` left behind by a merge on GitHub is deleted at load. Locally: 128 unit tests, and 18 Playwright journeys in all three engines.
- 26 September 2026, later still: Codex's second review raised six points, all fixed:
  - Edits kept aside survive a Save. Also found: a second change on GitHub, or the conflict dialog's Reload, no longer drops them.
  - The Worker retries the identity check after a refresh, whose old token is already spent.
  - The baseline run is identified by ID rather than by time.
  - External `srcset` candidates aren't checked as repository files.
  - Update from main waits for GitHub's merge and reloads the files.
  - A placeholder is recognised by its text, so adding an item above it doesn't skip the Done confirmation. Revert is withheld once items have been added or removed.

  Locally: 132 unit tests, and 19 journeys.

### Where the build differs from this plan

`docs/how-it-works.md` describes the code; these are the departures, each for a reason found while building.

1. The Worker sends the token endpoint a form-encoded body, as GitHub documents it (the plan said JSON in and out); responses are JSON.
2. Files are read as blobs by SHA from the tree of the commit the editor loaded, not through the Contents API, so the bytes always match the SHA kept for stale-file detection.
3. Module layout: `src/editor.js` is a thin entry point; the signed-in interface is `src/app.js`, the frame is `src/preview.js`, with `src/dialogs.js`, `src/dom.js`, `src/working-store.js` (the sessionStorage mirror) and `src/site-files.js` (page list, order, read-only reasons) alongside. The file list follows a `pageOrder` in `src/config.js` (the site's navigation, locked files last).
4. The preview wires its listeners when the frame's document is parsed (`DOMContentLoaded`), not at `load`: the Playwright suite showed clicks on the visible page going unheard while images loaded.
5. Paste is handled at the `paste` event (every engine fills `clipboardData` for a real paste), with `insertFromPaste` as a fallback: WebKit ignores script-made data on a constructed `beforeinput`.
6. `frame.css` hides the site's phone menu at 1024 pixels and below, which the site's script would have closed; without it the open menu covered the page in a narrow preview.
7. Checks: the anchor check applies to links on changed lines only, so an unrelated broken anchor never blocks a save; external redirects are exempt from the new-tab rule, as in the site's CI; `data-record` values are checked against the record's headings (catching a renamed heading in the Record tab).
8. "+" is offered on list items and plain paragraphs only, not on eyebrows or the hero lede, whose copies would carry their styling class. Shift+Enter finishes a block like Enter.
9. `?mock=1` is backed by `dev/mock-session.js` and `dev/fake-github.js`; the dev server serves the fixtures and a manifest at `/dev/site/` and adds `'self'` to `connect-src` in memory for them.
10. CI runs the browser suite in Chromium; `npm run test:e2e:all` runs Chromium, Firefox and WebKit locally. The fixtures gained `blog/bridging-the-gap.html` (Physics & Ideas links to it) and `FILES.txt` (the site repository's file list, for the local-reference check).
11. The first live test of Sign out (does revoking a token also kill its refresh token?) is still to come, with Tom's live checks.

## Context

`thomaswhite.me` is a hand-written static site on GitHub Pages. A large content update lives in the private preview repo `ThomasWCode/ThomasWCode.github.io-revised`, published at `new.thomaswhite.me`, with 77 draft placeholders Tom still has to write (`npm run list:drafts`). Writing them today means editing HTML by hand in a Claude session.

`ThomasWCode/edit.thomaswhite.me` is a new, empty, private repo. It will host a small editor site: open `https://edit.thomaswhite.me`, sign in with GitHub, see the page as it looks, click text and change it, Save (one commit to an `edits` branch), Publish (opens the PR, waits for CI, merges). For now the editor targets the preview repo and `new.thomaswhite.me`; after the big update is merged into the main repo, a one-key config change points it at `ThomasWCode/ThomasWCode.github.io` and `thomaswhite.me`.

`docs/edit-subdomain-plan.md` in the preview repo is the original sketch. It is suggestive; the decisions below supersede it where they differ (listed at the end).

## Decisions taken with Tom (25 September 2026)

- Scope: text edits, link targets, image alt text, draft Done/Approve, the Now-section date helper, Save and Publish; PLUS add/remove paragraphs and list items; a plain-text tab for `docs/record.md`; plain-text tabs for `docs/blog-sources/*.md`.
- Sign-in handshake runs on a Cloudflare Worker on `*.workers.dev` (free plan). Tom creates the Cloudflare account. DNS stays at Spaceship.
- The main site repo is not touched until the merge. Editor docs live in the editor repo's `docs/`; the cross-repo links go in the preview repo's `AGENTS.md`, `docs/implementation-notes.md` §6 and `docs/status-page-operations.md`.
- Editor repo: commit locally in small descriptive stages, push to `main` once when green locally. Preview repo: one small PR for the doc changes.
- Save commits to `edits` only (no CI). Publish refreshes screenshots if needed, opens the PR, waits for green, merges, deletes `edits`.

## Facts checked on 25 September 2026

- All three repos are private; `gh` is logged in as `ThomasWCode` (id 172206513; scopes gist, read:org, repo, workflow). The preview repo is private with Pages working, so the account can publish Pages from private repos.
- `thomaswhite.me` is already a verified domain for the account (`protected_domain_state: verified`, TXT record at Spaceship), which protects every immediate subdomain including `edit.thomaswhite.me`. No domain-verification step is needed.
- `edit.thomaswhite.me` has no DNS record yet. `new` is a CNAME to `thomaswcode.github.io`; `status` is a CNAME to Better Stack.
- `https://new.thomaswhite.me/CSS/general.css` is served with `Access-Control-Allow-Origin: *`, so CSS, fonts and images load cross-origin into the editor's frame.
- Pages are stored with LF and a final newline; Windows checkouts are CRLF (`core.autocrlf=true`). The API returns LF. The editor must write LF.
- The preview repo has 18 published HTML files (14 pages, `cv.html`, two redirect pages, `gravatar.html`), no open PRs, no `edits` branch, `delete_branch_on_merge: false`, merge commits allowed. Workflow files: `ci.yml` (pull_request, push to main, dispatch), `update-visual-baselines.yml` (dispatch only, refuses `main`, pushes with `GITHUB_TOKEN`, which never re-triggers CI).
- Measured site CI cost: one `pull_request` run ≈ 19 Windows-weighted minute-equivalents; a baseline refresh ≈ 4; a Pages deploy ≈ 3. Pages builds on private repos count as Actions minutes.
- Toolchain: Node 24.18, npm 11.16, git 2.54, gh 2.98, no wrangler, no ripgrep. Latest to pin: parse5 8.0.1 (+ its `entities` dep), esbuild 0.28.2, wrangler 4.141.0, @playwright/test 1.63.0.
- Doc drift found: `docs/updating-tests-and-baselines.md` says seven baselines; eight are committed (`phone-compact-header.png`). Fix while in the docs.

## Architecture

1. **Editor site** (`edit.thomaswhite.me`, Pages from `main`, `CNAME`, `noindex`): static `index.html`, `editor.css`, `frame.css`, ESM modules under `src/`, a vendored parse5 bundle, `worker/`, `tests/`, `docs/`. No framework, no runtime CDN, strict CSP meta.
2. **GitHub App** "Homepage Site Editor": installed only on the preview repo (later the main repo too). User-to-server tokens (8 h access, 6-month refresh) can only touch installed repos and never more than Tom could.
3. **Cloudflare Worker** `site-editor-auth.thomaswhite.workers.dev`: the OAuth handshake; allowlist by numeric user id (172206513) and login.

`src/config.js`:
```js
export const targets = {
  preview: { owner: "ThomasWCode", repo: "ThomasWCode.github.io-revised", base: "main", branch: "edits",
             assets: "https://new.thomaswhite.me",
             requiredChecks: ["Static contracts and lint", "Browser and visual tests", "Lighthouse budgets"],
             visualBaselinePages: ["index.html", "programming.html", "gallery.html"],
             lockedFiles: ["cv.html", "sport.html", "music&drama.html", "gravatar.html"],
             markdown: { record: "docs/record.md", blogSources: "docs/blog-sources/" } },
  main: { ...same, repo: "ThomasWCode.github.io", assets: "https://thomaswhite.me" },
};
export const active = "preview";
export const auth = { production: "https://site-editor-auth.thomaswhite.workers.dev", local: "http://127.0.0.1:8787" };
```
The CSP lists both site origins from day one, so the later switch is: install the App on the main repo, flip `active`, commit.

## Editor repo layout

```
index.html  editor.css  frame.css  robots.txt  CNAME  _config.yml  wrangler.toml
src/editor.js (entry)  auth.js  github-client.js  publish-flow.js  config.js  dom-snapshot.js   # browser-only
src/page-model.js  render-copy.js  snapshot.js  sequence-diff.js  text-merge.js  splice.js  edits.js
src/structure.js  checks.js  diff-view.js  markdown-files.js                                # pure, Node + browser
vendor/parse5.js  vendor/parse5.LICENSE  vendor/entities.LICENSE  vendor/parse5-entry.js
worker/index.mjs  .dev.vars (git-ignored)
dev/fake-github.js  dev/mock-session.js          # in-memory fake GitHub for ?mock=1 and tests
scripts/serve.mjs (127.0.0.1:4174 static server)  scripts/bundle-parse5.mjs
tests/unit/*.test.mjs  tests/e2e/*.spec.mjs  tests/fixtures/site/*.html + SOURCE.md  tests/support/
.github/workflows/ci.yml  package.json ("type":"module")  .nvmrc (24)  .gitattributes  .gitignore  eslint.config.mjs  playwright.config.mjs
README.md  AGENTS.md  docs/plan.md  docs/setup.md  docs/how-it-works.md  docs/edit-subdomain-plan.md
```
Browser-loaded modules are `.js` (GitHub Pages MIME safety); Node-only files are `.mjs`, mirroring the site repo. `_config.yml` excludes `AGENTS.md`, `README.md`, `docs/`, `dev/`, `node_modules/`, `package*.json`, `scripts/`, `tests/`, `worker/`, `wrangler.toml`, the eslint and playwright configs; a unit test asserts every top-level path is either on the publish allowlist (`index.html`, `editor.css`, `frame.css`, `robots.txt`, `CNAME`, `_config.yml`, `src/`, `vendor/`) or excluded.

## Core: how a click on text becomes a one-line diff

Four changes from the sketch after the design pass: no iframe `sandbox` (WebKit bug 218086 stops parent-attached listeners in sandboxed frames without `allow-scripts`, so editing would break on an iPhone); the front matter is blanked, not stripped, so parse5 offsets equal file offsets; every finished edit is applied to a working source string at once (the iframe is a view); CI-mirroring checks block, voice checks warn.

**Parse** (`page-model.js`): reject `\r`; require `^---\npermalink: [^\n]+\n---\n` and blank every non-newline char of it (the trick `scripts/content-review.mjs` uses); `parse(input, { sourceCodeLocationInfo: true })`; find `main#main-content`; mark read-only the locked pages, pages without `main`, or any element under `main` missing an explicit end tag (html-validate:recommended passes in CI, so this is a guard). Keys are element-child index paths from `main`; identical in parse5 and the DOM because `main` holds no scripts or comments (test-guarded).

**Leaf blocks**: inline set (a, abbr, b, bdi, cite, code, data, del, dfn, em, i, ins, kbd, mark, q, s, samp, small, span, strong, sub, sup, time, u, var), replaced set (br, wbr, img, picture, source, svg), skipped set (script, style, template, form, button, input, select, textarea, label, video, audio, dialog, iframe, anything `hidden` or `aria-hidden="true"`). Rule: skip skipped subtrees (images inside still become targets); skip text-less elements; if any descendant is block-level, recurse into children; if a block-level parent has no direct text and only inline children, recurse into those (a compact-list `li` yields its label span, text span and arrow link separately); otherwise the element is the leaf. An inline parent stays one leaf (`span.compact-list-text > cite + span.draft-inline` is one editable, so text can be typed after the `<cite>`).

**Locks** (tooltip says why): everything outside `main`; `h1` (manifest heading and Better Stack keyword); any block whose text contains "I was honestly so impressed" (Analisa's contract, Testimonials and Volunteering); `p.now-updated` (helper-managed); skipped subtrees (contact form, "Details" and facade buttons); proof-block `h4` labels.

**Markers**: drafts (`data-draft` → note / inline / check), links (`a[href]` in main), images (`img`; gallery triple `data-caption`, `aria-label`, `alt`, `figcaption` via `button.gallery-open`), the Now section (`[data-updated]` + `.now-updated`), the shared CTA (`#tech-projects`), every `id`.

**Render copy** (`render-copy.js`): splices on the working source: remove every `script`, `noscript`, `meta[http-equiv]`; after `<head>` insert `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; form-action 'none'">`, `<base href="<assets>/">`, `<link rel="stylesheet" href="<editor origin>/frame.css">` (absolute because of `<base>`); inject `data-edit-key`, `data-edit-role` (block | locked | draft-note | draft-inline | draft-check | link | image | gallery) and `tabindex="0"` into start tags. Set via `iframe.srcdoc`. No editor UI inside the frame: outlines, the hover toolbar (Done, Approve, +, ×) and labels are parent overlays positioned from `getBoundingClientRect()` and repositioned on frame scroll/resize.

**Parent CSP meta** (inherited by the srcdoc): `default-src 'none'; script-src 'self'; style-src 'self' https://new.thomaswhite.me https://thomaswhite.me; font-src https://new.thomaswhite.me https://thomaswhite.me; img-src 'self' data: https://new.thomaswhite.me https://thomaswhite.me https://i.ytimg.com; media-src https://new.thomaswhite.me https://thomaswhite.me; connect-src https://api.github.com https://site-editor-auth.thomaswhite.workers.dev; frame-src 'self'; base-uri https://new.thomaswhite.me https://thomaswhite.me; form-action 'none'; object-src 'none'`. `base-uri` must name the site origins or the child's `<base>` is refused. `frame-ancestors` cannot live in a meta tag, so `editor.js` frame-busts. Local dev adds `http://127.0.0.1:8787` to `connect-src` in memory.

**Editing**: one editing host at a time; `mousedown`/`focusin` on an unlocked block commits the previous block and sets `contentEditable="true"`; `focusout`, Enter or Escape commit and clear it. `beforeinput` (capture) allowlist: `insertText`, `insertCompositionText`, `insertReplacementText`, the `delete*` family, `historyUndo/Redo`; `insertFromPaste` becomes plain text (newlines collapsed) via `execCommand("insertText")` to keep native undo; everything else (`insertParagraph`, `insertLineBreak`, `format*`, lists, links, drop) is prevented. Every `click` inside the frame is prevented (with `<base>`, links would navigate to the live site) and routed to the side panel or block focus; `submit` and `dragstart` prevented. "Revert this block" and "Discard page changes" restore from the original source.

**Commit** (`edits.commitTextEdit(model, key, snapshot)`): `dom-snapshot.js` normalises the block and drops editor attributes; `snapshot.sanitise` maps NBSP → space, drops Chrome's trailing `<br>` on an emptied block, unwraps browser-added `span`/`font`/`b`/`i` wrappers with no attributes but `style`, merges texts. Collapsed text unchanged → no-op. Skeleton (tags + attributes, ignoring text) unchanged → per-slot text merge: `text-merge.mergeText` tokenises the old raw text (entity-encoded, with newlines and indentation) and the new text into words, runs a Myers diff (`sequence-diff.js`), re-emits equal words with their raw spelling and preceding raw whitespace (so `&amp;`, `’` and line wraps stay byte-identical), inserted words escaped (`& < >` only) after a single space, deleted words dropped, spaces before newlines stripped (`no-trailing-whitespace` is in the CI preset); block edges keep the original leading/trailing whitespace. Skeleton changed (a deletion crossed an `<a>` or `<strong>`) → re-serialise that block's inner HTML reusing surviving elements' original start/end tag source verbatim, then re-render. Every commit re-parses and round-trips (same block count, same skeleton, same collapsed text, bytes outside the block identical) or throws and reverts the DOM with the typed text offered for copying.

**Attributes and drafts** (`edits.js`): `setAttribute` splices only the value inside the quotes (or inserts `\n<indent>name="value"` in a multi-line tag); `removeAttribute` removes the attribute and the whitespace before it; `removeClassToken` edits only the class value and drops the attribute when empty. Done on a note = remove `data-draft` + the `draft-note` token; Done on an inline = splice out the span's start and end tags; Approve = remove `data-draft="check"` only; Done on unchanged placeholder text asks first. `setNowUpdated(yyyymm)` changes `data-updated` and the "Updated Month Year" text together.

**Structural edits** (`structure.js`): `addAfter(model, key)` copies the block's source range, strips draft markers, replaces its text with "New paragraph"/"New item", inserts after the block with a newline and its own indentation (a compact-list `li` keeps its span structure and `data-record`/`data-when`/`data-review`, which the contracts require); `remove(model, key)` cuts from the line's indentation through the end tag and trailing newline (last list item: confirm). Each structural op flushes pending text edits, splices, re-parses, re-renders, restores scroll and focus, and pushes an Undo snapshot (per-page stack of source strings; Save clears it). Headings are not addable in v1.

**Checks** (`checks.js`, on the working source's parse5 tree; each finding has a key and line and the dialog jumps to it). Blocking: `{{`/`{%`; banned words (impressive, incredible, journey, leverage, showcase) in text and in `alt`/`content`/`title`/`aria-label`/`data-caption`; `Year 1[0-3]` without a `data-review` ancestor; a `[data-updated]` section lacking its "Updated Month Year" text; an internal href with `target="_blank"`, or an external one without `_blank` + `noopener`; an internal href that is not a page, document, repo file or existing `#anchor` (target page fetched lazily and cached); an emptied heading; "passionate" more than once site-wide; any byte outside `main` or inside a locked block changed. Warnings: `!` count rising past one; a Now line edited without the helper (button runs it); edits inside `#tech-projects` (shared by four pages); an emptied block; straight quotes introduced (offer to curl); a school-year mention edited (nudge the review date); a gallery `data-caption` differing from its figcaption.

**Save dialog** (`diff-view.js`): per-block old → new with word-level ops, then the raw line hunks; a note when `index.html`, `programming.html` or `gallery.html` changed ("Publish will refresh screenshots first").

**Markdown tabs** (`markdown-files.js`): the sidebar lists Pages, then Record (`docs/record.md`) and Blog sources (`docs/blog-sources/*.md` minus `README.md`); a plain `<textarea>` (monospace, spellcheck, wrap) replaces the iframe; LF preserved; saved in the same commit. "New post source" creates `docs/blog-sources/<slug>.md` from the README's template lines. The record's `### slug` headings also validate `data-record` values, so the record is read on load anyway.

**parse5 vendoring**: `vendor/parse5-entry.js` re-exports `parse`, `parseFragment`, `serializeOuter`, `defaultTreeAdapter` (parse5 8.0.1) and `decodeHTML` (entities); `scripts/bundle-parse5.mjs` runs esbuild (`bundle, format esm, platform browser, target es2022, minify false, legalComments inline`, version banner) to `vendor/parse5.js`; licences copied. A test rebuilds to a temp dir and asserts byte equality; another checks `sourceCodeLocation` on a one-line document. Pin parse5, entities and esbuild exactly.

## Auth: Cloudflare Worker `site-editor-auth`

Routes: `GET /login?return_to=<origin>` (validate against `EDITOR_ORIGINS` by exact origin, default first; generate `state` and a PKCE verifier, set the cookie, 302 to GitHub); `GET /callback?code&state` (verify state against the cookie, exchange the code with `code_verifier`, `GET /user`, check id + login, redirect to `<return_to>/#access_token=…&expires_in=…&refresh_token=…&refresh_token_expires_in=…&login=…&user_id=…`, clear the cookie; strangers get 403 and their grant revoked); `POST /refresh {refresh_token}` (rotate; re-check allowlist; JSON); `POST /logout {access_token, everywhere?}` (revoke one token or the whole grant; 204); `OPTIONS` preflights; `GET /` health text; else 404/405.

GitHub calls: authorize `https://github.com/login/oauth/authorize?client_id&redirect_uri=<request origin>/callback&state&code_challenge&code_challenge_method=S256&login=ThomasWCode&allow_signup=false`; exchange and refresh `POST https://github.com/login/oauth/access_token` (JSON in and out; errors arrive as HTTP 200 with an `error` field: `bad_verification_code`, `incorrect_client_credentials`, `redirect_uri_mismatch`, `bad_refresh_token`); identity `GET https://api.github.com/user` with `Authorization: Bearer`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` and a `User-Agent` (GitHub refuses requests without one; Workers add none); revoke `DELETE https://api.github.com/applications/{client_id}/token` or `/grant` with Basic `client_id:client_secret` and `{access_token}`.

Cookie: `__Host-editor_oauth=<base64url JSON {state, verifier, return_to, iat}>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600` (prefix and `Secure` dropped on `http://127.0.0.1:8787`); cleared on every callback outcome. CORS only on `/refresh`, `/logout` and preflights: exact origin echo with `Vary: Origin`, `POST, OPTIONS`, `Content-Type`, no credentials; any other origin → 403. All responses: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`; error pages are plain HTML with `noindex` and never contain token material.

`wrangler.toml`: `name = "site-editor-auth"`, `main = "worker/index.mjs"`, `compatibility_date`, `workers_dev = true`, `preview_urls = false` (versioned hostnames would break `redirect_uri` matching), `[vars] GITHUB_CLIENT_ID, ALLOWED_USER_IDS = "172206513", ALLOWED_LOGINS = "ThomasWCode", EDITOR_ORIGINS = "https://edit.thomaswhite.me,http://127.0.0.1:4174"`, `[observability] enabled = true`. Secret `GITHUB_CLIENT_SECRET` via `npx wrangler secret put` (deploys a new version itself); `.dev.vars` for `wrangler dev`. Code shape: `createHandler({ fetch, randomBytes, now })` so unit tests run in Node 24 with a recording fake `fetch`.

Token storage: `localStorage["siteEditor.session.v1"]` = `{login, userId, accessToken, accessExpiresAt, refreshToken, refreshExpiresAt}` (expiry minus 60 s). A cookie-held refresh token would be a third-party cookie to `workers.dev`, which Safari blocks and Firefox partitions; the XSS gain is small because an XSS could call `/refresh` anyway. The defence is no XSS: strict CSP, no inline or third-party scripts, script-less frame.

`src/auth.js`: `completeSignInFromFragment()` (parse, store, `history.replaceState` to drop the fragment); `getAccessToken()` refreshes when within 5 minutes of expiry inside `navigator.locks.request("siteEditor.refresh")`, re-reading storage first (another tab may have rotated), with a `storage` listener; one 401 → forced refresh and one retry, then "Sign in again"; `signIn()` → `/login?return_to=<origin>`; `signOut({ everywhere })`; help text links to github.com/settings/apps/authorizations for a lost device. First live test: after Sign out, try the old refresh token against `/refresh`; if it still works, make Sign out use `everywhere: true`.

## GitHub client and the Save / Publish flow

`src/github-client.js` wraps `fetch` to `https://api.github.com` with the three headers above, the 401 retry, and error mapping (`GitHubError {status, code, message, retryAfter}`):

| Function | Call |
| --- | --- |
| `getRef(branch)` | `GET /repos/{o}/{r}/git/ref/heads/{branch}` (404 = missing) |
| `getCommitTree(sha)` | `GET /git/commits/{sha}` then `GET /git/trees/{tree}?recursive=1`; refuse `truncated` |
| `listPages()` | `*.html` outside `docs/ tests/ scripts/ node_modules/`, minus `lockedFiles`; plus the Markdown files |
| `getFile(path, commitSha)` | `GET /contents/{path}?ref=<sha>` with `Accept: application/vnd.github.raw+json`, `arrayBuffer()` → `TextDecoder("utf-8", { fatal: true })` |
| `createBranch(name, sha)` | `POST /git/refs {ref:"refs/heads/edits", sha}` (422 exists → `getRef`) |
| `commitFiles({parentSha, files, message})` | `GET /git/commits/{parent}` → `POST /git/trees {base_tree, tree:[{path, mode:"100644", type:"blob", content}]}` → `POST /git/commits {message, tree, parents:[parent]}` → `PATCH /git/refs/heads/edits {sha, force:false}` (422 "not a fast forward" → retry from `getRef`, max 3) |
| `compare()` | `GET /compare/main...edits` (`ahead_by`, `behind_by`, `files`) |
| `findOpenPr()` / `createPr(body)` / `updatePrBody(n)` / `getPr(n)` | `GET /pulls?state=open&head=ThomasWCode:edits&base=main`; `POST /pulls {title:"Text edits from the editor", head:"edits", base:"main", body}`; `PATCH /pulls/{n}`; `GET /pulls/{n}` (`mergeable` null = retry) |
| `listCheckRuns(sha)` | `GET /commits/{sha}/check-runs?per_page=100`, keep `app.slug === "github-actions"` |
| `dispatchWorkflow(file, ref)` / `listWorkflowRuns(file, {branch, since})` | `POST /actions/workflows/{file}/dispatches {ref}` (204, no id) / `GET /actions/workflows/{file}/runs?branch=edits&event=workflow_dispatch` |
| `mergePr(n, headSha)` / `updateBranch(n, headSha)` / `deleteBranch()` | `PUT /pulls/{n}/merge {merge_method:"merge", sha}` (405 not mergeable, 409 moved); `PUT /pulls/{n}/update-branch {expected_head_sha}`; `DELETE /git/refs/heads/edits` |
| `prFiles(n)` / `deployRuns()` | changed PNG links after a baseline refresh; `pages-build-deployment` run on `main` after merge |

User-facing errors: 401 → silent refresh then "Sign in again"; 403/429 with `x-ratelimit-remaining: 0` → back off until reset; 404 on a repo endpoint → "Install Homepage Site Editor on this repository and reload"; 422 non-fast-forward / 409 merge → re-run the stale check and retry; 405 → show `mergeable_state` ("Conflicts with main: resolve on `edits` in a Claude session"); `fetch` throws → "No connection to GitHub; your edits are still in this tab". Polling: PR + check runs every 30 s while visible (≈240 requests/hour of the 5,000 limit).

`src/publish-flow.js` state machine: `signed_out → loading → ready ⇄ dirty → saving`; `ready → refreshing_baselines? → opening_pr → checking → publishable | attention → publishing → published → loading`. One in-flight mutation at a time (`busy` disables every action button); every mutation re-reads the ref it depends on immediately before writing.

- **Load**: `getRef("edits")` (404 → `getRef("main")`), tree, page list; page sources fetched lazily; record `workingHead` and each file's blob sha. Unsaved edits also mirror to `sessionStorage` per page so a reload does not lose typing.
- **Save** (dirty files, checks passed, diff confirmed): `getRef("edits")` or create it from `main`'s head; if the head moved since load, compare each dirty file's blob sha with the new tree: unchanged → commit on top (this is the baseline-bot case, PNG-only), changed → conflict dialog ("Reload this page, dropping its edits" / "Save the other files"); `commitFiles` with message `Edit N files in the editor` and the file list; update `workingHead`, mark clean, compute new blob shas locally (`SHA-1("blob <len>\0" + bytes)`). If a PR is open, update its body and warn that CI runs on this commit; otherwise "Saved to edits; nothing runs until you Publish".
- **Publish** (nothing dirty): `compare()`; `ahead_by === 0` → nothing to publish. If a changed file is in `visualBaselinePages` and the last `edits` commit is not by `github-actions[bot]`: dispatch `update-visual-baselines.yml` on `edits`, poll its run every 15 s (30-minute timeout), then re-read the head and link the changed PNGs. `findOpenPr()` or `createPr()` (a new PR starts CI itself; never dispatch `ci.yml` for a fresh PR or CI runs twice). If the PR existed and the head moved by a bot commit, dispatch `ci.yml` on `edits`. `checking`: poll `getPr` + `listCheckRuns(head)`; publishable when every `requiredChecks` name is completed + success and `mergeable === true`; a failure → `attention` with the job link, and "Refresh screenshots" offered when the browser/visual job failed and a baseline page changed; `compare().behind_by > 0` shows optional "Update from main" (`mergeable_state: "behind"` is not reported without branch protection); conflicts → "ask Claude". `publishing`: `mergePr(n, head)` → `deleteBranch()` → "Merged; new.thomaswhite.me updates in about a minute" with the deploy run status → reload from `main`. PR body: pages changed, and "If a fact changed, update `docs/record.md` (Record tab) in this PR before merging."
- Cost per publish in the preview repo ≈ 19 (PR CI) + 19 (existing push-to-main CI) + 3 (Pages) minute-equivalents, plus 4 when baselines are refreshed. The second CI run is the site repo's existing policy and out of scope.

## Hosting the editor

- Pages from `main`, root, legacy build; enabled by the session with `gh api -X POST repos/ThomasWCode/edit.thomaswhite.me/pages` `{"build_type":"legacy","source":{"branch":"main","path":"/"}}` right after the first push; `CNAME` file sets the custom domain; `PUT https_enforced=true` once `https_certificate.state` is `approved`. The repo claims the domain before the DNS record exists; the verified apex already blocks takeover.
- `robots.txt` `Disallow: /` and `<meta name="robots" content="noindex, nofollow">`. `_config.yml` rather than `.nojekyll` so `worker/`, `tests/`, `docs/`, `README.md` are not published (the Pages gem renders Markdown without front matter). Never write `{{` or `{%` in `index.html`.
- Local: `npm run dev` serves the repo root at `http://127.0.0.1:4174` (excluded dirs hidden except `dev/`); `?mock=1` (loopback only) imports `dev/mock-session.js` and `dev/fake-github.js` (three-page fake repo, `edits`/PR/checks lifecycle, a "move the head" button); `?worker=local` uses `wrangler dev --ip 127.0.0.1 --port 8787`; sign-in from localhost with the deployed Worker works because `EDITOR_ORIGINS` includes `http://127.0.0.1:4174`.

## Tests and CI for the editor repo

`package.json` scripts: `dev`, `worker:dev`, `worker:deploy`, `vendor` (bundle parse5), `lint`, `test:unit` (`node --test tests/unit/*.test.mjs`), `test:e2e` (`playwright test`, Chromium desktop only, `webServer: node scripts/serve.mjs`), `test` (lint + unit + e2e). Dev dependencies pinned: `@playwright/test`, `eslint`, `esbuild`, `parse5`, `entities`, `wrangler`.

`.github/workflows/ci.yml`: one `ubuntu-latest` job (`actions/checkout@v7`, `actions/setup-node@v7` with npm cache, `npm ci`, `npm audit --audit-level=high`, `npm run lint`, `npm run test:unit`, `npx playwright install --with-deps chromium`, `npm run test:e2e`, `npx wrangler deploy --dry-run` if it runs unauthenticated, failure artefacts 7 days); triggers `pull_request`, `push` to `main` with `paths-ignore: [README.md, docs/**]`, `workflow_dispatch`; concurrency cancel-in-progress. About 2–3 minutes per run.

Unit tests (fixtures: verbatim copies of `index.html`, `physics.html`, `physics/magnetic-newtons-cradle.html`, `blog/how-this-site-works.html`, `blog/index.html`, `gallery.html`, `testimonials.html`, `volunteering.html`, `contact.html`, `tedx.html`, `programming.html`, `cv.html`, `sport.html`, `gravatar.html`, `docs/record.md`, a blog source; `SOURCE.md` names the site commit; `.gitattributes` forces LF):
1. Every fixture parses; expected editable count per page; no unreachable text; no leaf inside a leaf; nothing outside `main` keyed.
2. Locks: `h1`, both Analisa blocks, `p.now-updated`, form and buttons, proof-block `h4`s; locked pages read-only.
3. Render copy: no `<script`/`<noscript`/`http-equiv`; CSP meta, `<base>`, frame CSS in order; the copy re-parses to the same `main` skeleton.
4. One-word edit on `index.html` changes exactly one line; `&amp;` nearby untouched. 5. `&` and `<` escaped; hugging `</a\n>` intact. 6. NBSP no-op / typed NBSP → space. 7. Collapsed wrapped whitespace → no change. 8. Emptied `<p>` (with Chrome's `<br>`) → warning; emptied `h2` → blocking. 9. Structural fallback across the "status page" link. 10–12. Done (note, `class="draft-note prose"` → `prose`, inline hugging, inline sole child) and Approve (article-level, `li`) change only the start tags. 13. Now helper. 14. Front matter offsets, final newline, LF; CRLF rejected. 15. Emoji before the edit (UTF-16 offsets). 16. Round-trip catches a broken merge. 17. `mergeText` string cases. 18. Every check rule, positive and negative. 19. Property loop over every block of every fixture (no-op snapshot; longest word → `Xyz` changes only its lines). 20. Structural add/remove/undo byte-exact. 21. Markdown round trip and the new-post template. 22. Bundle byte-equality and a location smoke test. 23. Worker handler (login redirect and cookie; callback happy path asserting the exact exchange body and fragment; bad state; missing cookie; `access_denied`; stranger → 403 + grant revoked; CORS; refresh rotation; logout). 24. `auth.js` with fake storage/fetch (expiry, lock, 401 retry, rotation). 25. `github-client.js` headers and error mapping. 26. `publish-flow.js` against the fake (stale head with unchanged blobs, blob conflict, non-fast-forward retry, baselines before PR, no double CI dispatch, merge sha mismatch). 27. `_config.yml` allowlist contract.

E2E (Playwright, `page.route` on `api.github.com/**` and the Worker origin delegating to the same fake; Playwright auto-fulfils CORS preflights): sign-in via a fragment URL and its removal; refresh on 401; page list; click, type, Save with the exact tree/commit/ref bodies; draft Done; add a paragraph; the Record tab; Publish opens the PR and stays disabled until checks are green; merge and branch deletion; stale head handling; a locked block refuses focus.

## Day-1 browser spikes (half a day, before the UI)

1. Plain `srcdoc` iframe (no `sandbox`) with the CSP meta inside: parent-attached `beforeinput`/`input`/`click`/`focusout` fire in Chrome, Firefox and Safari (desktop and iOS); a leftover inline script does not run.
2. Parent CSP: the srcdoc loads under `frame-src 'self'`; the child's `<base>` passes `base-uri`; fallback `blob:` URL + `frame-src blob:`.
3. CSS, fonts, images from `new.thomaswhite.me` load cross-origin (HEAD `/Fonts/Inter-Variable.woff2` for the CORS header; fallback is system fonts).
4. Caret placement on `mousedown` after toggling `contenteditable`; Tab focus; `execCommand("insertText")` keeps undo in all three engines.
5. Browser artefacts (NBSP, trailing `<br>`, `<span style>` wrappers) match what `sanitise` expects.
6. Click `preventDefault` stops in-frame navigation; `form-action 'none'` blocks the contact form.
7. Re-render restores scroll and focus.
8. Contents API round trip: raw media type, `TextDecoder`, LF, blob sha.

## Documentation

Editor repo: `README.md` (what it is, the owner setup summary, commands); `AGENTS.md` (architecture, the no-framework rule, where the target config lives, the minimal-diff guarantee and its tests, the CI-minutes policy, never commit secrets, how to switch targets); `docs/plan.md` (this plan, condensed, with the decisions and their dates); `docs/setup.md` (the owner walkthrough below with the exact UI field values); `docs/how-it-works.md` (source mapping, save/publish state machine, security review); `docs/edit-subdomain-plan.md` (the sketch moved from the preview repo, with a status line: "Original sketch, September 2026; superseded by docs/plan.md and docs/how-it-works.md where they differ").

Preview repo (one PR, branch `editor-docs`): delete `docs/edit-subdomain-plan.md`; `AGENTS.md` gains an "Editor" section (edits arrive as PRs titled "Text edits from the editor" from `edits`, made at `https://edit.thomaswhite.me` from repo `ThomasWCode/edit.thomaswhite.me`; do not hand-edit `edits` while its PR is open; the editor writes minimal diffs and mirrors the content contracts, CI is still the gate; the editor is repointed after the big merge) and the docs list in Architecture mentions it; `docs/implementation-notes.md` §6 adds the post-merge step (install the App on the main repo, flip `active` in the editor's `src/config.js`, one-word test publish) and notes the preview repo stays the target until then; `docs/status-page-operations.md` adds the `edit` CNAME to the DNS records to keep; `docs/testing.md` CI policy notes that the editor dispatches **Update visual baselines** then **Test suite** on `edits` and that every commit on an open editor PR runs CI; `docs/updating-tests-and-baselines.md` "Seven" → eight with the `phone-compact-header.png` row. The main repo is untouched.

## Setup Tom does (about 45 minutes active), in this order

The Worker URL is deterministic once the workers.dev subdomain exists, so the App can be registered with its final callback URL before anything is deployed; the secret is added after the first deploy and `secret put` deploys by itself. One deploy, no redeploys. The session prompts at each owner step.

A. Owner, browser, before the build (20 min)
1. Cloudflare: create a free account, verify the email, open Workers & Pages, set "Your subdomain" (e.g. `thomaswcode`); tell the session the subdomain.
2. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App: name `Homepage Site Editor`; Homepage URL `https://edit.thomaswhite.me`; Callback URL `https://site-editor-auth.thomaswhite.workers.dev/callback`, "Add callback URL" `http://127.0.0.1:8787/callback`; "Expire user authorization tokens" on; "Request user authorization (OAuth) during installation" off; "Enable Device Flow" off; Webhook "Active" off; Repository permissions: Actions Read and write, Checks Read-only, Contents Read and write, Metadata Read-only, Pull requests Read and write, nothing else (not Workflows, not Pages); "Only on this account". Create; copy the Client ID for the session (public); "Generate a new client secret" and keep it in a password manager (never paste it into chat); no private key.
3. Spaceship DNS: add `CNAME edit → thomaswcode.github.io` (safe now: the apex is verified on GitHub).

B. Session, terminal (the build; no owner input): scaffold, vendor parse5, core modules and tests, spikes, UI, Worker, client, flow, e2e, docs; `wrangler.toml` and `src/config.js` get the client id, Worker URL and origins; local `npm test` green; one push to `main`; enable Pages via `gh api`; check `GET /pages` shows `cname: edit.thomaswhite.me`.

C. Owner and session at the same terminal (10 min)
1. Owner: `npx wrangler login` (browser approval). 2. Session: `npx wrangler deploy`; the printed URL must equal callback URL 1. 3. Owner: `npx wrangler secret put GITHUB_CLIENT_SECRET`, paste at the prompt. 4. Session: a HEAD on `/login` shows a 302 to `github.com/login/oauth/authorize`; `npx wrangler tail` open for the first sign-in.

D. Owner, browser (5 min plus waiting)
1. Repo Settings → Pages: "DNS check successful" once the CNAME resolves; tick "Enforce HTTPS" when the certificate is issued (minutes to a day), or the session runs the API call.
2. Install the App: github.com/settings/apps → Homepage Site Editor → Install App → Only select repositories → `ThomasWCode.github.io-revised`.

E. Live checks (owner with the session): sign in at `https://edit.thomaswhite.me`; one-word edit on a deep page → Save (commit on `edits`, no CI) → Publish (PR opens, CI green, merge, `edits` deleted, `new.thomaswhite.me` updated with a one-word diff); a homepage edit exercises the screenshot path; sign in from a phone; Sign out, then the session tests the old refresh token; optionally a non-allowlisted account is refused.

## Implementation stages (local commits; one push)

0. Copy this plan into `edit.thomaswhite.me/docs/plan.md`; delete the placeholder file; scaffold (`package.json`, `.nvmrc`, `.gitignore`, `.gitattributes`, eslint, `CNAME`, `_config.yml`, `robots.txt`, `index.html` shell, README stub).
1. Vendor parse5 (`scripts/bundle-parse5.mjs`, `vendor/`, tests 22).
2. `page-model.js`, `render-copy.js`, fixtures, tests 1–3.
3. `snapshot.js`, `sequence-diff.js`, `text-merge.js`, `splice.js`, `edits.commitTextEdit`, tests 4–9, 14–17, 19.
4. Draft, attribute and Now rewrites, tests 10–13.
5. `checks.js`, `diff-view.js`, tests 18. 6. `structure.js`, `markdown-files.js`, tests 20–21.
7. Spikes 1–8 in the built-in browser against `npm run dev` with `?mock=1`; adjust.
8. `editor.js` UI (sidebar, iframe wiring, overlays, side panel, save dialog, status bar, undo), `editor.css`, `frame.css`, `dev/` fakes.
9. `worker/index.mjs`, `wrangler.toml`, `auth.js`, tests 23–24.
10. `github-client.js`, `publish-flow.js`, tests 25–27. 11. Playwright e2e, `ci.yml`. 12. Docs (README, AGENTS.md, setup, how-it-works, moved sketch).
13. Push `main`; Pages via `gh api`; owner phases C–E interleaved.
14. Preview repo branch `editor-docs`, PR, merge with a merge commit.

## Verification

- Local: `npm test` green (lint, unit, e2e); `node --test` runs the property loop over every fixture; `npx playwright test --ui` for the e2e on Windows (`npx playwright install chromium`).
- Worker: unit tests; after deploy, `curl -I .../login` → 302; a stranger's login (test account, optional) → 403.
- Live: phase E above; `gh api repos/ThomasWCode/edit.thomaswhite.me/pages` shows the cname, `https_enforced: true`; `Resolve-DnsName edit.thomaswhite.me` → CNAME; the published PR diff is exactly the edited words; `npm run list:drafts` in the preview repo drops by the number of placeholders finished.
- Preview repo PR: its CI green; `docs/` still excluded by `_config.yml`.

## Risks and open items

- Spike results may force the `blob:` frame fallback or extra `sanitise` cases; the core modules are unaffected.
- Whether `DELETE /applications/{id}/token` also kills the refresh token (first live test decides the Sign out default); whether `update-branch` triggers the PR workflow; whether `wrangler deploy --dry-run` runs unauthenticated in CI.
- GitHub's rotation invalidates the old refresh token on every refresh; a device that misses the rotation (storage cleared mid-refresh) must sign in again. Two devices refreshing at the same second is harmless because each holds its own pair.
- Text merge never re-wraps lines; long inserted sentences lengthen one line (nothing in CI enforces a width; several lines already exceed 80 columns). `&nbsp;` in source would be lost in an edited word (none exists; documented).
- Actions cost: every Publish ≈ 41 minute-equivalents in the preview repo (two CI runs plus Pages); the second run is the site's existing push-to-main policy and could be revisited separately.

## Changes from the sketch, with reasons

1. Repo is `edit.thomaswhite.me` (exists), not `site-editor`. 2. Save is one Git Data API commit for all changed files and opens no PR; Publish opens it after refreshing baselines (≈19 minute-equivalents saved per extra save and per screenshot refresh). 3. No iframe `sandbox` (WebKit bug 218086); scripts stripped plus a `script-src 'none'` meta. 4. Front matter blanked, not stripped. 5. Edits applied to a working source as they finish; the Save dialog diffs original vs working. 6. Allowlist by numeric user id plus login; PKCE on the authorize request; strangers' grants revoked; separate "Sign out" and "Sign out everywhere". 7. Browser modules are `.js`. 8. Stale detection at branch and file level, so baseline-bot commits never block a save. 9. "Update from main" driven by `compare().behind_by`. 10. Both site origins in the CSP from day one. 11. `gallery.html` counts as a baseline-sensitive page. 12. Setup order: subdomain first, App second, one deploy, secret last; Pages claimed by API before DNS. 13. Three extras added: structural edits, the Record tab, blog-source tabs.
