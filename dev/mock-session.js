// ?mock=1 (loopback only): a signed-in session against the in-memory fake
// GitHub, seeded with the test fixtures that scripts/serve.mjs serves at
// /dev/site/. Nothing leaves the browser; reloading starts again from the
// fixtures. A small panel moves the fake's state for trying the awkward cases.

import { SignedOutError } from "../src/auth.js";
import { button, h } from "../src/dom.js";
import { createFakeGitHub } from "./fake-github.js";

async function fetchText(path) {
  const response = await fetch(path, { cache: "no-store" });
  return response.ok ? response.text() : null;
}

export async function createMockSession({ target }) {
  // Every path in the site repository (FILES.txt), with real contents for the
  // fixtures (manifest.json, listed by scripts/serve.mjs) and a placeholder
  // for the rest (images, CSS), which the editor never reads.
  const list = ((await fetchText("dev/site/FILES.txt")) || "").split("\n").filter(Boolean);
  const fixtures = new Set(JSON.parse((await fetchText("dev/site/manifest.json")) || "[]"));
  const files = new Map();
  await Promise.all(
    list.map(async (path) => {
      const text = fixtures.has(path) ? await fetchText(`dev/site/${path.split("/").map(encodeURIComponent).join("/")}`) : null;
      files.set(path, text ?? `(placeholder for ${path})\n`);
    }),
  );
  const fake = await createFakeGitHub({ owner: target.owner, repo: target.repo, files, ciReads: 3, workflowReads: 3 });

  let signedIn = true;
  const listeners = new Set();
  const user = { login: "ThomasWCode", userId: 172206513 };
  const notify = () => listeners.forEach((listener) => listener(signedIn ? user : null));
  const auth = {
    currentUser: () => (signedIn ? user : null),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    completeSignInFromFragment: () => null,
    async getAccessToken() {
      if (!signedIn) throw new SignedOutError();
      return "mock-token";
    },
    signIn: () => location.reload(),
    async signOut() {
      signedIn = false;
      notify();
      return true;
    },
  };

  function mountPanel(app) {
    const status = h("p", { class: "dev-panel-status" }, "Fake GitHub, seeded from tests/fixtures/site.");
    const say = (text) => {
      status.textContent = text;
    };
    const panel = h(
      "details",
      { class: "dev-panel", open: true },
      h("summary", {}, "Mock GitHub"),
      status,
      button("Bot commits a PNG to edits", async () => {
        if (!fake.head("edits")) return say("There is no edits branch yet: save first.");
        await fake.commitAs("edits", { "tests/visual/site.visual.spec.mjs-snapshots/home-desktop-visual-chromium-win32.png": `pixels ${Date.now()}` }, { bot: true, message: "Regenerate Win32 visual baselines" });
        say("The baseline bot moved edits (PNG only): the next save still commits on top.");
      }, { small: true }),
      button("Another device edits this page", async () => {
        const entry = app.current;
        const branch = fake.head("edits") ? "edits" : "main";
        if (!entry) return;
        await fake.commitAs(branch, { [entry.path]: `${fake.fileAt(branch, entry.path)}<!-- edited elsewhere -->\n` });
        say(`${entry.path} changed on ${branch}: saving it now is a conflict.`);
      }, { small: true }),
      button("Next CI: browser job fails", () => {
        fake.settings.conclusions["Browser and visual tests"] = "failure";
        say("CI runs started from now fail the browser job.");
      }, { small: true }),
      button("Next CI passes", () => {
        fake.settings.conclusions["Browser and visual tests"] = "success";
        say("CI runs started from now pass.");
      }, { small: true }),
      button("Merges conflict", () => {
        fake.settings.conflicts = !fake.settings.conflicts;
        say(fake.settings.conflicts ? "The pull request now conflicts with main." : "Conflicts cleared.");
      }, { small: true }),
      button("Expire the token once", () => {
        fake.settings.expireNextRequest = true;
        say("The next GitHub request answers 401; the client refreshes and retries.");
      }, { small: true }),
    );
    document.body.append(panel);
  }

  return { auth, fetch: (input, init) => fake.fetch(input, init), fake, mountPanel };
}
