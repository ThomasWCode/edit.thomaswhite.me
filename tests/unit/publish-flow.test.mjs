import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeGitHub } from "../../dev/fake-github.js";
import { targets } from "../../src/config.js";
import { createGitHubClient, gitBlobSha } from "../../src/github-client.js";
import { BusyError, createPublishFlow, PR_TITLE, prBody, SaveConflictError, summariseChecks } from "../../src/publish-flow.js";
import { readFixture } from "../support/fixtures.mjs";

const target = targets.preview;
const SEED = ["index.html", "programming.html", "physics.html", "gallery.html", "docs/record.md"];

async function setup({ wrapFetch = (fetch) => fetch } = {}) {
  let clock = Date.UTC(2026, 8, 26, 9);
  const now = () => (clock += 1000);
  const fake = await createFakeGitHub({ files: new Map(SEED.map((path) => [path, readFixture(path)])), now });
  const client = createGitHubClient({ target, fetch: wrapFetch(fake.fetch, fake), getAccessToken: async () => "mock-token", now });
  const flow = createPublishFlow({ client, target, sleep: async () => {}, now });
  return { fake, client, flow };
}

async function change(path, from, to, loadedSha, fake, branch = "main") {
  const text = fake.fileAt(branch, path).replace(from, to);
  assert.notEqual(text, fake.fileAt(branch, path), `${from} is in ${path}`);
  return { path, text, loadedSha };
}

const countRequests = (fake, method, pattern) => fake.requests.filter((request) => request.method === method && pattern.test(request.path)).length;

async function untilSettled(flow, rounds = 10) {
  for (let round = 0; round < rounds; round += 1) {
    await flow.refreshChecks();
    if (["publishable", "attention"].includes(flow.state.phase)) return flow.state.phase;
  }
  return flow.state.phase;
}

test("load, save, publish, checks, merge: the whole happy path on a deep page", async () => {
  const { fake, flow } = await setup();
  const loaded = await flow.load();
  assert.equal(loaded.onBranch, false, "no edits branch yet: loads main");
  assert.equal(flow.state.phase, "ready");

  const edit = await change("physics.html", "Thinking about things", "Thinking about stuff", loaded.files.get("physics.html"), fake);
  const saved = await flow.save([edit], "Edit 1 file in the editor");
  assert.equal(fake.head("edits"), saved.sha, "the first save creates edits and commits to it");
  assert.equal(fake.fileAt("edits", "physics.html"), edit.text);
  assert.equal(fake.fileAt("main", "physics.html"), readFixture("physics.html"), "main is untouched");
  assert.equal(saved.files.get("physics.html"), await gitBlobSha(edit.text));
  assert.equal(flow.state.phase, "ready");
  assert.equal(fake.checkRuns().length, 0, "saving runs nothing on GitHub");

  await flow.publish();
  assert.equal(flow.state.phase, "checking");
  const [pull] = fake.pulls();
  assert.equal(pull.title, PR_TITLE);
  assert.equal(pull.head.ref, "edits");
  assert.match(pull.body, /- `physics\.html`/);
  assert.match(pull.body, /docs\/record\.md/);
  assert.equal(countRequests(fake, "POST", /dispatches$/), 0, "a deep page needs no baselines and a new PR starts CI itself");
  assert.equal(fake.checkRuns().length, 3, "one CI run: three required jobs");

  assert.equal(await untilSettled(flow), "publishable");
  assert.ok(flow.state.checks.every((check) => check.state === "passed"));
  const result = await flow.merge();
  assert.equal(result.merged, true);
  assert.equal(fake.head("edits"), null, "edits is deleted after the merge");
  assert.equal(fake.fileAt("main", "physics.html"), edit.text);
  assert.deepEqual(fake.commit(fake.head("main")).parents.length, 2, "a merge commit, as the repository's history uses");
  assert.equal(flow.state.phase, "published");
  const deploy = await flow.refreshDeploy();
  assert.ok(deploy, "the Pages deployment of the merge is found");

  const reloaded = await flow.load();
  assert.equal(reloaded.onBranch, false);
  assert.equal(reloaded.head, fake.head("main"));
});

test("a stale head is fine when only other files changed (the baseline bot's PNGs)", async () => {
  const { fake, flow } = await setup();
  const first = await flow.load();
  await flow.save([await change("physics.html", "Thinking about things", "Thinking a lot", first.files.get("physics.html"), fake)], "one");
  const loadedSha = flow.state.files.get("programming.html");
  await fake.commitAs("edits", { "tests/visual/home.png": "new pixels" }, { bot: true, message: "Regenerate Win32 visual baselines" });
  const edit = await change("programming.html", "I started with Lua", "I began with Lua", loadedSha, fake, "edits");
  const saved = await flow.save([edit], "two");
  assert.equal(fake.head("edits"), saved.sha);
  assert.equal(fake.fileAt("edits", "tests/visual/home.png"), "new pixels", "the bot's commit is kept underneath");
  assert.equal(fake.commit(saved.sha).parents[0].length, 40);
});

test("a file that changed elsewhere since it was loaded is a conflict, not an overwrite", async () => {
  const { fake, flow } = await setup();
  const loaded = await flow.load();
  const sha = loaded.files.get("physics.html");
  await flow.save([await change("physics.html", "Thinking about things", "Thinking hard", sha, fake)], "one");
  const mySha = flow.state.files.get("physics.html");
  await fake.commitAs("edits", { "physics.html": fake.fileAt("edits", "physics.html").replace("Thinking hard", "Thinking elsewhere") });
  const edit = { path: "physics.html", text: "whatever", loadedSha: mySha };
  await assert.rejects(flow.save([edit], "two"), (error) => error instanceof SaveConflictError && error.conflicts.join() === "physics.html");
  assert.match(fake.fileAt("edits", "physics.html"), /Thinking elsewhere/, "the other change is not overwritten");
});

test("a branch that moves between reading and writing is retried from the new head", async () => {
  let raced = false;
  const { fake, flow } = await setup({
    wrapFetch: (fetch, fakeRef) => async (url, init) => {
      if (!raced && init.method === "PATCH" && String(url).endsWith("/git/refs/heads/edits")) {
        raced = true;
        await fakeRef.commitAs("edits", { "gallery.html": fakeRef.fileAt("edits", "gallery.html") + "<!-- elsewhere -->\n" });
      }
      return fetch(url, init);
    },
  });
  const loaded = await flow.load();
  await flow.save([await change("physics.html", "Thinking about things", "Thinking once", loaded.files.get("physics.html"), fake)], "one");
  const edit = await change("physics.html", "Thinking once", "Thinking twice", flow.state.files.get("physics.html"), fake, "edits");
  await flow.save([edit], "two");
  assert.ok(raced);
  assert.equal(fake.fileAt("edits", "physics.html"), edit.text);
  assert.match(fake.fileAt("edits", "gallery.html"), /elsewhere/, "the racing commit survives underneath");
  assert.equal(countRequests(fake, "PATCH", /\/git\/refs\/heads\/edits$/), 3, "one fast-forward per save plus the retry");
});

test("a captured page refreshes the baselines before the pull request, and CI runs once", async () => {
  const { fake, flow } = await setup();
  const loaded = await flow.load();
  await flow.save([await change("index.html", "Pick whatever sounds a bit interesting.", "Pick anything.", loaded.files.get("index.html"), fake)], "home");
  await flow.publish();
  assert.equal(countRequests(fake, "POST", /update-visual-baselines\.yml\/dispatches$/), 1);
  assert.equal(countRequests(fake, "POST", /ci\.yml\/dispatches$/), 0, "the new PR's own CI covers the bot's commit");
  const head = fake.head("edits");
  assert.equal(fake.commit(head).author.name, "github-actions[bot]");
  assert.deepEqual(flow.state.changedImages.map((image) => image.path), [
    "tests/visual/site.visual.spec.mjs-snapshots/home-desktop-visual-chromium-win32.png",
  ]);
  assert.equal(fake.checkRuns(head).length, 3, "CI ran on the bot's commit, once");
  assert.equal(fake.checkRuns().length, 3);

  // Publishing again with the PR open and nothing new neither re-runs baselines nor CI.
  await flow.publish();
  assert.equal(countRequests(fake, "POST", /dispatches$/), 1);
});

test("an open pull request gets CI on each save, and a bot push gets a ci.yml dispatch", async () => {
  const { fake, flow } = await setup();
  const loaded = await flow.load();
  await flow.save([await change("physics.html", "Thinking about things", "Thinking one", loaded.files.get("physics.html"), fake)], "one");
  await flow.publish();
  assert.equal(fake.checkRuns().length, 3);
  await flow.save([await change("physics.html", "Thinking one", "Thinking two", flow.state.files.get("physics.html"), fake, "edits")], "two");
  assert.equal(fake.checkRuns().length, 6, "a person's push to the PR branch starts CI");
  assert.equal(flow.state.phase, "checking");
  assert.match(fake.pulls()[0].body, /physics\.html/);

  await flow.save([await change("index.html", "Pick whatever", "Pick anything", flow.state.files.get("index.html"), fake, "edits")], "three");
  await flow.publish();
  assert.equal(countRequests(fake, "POST", /update-visual-baselines\.yml\/dispatches$/), 1);
  assert.equal(countRequests(fake, "POST", /ci\.yml\/dispatches$/), 1, "the bot's commit on an open PR needs CI dispatched");
});

test("a failed browser job on a captured page offers new screenshots; a conflict asks for Claude", async () => {
  const { fake, flow } = await setup();
  const loaded = await flow.load();
  fake.settings.conclusions["Browser and visual tests"] = "failure";
  await flow.save([await change("gallery.html", "My photo gallery", "My photos", loaded.files.get("gallery.html"), fake)], "one");
  await flow.publish();
  assert.equal(await untilSettled(flow), "attention");
  assert.ok(flow.state.canRefreshScreenshots);
  assert.match(flow.state.notice, /Browser and visual tests failed/);

  fake.settings.conclusions["Browser and visual tests"] = "success";
  await flow.refreshScreenshots();
  assert.equal(await untilSettled(flow), "publishable");

  const second = await setup();
  const again = await second.flow.load();
  await second.flow.save([await change("physics.html", "Thinking about things", "Thinking!", again.files.get("physics.html"), second.fake)], "one");
  await second.flow.publish();
  second.fake.settings.conflicts = true;
  assert.equal(await untilSettled(second.flow), "attention");
  assert.match(second.flow.state.notice, /Claude/);
});

test("the merge is refused, and checks re-read, when the head moved after they passed", async () => {
  const { fake, flow } = await setup();
  const loaded = await flow.load();
  await flow.save([await change("physics.html", "Thinking about things", "Thinking now", loaded.files.get("physics.html"), fake)], "one");
  await flow.publish();
  assert.equal(await untilSettled(flow), "publishable");
  await fake.commitAs("edits", { "docs/record.md": fake.fileAt("edits", "docs/record.md") + "\nA new fact.\n" });
  const result = await flow.merge();
  assert.equal(result.merged, false);
  assert.equal(flow.state.phase, "checking");
  assert.equal(fake.pulls()[0].state, "open");
  assert.equal(await untilSettled(flow), "publishable");
  assert.equal((await flow.merge()).merged, true);
});

test("behind main: Update from main merges main into edits and re-runs the checks", async () => {
  const { fake, flow } = await setup();
  const loaded = await flow.load();
  await flow.save([await change("physics.html", "Thinking about things", "Thinking more", loaded.files.get("physics.html"), fake)], "one");
  await flow.publish();
  await fake.commitAs("main", { "docs/record.md": fake.fileAt("main", "docs/record.md") + "\nMain moved.\n" });
  await flow.refreshChecks();
  assert.equal(flow.state.behindBy, 1);
  await flow.updateFromMain();
  assert.equal(fake.commit(fake.head("edits")).parents.length, 2);
  await flow.refreshChecks();
  assert.equal(flow.state.behindBy, 0);
});

test("one GitHub action at a time; nothing to publish when edits equals main", async () => {
  const { fake, flow } = await setup();
  const loaded = await flow.load();
  const edit = await change("physics.html", "Thinking about things", "Thinking fast", loaded.files.get("physics.html"), fake);
  const first = flow.save([edit], "one");
  await assert.rejects(flow.save([edit], "again"), BusyError);
  await first;

  const empty = await setup();
  await empty.flow.load();
  await empty.fake.commitAs("main", {});
  await empty.client.createBranch("edits", empty.fake.head("main"));
  const result = await empty.flow.publish();
  assert.equal(result.published, false);
  assert.match(empty.flow.state.notice, /Nothing to publish/);
});

test("summariseChecks takes each check's latest run and ignores others", () => {
  const runs = [
    { id: 1, name: "Static contracts and lint", status: "completed", conclusion: "failure" },
    { id: 4, name: "Static contracts and lint", status: "completed", conclusion: "success" },
    { id: 2, name: "Browser and visual tests", status: "in_progress", conclusion: null },
  ];
  const summary = summariseChecks(runs, target.requiredChecks);
  assert.deepEqual(summary.checks.map((check) => check.state), ["passed", "running", "waiting"]);
  assert.equal(summary.passed, false);
  assert.equal(summary.started, true);
  assert.match(prBody(["index.html", "docs/record.md"]), /Pages changed:\n\n- `index\.html`\n\nOther files:\n\n- `docs\/record\.md`/);
});
