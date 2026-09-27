# Setting up and looking after the editor

Everything the owner does outside the code, in order, with what has been done. How it works is in [`how-it-works.md`](how-it-works.md).

## Done (25–26 September 2026)

| Step | Where | Result |
| --- | --- | --- |
| Cloudflare account and workers.dev subdomain | dash.cloudflare.com → Workers & Pages | Subdomain `thomaswhite`, so the Worker lives at `https://site-editor-auth.thomaswhite.workers.dev`. |
| GitHub App "Homepage Site Editor" | github.com → Settings → Developer settings → GitHub Apps | App ID 5079588, client ID `Iv23lixP9BDtnDivY3vr`. Values below. |
| DNS | Spaceship | `CNAME edit → thomaswcode.github.io`. |
| GitHub Pages for this repository | Repository → Settings → Pages | Source `main`, root, legacy build; custom domain `edit.thomaswhite.me`; HTTPS enforced; certificate approved; domain verified (the apex `thomaswhite.me` is verified on the account). |
| App installation | github.com/settings/installations | On `ThomasWCode/ThomasWCode.github.io-revised` only. |
| `npx wrangler login` | Tom's terminal | Logged in to "Thomasawhite321@gmail.com's Account". |
| Worker deploy | `npx wrangler deploy` (session) | `https://site-editor-auth.thomaswhite.workers.dev`. |
| Client secret | `GITHUB_HOMEPAGE_CLIENT_SECRET` user environment variable, piped to `wrangler secret put GITHUB_CLIENT_SECRET` (session) | Health check says "Client secret: set"; a test exchange with a bogus code returns `bad_verification_code`, so GitHub accepts the client ID and secret. |
| Live checks 1 to 4 | The editor, with Tom signed in (26 September) | Signed in and authorised the App. "see" → "watch" on Physics & Ideas and Programming, saved as two one-line commits (no workflow ran), published as ThomasWCode/ThomasWCode.github.io-revised#34. The baseline workflow regenerated the Programming screenshot first, and one CI run went green. Merged with a merge commit, `edits` deleted, live on new.thomaswhite.me. |
| Live check 8 | The editor, in Tom's session (26 September) | **Suggest with AI** answered from Groq end to end; the test edit was undone, so nothing was saved or pushed. |

### The GitHub App's settings

These are the values from the plan. A private App's settings can't be read through the API, so the live checks below are what confirm them: a missing permission shows up as GitHub answering "Resource not accessible by integration".

- Name: Homepage Site Editor (shown only on GitHub's authorisation screen).
- Homepage URL: `https://edit.thomaswhite.me`.
- Callback URLs: `https://site-editor-auth.thomaswhite.workers.dev/callback` and `http://127.0.0.1:8787/callback` (for `npm run worker:dev`).
- Expire user authorization tokens: on. Request user authorization (OAuth) during installation: off. Enable Device Flow: off. Webhook: inactive.
- Repository permissions: Actions read and write (dispatching the baseline and test workflows), Checks read-only, Contents read and write, Metadata read-only, Pull requests read and write, Workflows read and write (moving `edits` up to `main` when `main` has changed a workflow file; `how-it-works.md`, "Security review"). Nothing else; not Pages. Workflows was added after the data-safety audit of 27 September: see "Still to do".
- Where can this GitHub App be installed: only on this account.

## Still to do

### Two settings from the data-safety audit (27 September)

`docs/audits/2026-09-27-merge-safety.md`, findings 4 and 11. Neither is code.

- **Merge commits only, in both site repositories.** In `ThomasWCode/ThomasWCode.github.io-revised` and `ThomasWCode/ThomasWCode.github.io`: Settings → General → Pull Requests. Untick "Allow squash merging" and "Allow rebase merging", and leave "Allow merge commits" ticked. After a squash or rebase, `edits` still holds commits `main` lacks, and bringing `main` in could undo a later revert on `main`. The editor itself always merges with a merge commit.
- **The Workflows permission.** GitHub → Settings → Developer settings → GitHub Apps → Homepage Site Editor → Permissions & events → Repository permissions → Workflows: **Read and write** → Save changes.
  - Then accept the new permission on the installation. GitHub asks for this whenever an App's permissions grow: Settings → Applications → Installed GitHub Apps → Homepage Site Editor.
  - Then sign in to the editor again.
  - Without it, GitHub may refuse to move `edits` up to `main` over a change to a workflow file (`main` added `.github/workflows/pages.yml` after today's `edits` branched). Nothing is lost when it does: the editor loads `main` and tries again next time. But a save that has to move `edits` up fails the same way, its edits staying in the tab, until the permission is granted.

### Live checks (with the session)

Checks 1 to 4 (sign-in, Save, Publish and Merge, the screenshot path) and 8 (Suggest with AI) are done; see the table above.

5. Sign in from your phone and make an edit there; try a paste.
6. **Sign out**, then the session checks whether the old refresh token still works at the Worker's `/refresh`. If it does, Sign out should default to "everywhere" (a one-line change in `src/editor.js`).
7. Optionally, sign in with a different GitHub account: it should see "This editor is private".

Added with drafts:

9. Try **Drafts** on a change you want anyway (a test change would sit on `edits` with your unpublished edits). Turn the toggle on and change a word: a dashed new version appears after the live text, which dims. Save, and the commit on `edits` adds the new version beside the live one. new.thomaswhite.me shows drafts, so once published there the new version stands in for the live one; thomaswhite.me will leave it out after the content-strategy merge. **Publish new version** in the panel, then Save, turns it into the plain edit.

Added with the data-safety fixes (27 September, `docs/audits/2026-09-27-merge-safety.md`). They were tested only against the fake GitHub, and only in Chromium, so these are still to do:

10. On a machine with Firefox and WebKit (`npx playwright install firefox webkit`), run `npm run test:e2e:all`. The fixes change how a block and the Markdown box are finished, and the Publish dialog.
11. Once the Workflows permission is granted and the fixes are merged, open the editor with nothing unsaved. The preview repository's `edits` (8 saves, behind `main` since 26 September) should get `main` merged in, which finding 11 left unverified. After the next Publish, `edits` should still exist, at the merge commit, and the editor should show nothing to publish.
12. Merge one of the editor's pull requests on GitHub itself, with a merge commit. The next load should move `edits` up to `main` and show nothing to publish.
13. With Drafts on, save a new version of a paragraph, then have a Claude session change another word of the live paragraph on `edits`. **Publish new version** should refuse, and show the paragraph as it was (looked up in the file's history on GitHub), as it is now, and the new version. Carry the change over, press **Record the live version**, then publish it.
14. On GitHub, add a line below the list in an open pull request's description, and change its title. Both should survive the next Save, and **Update title and description** with nothing changed in the dialog.
15. Have a Claude session rename a blog source that has unsaved edits in the editor. After **Reload those files**, the edits should be under **No longer on GitHub**, and no Save should recreate the file.

### Tidy-up

- Delete the App's unused private key: App settings → Private keys → Delete. The editor never uses it (no installation tokens), and an unused key is only a liability. The downloaded `.pem` was moved to `C:\Users\thoma\.secrets`; delete that copy too.
- Remove the `GITHUB_HOMEPAGE_CLIENT_SECRET` user environment variable now that Cloudflare holds the secret (System Properties → Environment Variables, or `[Environment]::SetEnvironmentVariable("GITHUB_HOMEPAGE_CLIENT_SECRET", $null, "User")` in PowerShell). The password manager keeps the copy you need.

## Looking after it

### Rotating the client secret

1. App settings → Client secrets → Generate a new client secret; copy it to the password manager.
2. In this repository: `npx wrangler secret put GITHUB_CLIENT_SECRET` and paste it at the prompt (this redeploys the Worker by itself).
3. Check `https://site-editor-auth.thomaswhite.workers.dev/` says "Client secret: set", sign in once, then delete the old secret on GitHub.

### AI suggestions (Groq)

**Suggest with AI** in the Save and Publish dialogs uses a key from Tom's Groq account (free tier), held by the Worker as the secret `GROQ_API_KEY`. How it works and what is sent: [`how-it-works.md`](how-it-works.md), "AI suggestions".

- **Set or rotate the key:** in this repository, `npx wrangler secret put GROQ_API_KEY` and paste the key at the prompt (this redeploys the Worker). A session can pipe it from Tom's `GROQ_API_KEY` user environment variable without printing it. Then `https://site-editor-auth.thomaswhite.workers.dev/` should say "AI suggestions: on (openai/gpt-oss-120b)". After a rotation, delete the old key in the Groq console.
- **Groq's Data Controls:** turn on **Zero Data Retention** in the Data Controls settings of the Groq console. Groq keeps no inference data by default, but without this it may log requests for up to 30 days when investigating abuse or reliability.
- **Change the model:** `GROQ_MODEL` in `wrangler.toml` (a production model with strict JSON output: `openai/gpt-oss-120b` or `openai/gpt-oss-20b`), then `npx wrangler deploy`.
- **Turn it off:** `npx wrangler secret delete GROQ_API_KEY`. The button then says the Worker has no Groq key, and the generated messages carry on as before.
- The `GROQ_API_KEY` user environment variable is only a copy: keep it for `npm run worker:dev`, or remove it once the Worker holds the key.

### Cutting off a device

GitHub → Settings → Applications → Authorized GitHub Apps → Homepage Site Editor → Revoke signs out every device at once. From a device that still has the editor open, Account → **Sign out everywhere** does the same.

### Changing the Worker

`npm run worker:dev` runs it at `http://127.0.0.1:8787` (put `GITHUB_CLIENT_SECRET=…`, and `GROQ_API_KEY=…` for the AI suggestions, in the git-ignored `.dev.vars` first) and `http://127.0.0.1:4174/?worker=local` signs in through it. `npx wrangler deploy` publishes it; there is one deploy per change and no staging copy (`preview_urls = false`, because versioned hostnames would not match the App's callback URL). `npx wrangler tail` streams its logs during a sign-in.

### Working on the editor locally

- `npm ci`, then `npx playwright install chromium` (add `firefox webkit` for `npm run test:e2e:all`).
- `npm run dev` serves the editor at `http://127.0.0.1:4174/`. Sign-in there uses the deployed Worker, which accepts that origin. `http://127.0.0.1:4174/?mock=1` needs no sign-in: an in-memory GitHub seeded from the test fixtures, with a panel to simulate the bot, another device, main moving on, failing checks, conflicts and an expired token. Nothing leaves the browser.
- `npm test` runs lint, the unit tests and the Chromium browser suite. CI runs the same on every pull request (about three Linux minutes).

### Switching to the main site

Before the content-strategy merge (the site repository's `docs/implementation-notes.md` §6), publish or discard everything pending in the editor, so the preview repository's `edits` holds nothing `main` lacks (the branch itself stays: the editor never deletes it). Then run §6 steps 2 to 7 in one go: in between, changes made in the editor are no longer read, and the Claude session running the merge says so at step 2. Drafts may stay in the pages: they merge like any other markup. Just before merging, set the main repository's Settings → Pages → Source to **GitHub Actions** (§6 step 4). Its "Publish the live site" workflow then builds thomaswhite.me with drafts left out; with the old source, drafts would show there. After the merge: install the App on `ThomasWCode/ThomasWCode.github.io`, set `active` to `"main"` in `src/config.js`, publish that change through a pull request, then make a one-word test edit through the editor. Details in [`how-it-works.md`](how-it-works.md), "Switching targets".

Around the merge (just before or just after is fine), also add the Claude routine in §6 step 5. It is a scheduled Claude agent on the main repository that reads each batch of new commits, the editor's included, and reports:

- anything to add or question;
- anything inconsistent;
- anything added only to the site that also belongs in `docs/record.md` or the CV.

### If Pages stops publishing

This repository is private, and GitHub Pages from a private repository needs GitHub Pro (from the Student Developer Pack). If Pro lapses, both this editor and thomaswhite.me stop publishing; making this repository public would restore the editor (it holds no secrets).
