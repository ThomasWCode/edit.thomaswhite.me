import assert from "node:assert/strict";
import { test } from "node:test";
import { targets } from "../../src/config.js";
import { createGitHubClient, gitBlobSha, GitHubError } from "../../src/github-client.js";

const REPO = "https://api.github.com/repos/ThomasWCode/ThomasWCode.github.io-revised";

function json(status, value, headers = {}) {
  return new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function setup(responses, { tokens = ["ghu_one", "ghu_two"] } = {}) {
  const calls = [];
  const tokenRequests = [];
  const queue = [...responses];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, cache: init.cache });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request ${init.method} ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(url, init) : next;
  };
  let tokenIndex = 0;
  const getAccessToken = async (options = {}) => {
    tokenRequests.push(options);
    if (options.rejected) tokenIndex += 1;
    return tokens[tokenIndex];
  };
  const client = createGitHubClient({
    target: targets.preview,
    fetch,
    getAccessToken,
    now: () => Date.UTC(2026, 8, 25, 12),
  });
  return { client, calls, tokenRequests, remaining: () => queue.length };
}

test("every request carries the API headers; GETs revalidate and writes skip the cache", async () => {
  const { client, calls } = setup([json(200, { object: { sha: "abc" } }), json(201, { ref: "refs/heads/edits" })]);
  assert.equal(await client.getRef("main"), "abc");
  await client.createBranch("edits", "abc");
  const [get, post] = calls;
  assert.equal(get.url, `${REPO}/git/ref/heads/main`);
  assert.deepEqual(get.headers, {
    Accept: "application/vnd.github+json",
    Authorization: "Bearer ghu_one",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  assert.equal(get.cache, "no-cache");
  assert.equal(post.method, "POST");
  assert.equal(post.headers["Content-Type"], "application/json");
  assert.equal(post.cache, "no-store");
  assert.deepEqual(post.body, { ref: "refs/heads/edits", sha: "abc" });
});

test("a 401 is retried once with a refreshed token, then reported", async () => {
  const retried = setup([json(401, { message: "Bad credentials" }), json(200, { full_name: "x" })]);
  await retried.client.getRepo();
  assert.equal(retried.calls[1].headers.Authorization, "Bearer ghu_two");
  assert.deepEqual(retried.tokenRequests, [{}, { rejected: "ghu_one" }]);

  const twice = setup([json(401, { message: "Bad credentials" }), json(401, { message: "Bad credentials" })]);
  await assert.rejects(twice.client.getRepo(), (error) => error instanceof GitHubError && error.code === "unauthorized");
});

test("a missing branch is null; other failures become coded GitHubErrors", async () => {
  const { client } = setup([
    json(404, { message: "Not Found" }),
    json(404, { message: "Not Found" }),
    json(422, { message: "Update is not a fast forward" }),
    json(409, { message: "Head branch was modified. Review and try the merge again." }),
    json(405, { message: "Pull Request is not mergeable" }),
    json(502, { message: "Server Error" }),
  ]);
  assert.equal(await client.getRef("edits"), null);
  const expectCode = async (promise, code, status) =>
    assert.rejects(promise, (error) => error instanceof GitHubError && error.code === code && error.status === status);
  await expectCode(client.getRepo(), "not_found", 404);
  await expectCode(client.updateBranch(1, "abc"), "not_fast_forward", 422);
  await expectCode(client.mergePr(1, "abc"), "conflict", 409);
  await expectCode(client.mergePr(1, "abc"), "not_mergeable", 405);
  await expectCode(client.getPr(1), "server_error", 502);
});

test("rate limits report when to retry", async () => {
  const reset = Date.UTC(2026, 8, 25, 12) / 1000 + 90;
  const { client } = setup([
    json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }),
    json(429, { message: "Secondary rate limit" }, { "retry-after": "60" }),
    json(403, { message: "Resource not accessible by integration" }),
  ]);
  await assert.rejects(client.getRepo(), (error) => error.code === "rate_limited" && error.retryAfter === 90);
  await assert.rejects(client.getRepo(), (error) => error.code === "rate_limited" && error.retryAfter === 60);
  await assert.rejects(client.getRepo(), (error) => error.code === "http_error" && error.status === 403);
});

test("no connection is its own error code", async () => {
  const { client } = setup([new TypeError("Failed to fetch")]);
  await assert.rejects(client.getRepo(), (error) => error.code === "network" && error.status === 0);
});

test("creating a branch that already exists returns its current head", async () => {
  const { client, calls } = setup([json(422, { message: "Reference already exists" }), json(200, { object: { sha: "def" } })]);
  assert.equal(await client.createBranch("edits", "abc"), "def");
  assert.equal(calls[1].url, `${REPO}/git/ref/heads/edits`);
});

test("commitFiles makes one tree and one commit and fast-forwards the branch", async () => {
  const { client, calls } = setup([
    json(200, { sha: "parent", tree: { sha: "parent-tree" } }),
    json(201, { sha: "new-tree" }),
    json(201, { sha: "new-commit" }),
    json(200, { object: { sha: "new-commit" } }),
  ]);
  const result = await client.commitFiles({
    branch: "edits",
    parentSha: "parent",
    message: "Edit 2 files in the editor",
    files: [
      { path: "index.html", content: "<p>One</p>\n" },
      { path: "music&drama.html", content: "<p>Two</p>\n" },
    ],
  });
  assert.deepEqual(result, { sha: "new-commit", treeSha: "new-tree" });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url.replace(REPO, "")}`),
    ["GET /git/commits/parent", "POST /git/trees", "POST /git/commits", "PATCH /git/refs/heads/edits"],
  );
  assert.deepEqual(calls[1].body, {
    base_tree: "parent-tree",
    tree: [
      { path: "index.html", mode: "100644", type: "blob", content: "<p>One</p>\n" },
      { path: "music&drama.html", mode: "100644", type: "blob", content: "<p>Two</p>\n" },
    ],
  });
  assert.deepEqual(calls[2].body, { message: "Edit 2 files in the editor", tree: "new-tree", parents: ["parent"] });
  assert.deepEqual(calls[3].body, { sha: "new-commit", force: false });
});

test("the tree lists blobs only and a truncated tree is refused", async () => {
  const { client } = setup([
    json(200, { sha: "c", tree: { sha: "t" } }),
    json(200, {
      truncated: false,
      tree: [
        { path: "index.html", type: "blob", sha: "b1" },
        { path: "blog", type: "tree", sha: "t2" },
        { path: "blog/index.html", type: "blob", sha: "b2" },
      ],
    }),
    json(200, { sha: "c", tree: { sha: "t" } }),
    json(200, { truncated: true, tree: [] }),
  ]);
  const { files, treeSha } = await client.getCommitTree("c");
  assert.equal(treeSha, "t");
  assert.deepEqual([...files], [["index.html", "b1"], ["blog/index.html", "b2"]]);
  await assert.rejects(client.getCommitTree("c"), (error) => error.code === "tree_truncated");
});

test("blobs are read as base64 JSON from api.github.com and decoded as strict UTF-8", async () => {
  const text = "<p>It’s ✨ “quoted” &amp; fine</p>\n";
  const base64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/(.{60})/g, "$1\n");
  const { client, calls } = setup([
    json(200, { sha: "b1", encoding: "base64", content: base64(new TextEncoder().encode(text)) }),
    json(200, { sha: "b2", encoding: "base64", content: base64([0xff, 0xfe]) }),
    json(200, { sha: "b3", encoding: "utf-8", content: "x" }),
  ]);
  assert.equal(await client.getBlobText("b1"), text);
  assert.equal(calls[0].headers.Accept, "application/vnd.github+json");
  assert.equal(calls[0].url, `${REPO}/git/blobs/b1`);
  await assert.rejects(client.getBlobText("b2"), TypeError);
  await assert.rejects(client.getBlobText("b3"), (error) => error.code === "unexpected");
});

test("pull request, checks, workflow and merge calls use the target's branch names", async () => {
  const { client, calls } = setup([
    json(200, [{ number: 7 }]),
    json(201, { number: 8 }),
    json(200, {
      check_runs: [
        { name: "Static contracts and lint", app: { slug: "github-actions" } },
        { name: "Vercel", app: { slug: "vercel" } },
      ],
    }),
    new Response(null, { status: 204 }),
    json(200, { workflow_runs: [{ id: 1 }] }),
    json(200, { merged: true, sha: "m" }),
    json(422, { message: "Reference does not exist" }),
    json(200, { workflow_runs: [{ name: "pages-build-deployment" }, { name: "Test suite" }] }),
  ]);
  assert.deepEqual(await client.findOpenPr(), { number: 7 });
  assert.deepEqual(await client.createPr({ title: "Text edits from the editor", body: "Pages changed" }), { number: 8 });
  assert.deepEqual((await client.listCheckRuns("sha1")).map((run) => run.name), ["Static contracts and lint"]);
  assert.equal(await client.dispatchWorkflow("update-visual-baselines.yml", "edits"), null);
  assert.deepEqual(await client.listWorkflowRuns("update-visual-baselines.yml", { branch: "edits" }), [{ id: 1 }]);
  assert.deepEqual(await client.mergePr(8, "head"), { merged: true, sha: "m" });
  await client.deleteBranch("edits");
  assert.deepEqual((await client.deployRuns()).map((run) => run.name), ["pages-build-deployment"]);

  const paths = calls.map((call) => `${call.method} ${call.url.replace(REPO, "")}`);
  assert.deepEqual(paths, [
    "GET /pulls?state=open&head=ThomasWCode%3Aedits&base=main&per_page=10",
    "POST /pulls",
    "GET /commits/sha1/check-runs?per_page=100",
    "POST /actions/workflows/update-visual-baselines.yml/dispatches",
    "GET /actions/workflows/update-visual-baselines.yml/runs?per_page=10&branch=edits&event=workflow_dispatch",
    "PUT /pulls/8/merge",
    "DELETE /git/refs/heads/edits",
    "GET /actions/runs?branch=main&per_page=10",
  ]);
  assert.deepEqual(calls[1].body, { title: "Text edits from the editor", head: "edits", base: "main", body: "Pages changed" });
  assert.deepEqual(calls[3].body, { ref: "edits" });
  assert.deepEqual(calls[5].body, { merge_method: "merge", sha: "head" });
});

test("gitBlobSha matches git hash-object", async () => {
  assert.equal(await gitBlobSha(""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  assert.equal(await gitBlobSha("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
  // The header counts UTF-8 bytes (7 here), not the 5 UTF-16 code units.
  assert.equal(await gitBlobSha("It’s\n"), "063ffd786783d5f67f572b4574cbb6d339c71588");
});
