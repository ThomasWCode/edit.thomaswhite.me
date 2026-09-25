# Repository instructions

This repository will hold `edit.thomaswhite.me`, a private editor for the `thomaswhite.me` website. It is at the plan stage: read `docs/plan.md` first. It records the decisions taken with Tom, the architecture, the algorithms, the tests, the one-time setup Tom performs, and the implementation stages. `docs/edit-subdomain-plan.md` is the earlier sketch and is superseded by the plan where they differ.

## What exists

- The scaffold: `package.json` (Node 24, pinned development-only dependencies: parse5, entities, esbuild, wrangler, Playwright, ESLint), `eslint.config.mjs`, `.gitattributes` forcing LF, `CNAME`, `robots.txt` and a `_config.yml` that keeps everything except the editor out of the published GitHub Pages site.
- `vendor/parse5.js`: parse5 and entities bundled once with esbuild by `scripts/bundle-parse5.mjs` (`npm run vendor`). The editor loads it from its own origin; never load it from a CDN. Regenerate and commit it after a dependency bump.
- `tests/fixtures/site/`: verbatim LF copies of the site's pages and Markdown sources, with the source commit in `SOURCE.md`. Unit tests will pin editable-block counts against them.

## Rules that already apply

- No framework, no runtime dependency, no build step for the editor itself. The only generated file is the vendored bundle.
- Browser-loaded modules are plain `.js` ESM under `src/`; Node-only files (scripts, worker, tests) are `.mjs`. `package.json` has `"type": "module"`.
- Files are written with LF endings and a final newline; the editor must write the site's files the same way.
- Never commit secrets: the GitHub App client secret lives in Cloudflare (`wrangler secret put`) and, locally, in the git-ignored `.dev.vars`. The client id is public and may be committed.
- Which site repository the editor edits is a config value (`src/config.js`, `active`), not something spread through the code. The preview repository `ThomasWCode/ThomasWCode.github.io-revised` (published at `new.thomaswhite.me`) is the target until the big content update is merged into `ThomasWCode/ThomasWCode.github.io`; then the GitHub App is installed on the main repository and `active` is switched.
- Commit locally in small descriptive stages and push rarely: the site repository's CI costs Windows runner minutes on every pull-request commit, and this repository's Pages build and CI also count against the account's Actions minutes.

## Verification (once code exists)

`npm test` runs lint, `node --test tests/unit/*.test.mjs` and the Chromium-only Playwright suite against an in-memory fake GitHub. `npm run dev` serves the editor at `http://127.0.0.1:4174`; `?mock=1` uses the fake without signing in.
