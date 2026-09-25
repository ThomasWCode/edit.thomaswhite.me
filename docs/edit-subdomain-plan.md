> **Status (25 September 2026):** this is the original sketch, moved here from `ThomasWCode.github.io-revised/docs/`. The approved plan in `docs/plan.md` supersedes it wherever the two differ (the list of changes is at the end of that file).

# Edit subdomain (edit.thomaswhite.me) plan

## Context
- Goal: open `edit.thomaswhite.me`, sign in, see the site as it looks, click text and change it, then Save and Publish. The change lands in the GitHub repo through a PR, and GitHub Pages publishes it.
- Assumption: "hex editable" means "text editable".
- Short answer: **yes, it's possible, with no paid service.** It needs three free pieces:
  1. a small editor site on GitHub Pages;
  2. a GitHub App that controls who can sign in and what they can touch;
  3. a ~100-line Cloudflare Worker for the "Sign in with GitHub" handshake. This runs on a `*.workers.dev` address, so **your DNS stays at Spaceship** (it currently uses `launch1/2.spaceship.net`).
- Decisions made (September 2026):
  - Save goes to a branch and a PR; Publish merges it.
  - Sign in once per device with no token pasting, and only you can get in.
  - Scope: text, draft Done/Approve, link targets and alt text.
  - Drafts are never cleared automatically.
  - Plan only for now; nothing is built yet.
- Off-the-shelf alternative, and why not: CloudCannon edits plain HTML in place, but:
  - it costs $45–250/month ([Findstack](https://findstack.com/products/cloudcannon/pricing));
  - its `class="editable"` HTML method has been marked deprecated since October 2025 ([CloudCannon docs](https://cloudcannon.com/documentation/edit/editing/html/#editable-regions));
  - editing happens on CloudCannon's domain, not yours.
  - Decap, Sveltia and Pages CMS only edit Markdown or YAML fields, which would need the Eleventy migration first (`docs/content-strategy.md` §12).

## Questions answered
- **Can the editor repo be private?** Yes.
  - GitHub Pro, which comes with the Student Developer Pack, allows Pages from private repos ([GitHub Docs](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)).
  - The Pages *site* itself is still public; only the repo is hidden. That is fine here, because the editor page holds no content and no secrets. It is only a sign-in screen until you log in.
  - If Pro lapses, Pages stops publishing from private repos, and that applies to thomaswhite.me as well.
- **Nobody else can use it.** There are three independent locks:
  1. The Worker only issues a sign-in to GitHub usernames on an allowlist (`ALLOWED_LOGINS`, e.g. `ThomasWCode`).
  2. The GitHub App is installed only on the site repo(s). Its tokens can do nothing anywhere else, and never more than the signed-in user could do already.
  3. Tokens stay in the signed-in browser's own storage and never on a server. A stranger opening `edit.thomaswhite.me` sees a "Sign in with GitHub" button that refuses them.
- **Several devices, no pasting.** Click "Sign in with GitHub" once on each device; if you're already logged in to GitHub there, that's a single click.
  - The device then stays signed in: access tokens last 8 hours and refresh silently, and the refresh token lasts 6 months ([GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)).
  - "Sign out" on a device revokes its token.
  - A lost device can be cut off at GitHub → Settings → Applications → Authorized GitHub Apps.
- **Honest limits:**
  - "Exact clone" means the page is rendered from the repo source with the real CSS, fonts and images, but **with the site's JavaScript off**. The navigation shows its no-JS layout, Details panels show open (so their text is editable), and the gallery and YouTube dialogs don't open.
  - Text edits on `/` or `/programming/` change the committed full-page screenshot baselines, so CI goes red until those are regenerated. The editor handles this with a button (see Publish).

## Architecture
- **Editor repo** `ThomasWCode/site-editor` (private, Pages, `CNAME` = `edit.thomaswhite.me`, `noindex`):
  - static `index.html`, `editor.js`, `editor.css`;
  - a vendored, pinned `parse5` ESM bundle (MIT), so there's no CDN at runtime;
  - `worker/`, with tests and its own CI.
- **GitHub App** "Tom's site editor", owned by ThomasWCode:
  - installed only on `ThomasWCode.github.io-revised` (and later the main site repo);
  - user-token expiry on; webhook off;
  - permissions: Contents RW, Pull requests RW, Actions RW (dispatch workflows), Checks R, Metadata R.
- **Cloudflare Worker** `site-editor-auth.<account>.workers.dev` (free plan: 100,000 requests/day, [Cloudflare](https://developers.cloudflare.com/workers/platform/pricing/)):
  - `GET /login`: redirects to GitHub's authorize page with a random `state`.
  - `GET /callback`: swaps the code for a token using the client secret (a Worker secret), checks `GET /user` against `ALLOWED_LOGINS`, and redirects to the editor with the tokens in the URL **fragment**, which is never sent to servers or logs.
  - `POST /refresh` and `POST /logout`: CORS is locked to `https://edit.thomaswhite.me`, and both re-check the allowlist.
- **Editor security:**
  - a strict CSP `<meta>`: scripts only from its own origin; CSS, fonts and images only from the target site; `connect-src` only `api.github.com` and the Worker;
  - no third-party scripts;
  - it is a separate origin from thomaswhite.me, so the site's Google Analytics and CookieYes can never read the token.
- **Target config** in `editor.js`:
  - `{ repo: "ThomasWCode/ThomasWCode.github.io-revised", base: "main", branch: "edits", assets: "https://new.thomaswhite.me" }`;
  - the main site repo is added later as a second target.

## How editing maps back to the source (the core)
- **Load:** fetch the page from the Contents API, from `edits` if that branch exists, otherwise from `main`. Decode it as UTF-8, keeping the exact bytes (LF endings, final newline).
- **Parse:** parse the page with `parse5` with `sourceCodeLocationInfo`, which gives the exact source offsets of every element and text node. Both the browser and parse5 use the HTML spec's parser, so the two trees match.
- **Tag and render:** give each editable leaf block inside `main#main-content` a `data-edit-id` in the *render copy only*. Leaf blocks are `p`, `li`, `h2`–`h4`, `figcaption`, `blockquote`, `dt`/`dd`, and the `span`s in `.compact-list`.
  - Inject `<base href="https://new.thomaswhite.me/">` and a `script-src 'none'` CSP.
  - Render the copy in a same-origin `srcdoc` iframe. GitHub Pages sends `Access-Control-Allow-Origin: *`, so the fonts load.
- **Locked (not editable), each with a tooltip saying why:**
  - the header, the footer and `<head>`;
  - the `h1`, which is pinned in `tests/support/page-manifest.mjs` and the Better Stack monitor keyword;
  - Analisa's quote, which has an exact-wording contract;
  - the contact form's buttons (`JS/script.js` hard-codes "Send message");
  - `cv.html` (needs a PDF rebuild), the two redirect pages and `gravatar.html`.
- **Typing rules:** handled through `beforeinput`.
  - Enter, bold/italic and drag-drop are blocked.
  - Paste becomes plain text.
  - Non-breaking spaces are turned back into normal spaces.
- **Save (minimal diff):**
  - For each changed block whose element structure is unchanged, only the changed text nodes' source ranges are replaced, with `&`, `<` and `>` escaped. Everything else in the file stays byte-identical: the indentation, the hugging `>` wrapping, and `&amp;`.
  - If a deletion crossed a link or `<strong>` boundary, that one block is re-serialised. Unchanged tags reuse their original start-tag source text.
- **Side panel** opens when you click a link or an image:
  - Links: edit the `href`. Internal paths are checked against the site's page list. Existing `target` and `rel` are kept.
  - Images: edit `alt`.
  - Gallery items show `data-caption`, `aria-label`, `alt` and `<figcaption>` together, and warn if they differ.
- **Drafts: manual only.**
  - Editing a draft's text **never** changes its draft status.
  - `p.draft-note[data-draft]` gets a **Done** button, which removes `data-draft` and the `draft-note` class from the start tag.
  - `span.draft-inline[data-draft]` gets a **Done** button, which unwraps the span.
  - Invisible `data-draft="check"` text gets a dotted outline and an **Approve** button, which removes only the attribute.
- **Pre-save checks**, which mirror the repo's contracts:
  - Blocked:
    - `{{` or `{%` (Liquid);
    - the banned words from `tests/static/content-contracts.test.mjs:23`.
  - Warned:
    - more than one "!" on a page;
    - "Year 10–13" text with no `data-review` ancestor;
    - an edited Now line. This offers a manual button to update `data-updated` and the "Updated Month Year" line together.
  - The Save dialog shows an old → new diff before committing.

## Save and Publish flow
- **Save:**
  - creates `edits` from `main` if it doesn't exist;
  - commits the page with the Contents API, using the file `sha`, so a stale page gets a 409 and a "reload" prompt;
  - opens the PR "Text edits from the editor" if there is none, otherwise adds to the open one.
  - The PR body includes a reminder to update `docs/record.md` if a fact changed.
- **Status bar:** shows unpublished pages and the CI state of the PR head (check runs, polled while the tab is visible).
- **Screenshots:** if the visual job fails and `index.html` or `programming.html` changed, a **Refresh screenshots** button:
  1. dispatches `update-visual-baselines.yml` on `edits`;
  2. then dispatches `ci.yml` on `edits`, because pushes made with `GITHUB_TOKEN` don't re-trigger CI;
  3. links to the PR's changed PNGs so you can look at them.
- **Publish:** enabled only when the PR is mergeable and every check run is green.
  - It merges with a merge commit, matching the repo's history, then deletes `edits`.
  - If `main` has moved ahead, it offers **Update from main** (`PUT /pulls/{n}/update-branch`). A real conflict means asking Claude.

## Setup you would do (about 30–45 minutes, once)
1. Create a private repo `ThomasWCode/site-editor` and add it to a Claude session.
2. At Spaceship, add the DNS record `CNAME edit → thomaswcode.github.io`. In the repo's Pages settings, set the custom domain and tick "Enforce HTTPS".
   - Verifying the domain in your GitHub account settings is also recommended, to prevent a takeover.
3. Create a free Cloudflare account. Run `npm ci`, `npx wrangler login`, `npx wrangler secret put GITHUB_CLIENT_SECRET`, then `npx wrangler deploy`.
4. Create the GitHub App (settings above; callback = the Worker's `/callback`) and install it on the site repo only.

## Files
- **Later, editor repo:**
  - `index.html`, `editor.js` (UI and GitHub API calls), `source-map.mjs` (parse, tag, splice; pure functions), `checks.mjs`, `editor.css`;
  - `vendor/parse5.mjs`;
  - `worker/index.mjs`, `wrangler.toml`;
  - `tests/`, `.github/workflows/ci.yml`, `README.md` (the setup steps).
- **Later, this repo:**
  - `AGENTS.md`: a short "Editor" section saying edits arrive as PRs from `edits`, and not to hand-edit that branch while its PR is open;
  - `docs/status-page-operations.md`: add the `edit` CNAME to the DNS records to keep when changing provider.

## Verification (when built)
- **Installation:** Node 24, then `npm ci`, then `npx playwright install chromium`. Wrangler is a devDependency.
- **`node --test tests/*.test.mjs`:**
  - `source-map` on copies of real pages: a one-word edit gives a one-word diff; `&amp;` is kept; hugging tags stay intact; the non-breaking space is normalised; a draft Done/Approve changes only the start tag; the structural fallback works.
  - Worker handlers: a bad `state`, a non-allowlisted login, and the CORS origin.
- **`npx playwright test`:** the editor runs against a mocked GitHub API and a mocked Worker. The tests cover:
  - sign-in and refresh;
  - load, type, Save, checking the exact PUT body and the PR creation;
  - locked regions;
  - Publish disabled until checks are green.
- **Live checks on the preview:**
  - Make a one-word edit on a deep page, then check the PR diff is exactly one word, CI is green, Publish works, and new.thomaswhite.me updates.
  - Sign in from a second device.
  - Try a non-allowlisted GitHub account and confirm it's refused.
