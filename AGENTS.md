# Repository instructions

This repository is `edit.thomaswhite.me`, a private editor for the `thomaswhite.me` website: a static page on GitHub Pages, a Cloudflare Worker for GitHub sign-in, and a GitHub App. Read [`docs/how-it-works.md`](docs/how-it-works.md) before changing code, [`docs/setup.md`](docs/setup.md) for anything outside it, and [`docs/plan.md`](docs/plan.md) for the decisions taken with Tom and where the build departs from them. `docs/edit-subdomain-plan.md` is the original sketch, kept for history.

## Layout

- `index.html`, `editor.css`, `frame.css`, `src/` (browser ES modules, `.js`) and `vendor/` are what GitHub Pages publishes. `_config.yml` excludes everything else; `tests/unit/publish-allowlist.test.mjs` fails if a new top-level path is neither published on purpose nor excluded.
- `worker/index.mjs` and `wrangler.toml`: the sign-in Worker `site-editor-auth`.
- `dev/`: the in-memory fake GitHub and the `?mock=1` session (loopback only, never published).
- `scripts/serve.mjs` (the local server) and `scripts/bundle-parse5.mjs` (the vendored parser).
- `tests/unit/` (Node's test runner), `tests/e2e/` (Playwright), `tests/fixtures/site/` (verbatim copies of the site's pages at the commit in `SOURCE.md`).

## Rules

- No framework, no runtime dependency, no build step for the editor. The only generated file is `vendor/parse5.js` (`npm run vendor`, then commit it; a test rebuilds it and compares bytes). Never load code from a CDN.
- Browser modules are `.js` ES modules under `src/`; Node-only files are `.mjs`. Keep the pure modules (`page-model`, `render-copy`, `snapshot`, `text-merge`, `sequence-diff`, `splice`, `edits`, `structure`, `drafting`, `checks`, `diff-view`, `describe`, `markdown-files`, `site-files`, `publish-flow`, `github-client`, `suggest`, `auth`) free of DOM access so the unit tests cover them.
- Nothing in the page may set HTML from data: build elements with `src/dom.js` (`textContent`), never `innerHTML`, and never a `style` attribute (the CSP blocks them; set `element.style.*` instead). Keep the CSP in `index.html` as strict as it is; `scripts/serve.mjs` widens `connect-src` for local development in memory only.
- The minimal-diff guarantee is the point of the editor: a typed change must change only the bytes it has to, and every commit is re-parsed and verified. Any change to `page-model.js`, `text-merge.js`, `edits.js`, `structure.js`, `drafting.js` or `render-copy.js` must keep `tests/unit/text-edits.test.mjs` (including the property test over every block of every fixture), `drafts-attributes.test.mjs`, `drafting.test.mjs`, `structure-markdown.test.mjs` and `page-model.test.mjs` green. Add a fixture case for any new markup pattern.
- The checks in `src/checks.js` mirror the site repository's CI (`tests/static/*.test.mjs` there). When the site's contracts change, change them here too; `tests/unit/checks.test.mjs` asserts the unmodified fixtures raise nothing.
- Drafts follow the site's rule (its `AGENTS.md`, "Drafts"): an element marked `data-draft` is left out of thomaswhite.me by the site's `scripts/drafts.mjs`. `liveSource()` in `src/drafting.js` must leave out exactly what that script does, and the draft kinds the editor writes (`new`, `replace`, `remove`) must stay ones the site's contracts accept. A `replace` draft records its live element in `data-draft-of`, which the site's script must go on ignoring (it reads attribute names only) and leaving out with its draft; publishing removes it with the marker. Change both repositories together.
- Files are written with LF endings and a final newline, and the editor writes the site's files the same way.
- Never commit secrets. The GitHub App's client secret lives only in Cloudflare (`npx wrangler secret put GITHUB_CLIENT_SECRET`), Tom's password manager and, for `npm run worker:dev`, the git-ignored `.dev.vars`. Never print it. The client ID and App ID are public. The App's private key is not used and must not enter the repository (`*.pem` is ignored). The Groq key behind the AI suggestions is the same kind of secret: Cloudflare (`GROQ_API_KEY`), Tom's `GROQ_API_KEY` user environment variable and `.dev.vars` only, never printed, never in the browser.
- The AI suggestions only ever fill editable boxes, and only what `describe.js`'s `forAi()` produces reaches the Worker: never the text of `docs/` files (the Record, blog sources). Keep it that way, and keep the Worker's `/describe` behind the same allowlist as sign-in.
- Which repository the editor edits is `active` in `src/config.js`; nothing else names a repository. The preview repository `ThomasWCode/ThomasWCode.github.io-revised` (published at `new.thomaswhite.me`) is the target until the content-strategy merge into `ThomasWCode/ThomasWCode.github.io`; then install the App there and switch `active` (`docs/how-it-works.md`, "Switching targets").
- Actions minutes are limited and the site repository's CI runs Windows jobs. Commit locally in small, descriptive stages and push rarely. In this repository, work on a branch and open a pull request into `main` only when it is ready; ask for Codex's review with a comment that is exactly `@codex review`, with nothing else, address its comments, and merge with a merge commit when CI is green. Codex ignores a comment with anything more, such as the "Generated by Claude Code" footer on a cloud Claude session's GitHub comments, so a cloud session asks Tom to post it; a local session posts it itself with `gh pr comment <number> --body "@codex review"`, which adds nothing. The editor itself runs the site's workflows only on Publish. Saves commit to `edits` without running anything until a pull request is open, and so does bringing `main` into `edits` when the editor opens.

## Verification

1. `npm ci`, then `npx playwright install chromium` (add `firefox webkit` for all engines).
2. `npm test`: lint, the unit tests, and the Chromium browser suite against the fake GitHub.
3. `npm run test:e2e:all` when the preview, editing or paste behaviour changes: Firefox and WebKit behave differently from Chromium in the places that matter.
4. `npm run dev` and `http://127.0.0.1:4174/?mock=1` to try a change by hand; the mock panel simulates the baseline bot, another device, main moving on, failing checks, conflicts and an expired token.
5. After a Worker change: `npx wrangler deploy`, then `https://site-editor-auth.thomaswhite.workers.dev/` must say "Client secret: set".
