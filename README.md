# edit.thomaswhite.me

A private editor for `thomaswhite.me`. Open **https://edit.thomaswhite.me**, sign in with GitHub, and the site's pages appear as they look. Click any text and type; **Save** commits every changed file to an `edits` branch in one go; **Publish** refreshes the screenshot baselines if needed, opens the pull request, waits for the site's checks and merges it. Drafts can be marked done or approved, links and alt text changed, paragraphs and list items added or removed, the Now section's month set, and the record and blog sources edited as plain text. Every change is the smallest possible change to the page's source. Commit messages and the pull request's title and description are written from the changes themselves (`“see” → “watch” on Physics & Ideas and Programming`), editable before use, and **Suggest with AI** can offer wording from Groq through the sign-in Worker, never sending the private files.

The editor targets the preview site (`new.thomaswhite.me`, repository `ThomasWCode/ThomasWCode.github.io-revised`) until the big content update is merged into the main site; then one line in `src/config.js` points it at `thomaswhite.me`.

- How it works: [`docs/how-it-works.md`](docs/how-it-works.md)
- Setup, live checks and upkeep: [`docs/setup.md`](docs/setup.md)
- The approved plan and where the build departs from it: [`docs/plan.md`](docs/plan.md)
- Rules for working on this repository: [`AGENTS.md`](AGENTS.md)

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | Installs the pinned development tools (nothing is served from `node_modules`). |
| `npm run dev` | Serves the editor at `http://127.0.0.1:4174/`; `?mock=1` uses an in-memory GitHub, no sign-in. |
| `npm test` | Lint, unit tests and the Chromium browser suite. |
| `npm run test:e2e:all` | The browser suite in Chromium, Firefox and WebKit. |
| `npm run worker:dev` / `npm run worker:deploy` | Runs or deploys the sign-in Worker. |
| `npm run vendor` | Rebuilds `vendor/parse5.js` after a parse5 or entities upgrade. |
