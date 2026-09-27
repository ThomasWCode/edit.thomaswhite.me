// An in-memory stand-in for the part of the GitHub REST API the editor uses:
// git objects and refs, compare, pull requests, check runs and workflow runs.
// It runs unchanged in Node (unit and Playwright tests) and in the browser
// (http://127.0.0.1:4174/?mock=1), and is never published (_config.yml
// excludes dev/).
//
// It behaves like GitHub where the editor depends on it: fast-forward-only ref
// updates, 422 for an existing ref, three-dot compare from the merge base, a new
// pull request (or a push by a person to its branch) starting CI, a push by
// the baseline workflow's bot starting nothing, `mergeable` computed lazily
// (null on the first read), and merges refused with 409 when the head moved.
// Check and workflow runs complete after a few reads, so polling code sees
// them progress without timers.

const API = "https://api.github.com";
const BOT = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" };
const REQUIRED_CHECKS = ["Static contracts and lint", "Browser and visual tests", "Lighthouse budgets"];
const BASELINE_PNGS = {
  "index.html": ["tests/visual/site.visual.spec.mjs-snapshots/home-desktop-visual-chromium-win32.png"],
  "programming.html": ["tests/visual/site.visual.spec.mjs-snapshots/programming-desktop-visual-chromium-win32.png"],
  "gallery.html": ["tests/visual/site.visual.spec.mjs-snapshots/gallery-dialog-visual-chromium-win32.png"],
};

const encoder = new TextEncoder();

async function sha1(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", encoder.encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function blobSha(text) {
  return sha1(`blob ${encoder.encode(text).length}\0${text}`);
}

function json(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "x-ratelimit-remaining": "4999", ...headers },
  });
}

const error = (status, message) => json(status, { message, documentation_url: "https://docs.github.com/rest" });

export async function createFakeGitHub({
  owner = "ThomasWCode",
  repo = "ThomasWCode.github.io-revised",
  files = new Map(),
  user = { login: "ThomasWCode", id: 172206513 },
  tokens = ["mock-token"],
  now = () => Date.now(),
  ciReads = 2,
  workflowReads = 2,
} = {}) {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const refs = new Map();
  const pulls = [];
  const checkRuns = [];
  const workflowRuns = [];
  const requests = [];
  const validTokens = new Set(tokens);
  let nextId = 1;
  let clock = 0;

  const settings = {
    // Conclusion per required check for the next CI runs.
    conclusions: Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, "success"])),
    baselineConclusion: "success",
    // When true, the next PR merge conflicts (mergeable false, state "dirty").
    conflicts: false,
    // When set, the next request answers 401 once (an expired access token).
    expireNextRequest: false,
    // Listings a dispatched run is missing from, as on GitHub, where a run
    // appears a few seconds after its dispatch.
    dispatchLag: 0,
  };

  function listed(run) {
    if (!run.hiddenReads) return true;
    run.hiddenReads -= 1;
    return false;
  }

  async function storeTree(map) {
    const entries = [...map].sort(([a], [b]) => (a < b ? -1 : 1));
    const sha = await sha1(`tree ${JSON.stringify(entries)}`);
    trees.set(sha, new Map(entries));
    return sha;
  }

  async function storeCommit({ tree, parents, message, author }) {
    clock += 1;
    const date = new Date(now() + clock).toISOString();
    const sha = await sha1(`commit ${tree} ${parents.join(",")} ${message} ${clock}`);
    commits.set(sha, { sha, tree, parents, message, author: { ...author, date }, committer: { ...author, date } });
    return sha;
  }

  async function storeFiles(base, changes) {
    const map = new Map(base);
    for (const [path, text] of changes) {
      if (text === null) {
        map.delete(path);
      } else {
        const sha = await blobSha(text);
        blobs.set(sha, text);
        map.set(path, sha);
      }
    }
    return storeTree(map);
  }

  const person = { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
  const initialTree = await storeFiles(new Map(), files);
  refs.set("main", await storeCommit({ tree: initialTree, parents: [], message: "Initial commit", author: person }));

  function ancestors(sha) {
    const seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      stack.push(...commits.get(current).parents);
    }
    return seen;
  }

  function mergeBase(a, b) {
    const fromA = ancestors(a);
    // Breadth-first from b: the first ancestor of b that a also reaches.
    const queue = [b];
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      if (fromA.has(current)) return current;
      queue.push(...commits.get(current).parents);
    }
    return null;
  }

  const treeOf = (commitSha) => trees.get(commits.get(commitSha).tree);

  function diffTrees(before, after) {
    const files = [];
    for (const [path, sha] of after) {
      if (!before.has(path)) files.push({ filename: path, status: "added", sha });
      else if (before.get(path) !== sha) files.push({ filename: path, status: "modified", sha });
    }
    for (const path of before.keys()) if (!after.has(path)) files.push({ filename: path, status: "removed" });
    return files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  }

  function compare(base, head) {
    const baseSha = refs.get(base) || (commits.has(base) ? base : null);
    const headSha = refs.get(head) || (commits.has(head) ? head : null);
    if (!baseSha || !headSha) return null;
    const baseAncestors = ancestors(baseSha);
    const headAncestors = ancestors(headSha);
    const ahead = [...headAncestors].filter((sha) => !baseAncestors.has(sha)).length;
    const behind = [...baseAncestors].filter((sha) => !headAncestors.has(sha)).length;
    const from = mergeBase(baseSha, headSha);
    const files = diffTrees(treeOf(from), treeOf(headSha)).map((file) => ({
      ...file,
      blob_url: `https://github.com/${owner}/${repo}/blob/${headSha}/${file.filename}`,
    }));
    return { status: ahead && behind ? "diverged" : ahead ? "ahead" : behind ? "behind" : "identical", ahead_by: ahead, behind_by: behind, files, merge_base_commit: { sha: from } };
  }

  // Three-way merge of trees; null when both sides changed the same path.
  async function mergeTrees(ours, theirs) {
    const base = treeOf(mergeBase(ours, theirs));
    const mine = treeOf(ours);
    const other = treeOf(theirs);
    const result = new Map(mine);
    for (const path of new Set([...base.keys(), ...mine.keys(), ...other.keys()])) {
      const b = base.get(path);
      const m = mine.get(path);
      const o = other.get(path);
      if (o === b || o === m) continue;
      if (m !== b) return null;
      if (o === undefined) result.delete(path);
      else result.set(path, o);
    }
    return storeTree(result);
  }

  function startCi(sha, event) {
    for (const name of REQUIRED_CHECKS) {
      checkRuns.push({
        id: nextId++,
        name,
        head_sha: sha,
        event,
        status: "queued",
        conclusion: null,
        pendingConclusion: settings.conclusions[name] || "success",
        readsLeft: ciReads,
        app: { slug: "github-actions" },
        html_url: `https://github.com/${owner}/${repo}/actions/runs/${nextId}/job/${nextId}`,
      });
    }
  }

  const openPullFor = (branch) => pulls.find((pull) => pull.state === "open" && pull.head.ref === branch);

  // A ref moved: a person's push to a pull request's branch starts CI; the
  // baseline workflow's GITHUB_TOKEN push does not.
  function afterPush(branch, sha, byBot) {
    const pull = openPullFor(branch);
    if (pull && !byBot) startCi(sha, "pull_request");
    if (branch === "main" && !byBot) startCi(sha, "push");
  }

  function advanceRun(run) {
    if (run.status === "completed") return;
    run.readsLeft -= 1;
    run.status = run.readsLeft <= 0 ? "completed" : "in_progress";
    if (run.status === "completed") run.conclusion = run.pendingConclusion;
  }

  async function advanceWorkflow(run) {
    if (run.status === "completed") return;
    run.readsLeft -= 1;
    if (run.readsLeft > 0) {
      run.status = "in_progress";
      return;
    }
    run.status = "completed";
    run.conclusion = run.name === "Update visual baselines" ? settings.baselineConclusion : "success";
    if (run.name === "Update visual baselines" && run.conclusion === "success") {
      // The workflow commits regenerated PNGs when a captured page changed.
      const head = refs.get(run.head_branch);
      const changed = compare("main", run.head_branch).files.map((file) => file.filename);
      const pngs = changed.flatMap((path) => BASELINE_PNGS[path] || []);
      if (pngs.length) {
        const tree = await storeFiles(treeOf(head), pngs.map((path) => [path, `PNG regenerated for ${head.slice(0, 7)}`]));
        const sha = await storeCommit({ tree, parents: [head], message: `Regenerate Win32 visual baselines for ${head.slice(0, 7)}`, author: BOT });
        refs.set(run.head_branch, sha);
        afterPush(run.head_branch, sha, true);
      }
    }
  }

  function pullJson(pull) {
    pull.head.sha = refs.get(pull.head.ref) || pull.head.sha;
    return {
      number: pull.number,
      state: pull.state,
      merged: pull.merged,
      title: pull.title,
      body: pull.body,
      head: { ...pull.head },
      base: { ...pull.base },
      mergeable: pull.mergeable,
      mergeable_state: pull.mergeable_state,
      merge_commit_sha: pull.merge_commit_sha || null,
      html_url: `https://github.com/${owner}/${repo}/pull/${pull.number}`,
      created_at: pull.created_at,
    };
  }

  async function computeMergeable(pull) {
    if (pull.state !== "open") return;
    if (pull.mergeable === null && !pull.computed) {
      pull.computed = true; // the first read says null, like GitHub's background job
      return;
    }
    const merged = settings.conflicts ? null : await mergeTrees(refs.get(pull.base.ref), refs.get(pull.head.ref));
    pull.mergeable = merged !== null;
    pull.mergeable_state = merged === null ? "dirty" : "clean";
  }

  const routes = [
    ["GET", /^$/, () => json(200, { full_name: `${owner}/${repo}`, default_branch: "main", private: true, permissions: { admin: true, push: true, pull: true } })],
    ["GET", /^\/git\/ref\/heads\/(.+)$/, (match) => {
      const sha = refs.get(decodeURIComponent(match[1]));
      return sha ? json(200, { ref: `refs/heads/${match[1]}`, object: { sha, type: "commit" } }) : error(404, "Not Found");
    }],
    ["GET", /^\/git\/commits\/([0-9a-f]+)$/, (match) => {
      const commit = commits.get(match[1]);
      if (!commit) return error(404, "Not Found");
      return json(200, { sha: commit.sha, tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })), message: commit.message, author: commit.author, committer: commit.committer });
    }],
    ["GET", /^\/git\/trees\/([0-9a-f]+)$/, (match) => {
      const tree = trees.get(match[1]);
      if (!tree) return error(404, "Not Found");
      const entries = [];
      const folders = new Set();
      for (const [path, sha] of tree) {
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join("/"));
        entries.push({ path, mode: "100644", type: "blob", sha });
      }
      for (const folder of folders) entries.push({ path: folder, mode: "040000", type: "tree", sha: "0".repeat(40) });
      return json(200, { sha: match[1], tree: entries, truncated: false });
    }],
    ["GET", /^\/git\/blobs\/([0-9a-f]+)$/, (match, request) => {
      const text = blobs.get(match[1]);
      if (text === undefined) return error(404, "Not Found");
      if ((request.headers.get("Accept") || "").includes("raw")) return new Response(encoder.encode(text), { status: 200 });
      let binary = "";
      for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
      return json(200, { sha: match[1], content: btoa(binary), encoding: "base64" });
    }],
    ["POST", /^\/git\/refs$/, async (match, request, body) => {
      const name = body.ref.replace(/^refs\/heads\//, "");
      if (refs.has(name)) return error(422, "Reference already exists");
      if (!commits.has(body.sha)) return error(422, "Object does not exist");
      refs.set(name, body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha, type: "commit" } });
    }],
    ["POST", /^\/git\/trees$/, async (match, request, body) => {
      const base = body.base_tree ? trees.get(body.base_tree) : new Map();
      if (!base) return error(422, "base_tree is not a tree");
      const changes = [];
      for (const entry of body.tree) {
        if (entry.content !== undefined) changes.push([entry.path, entry.content]);
        else if (entry.sha === null) changes.push([entry.path, null]);
      }
      const sha = await storeFiles(base, changes);
      return json(201, { sha, truncated: false });
    }],
    ["POST", /^\/git\/commits$/, async (match, request, body) => {
      if (!trees.has(body.tree) || !body.parents.every((sha) => commits.has(sha))) return error(422, "Tree or parent does not exist");
      const sha = await storeCommit({ tree: body.tree, parents: body.parents, message: body.message, author: person });
      return json(201, { sha, tree: { sha: body.tree }, parents: body.parents.map((parent) => ({ sha: parent })) });
    }],
    ["PATCH", /^\/git\/refs\/heads\/(.+)$/, async (match, request, body) => {
      const name = decodeURIComponent(match[1]);
      const current = refs.get(name);
      if (!current) return error(422, "Reference does not exist");
      if (!commits.has(body.sha)) return error(422, "Object does not exist");
      if (!body.force && !ancestors(body.sha).has(current)) return error(422, "Update is not a fast forward");
      refs.set(name, body.sha);
      afterPush(name, body.sha, false);
      return json(200, { ref: `refs/heads/${name}`, object: { sha: body.sha, type: "commit" } });
    }],
    ["DELETE", /^\/git\/refs\/heads\/(.+)$/, (match) => {
      const name = decodeURIComponent(match[1]);
      if (!refs.has(name)) return error(422, "Reference does not exist");
      refs.delete(name);
      return new Response(null, { status: 204 });
    }],
    ["GET", /^\/compare\/(.+)\.\.\.(.+)$/, (match) => {
      const result = compare(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      return result ? json(200, result) : error(404, "Not Found");
    }],
    ["GET", /^\/pulls$/, (match, request, body, url) => {
      const head = (url.searchParams.get("head") || "").split(":").pop();
      const base = url.searchParams.get("base");
      const state = url.searchParams.get("state") || "open";
      const list = pulls.filter((pull) => (state === "all" || pull.state === state) && (!head || pull.head.ref === head) && (!base || pull.base.ref === base));
      return json(200, list.map(pullJson));
    }],
    ["POST", /^\/pulls$/, (match, request, body) => {
      if (!refs.has(body.head)) return error(422, "Validation Failed: head does not exist");
      if (openPullFor(body.head)) return error(422, `A pull request already exists for ${owner}:${body.head}.`);
      const comparison = compare(body.base, body.head);
      if (!comparison.ahead_by) return error(422, `No commits between ${body.base} and ${body.head}`);
      const pull = {
        number: pulls.length + 1,
        state: "open",
        merged: false,
        title: body.title,
        body: body.body,
        head: { ref: body.head, sha: refs.get(body.head) },
        base: { ref: body.base },
        mergeable: null,
        mergeable_state: "unknown",
        created_at: new Date(now()).toISOString(),
      };
      pulls.push(pull);
      startCi(pull.head.sha, "pull_request");
      return json(201, pullJson(pull));
    }],
    ["GET", /^\/pulls\/(\d+)$/, async (match) => {
      const pull = pulls[Number(match[1]) - 1];
      if (!pull) return error(404, "Not Found");
      await computeMergeable(pull);
      return json(200, pullJson(pull));
    }],
    ["PATCH", /^\/pulls\/(\d+)$/, (match, request, body) => {
      const pull = pulls[Number(match[1]) - 1];
      if (!pull) return error(404, "Not Found");
      if (body.body !== undefined) pull.body = body.body;
      if (body.title !== undefined) pull.title = body.title;
      if (body.state === "closed" && !pull.merged) pull.state = "closed";
      return json(200, pullJson(pull));
    }],
    ["GET", /^\/pulls\/(\d+)\/files$/, (match) => {
      const pull = pulls[Number(match[1]) - 1];
      if (!pull) return error(404, "Not Found");
      return json(200, compare(pull.base.ref, pull.head.ref).files);
    }],
    ["PUT", /^\/pulls\/(\d+)\/merge$/, async (match, request, body) => {
      const pull = pulls[Number(match[1]) - 1];
      if (!pull || pull.state !== "open") return error(404, "Not Found");
      const head = refs.get(pull.head.ref);
      if (body.sha && body.sha !== head) return error(409, "Head branch was modified. Review and try the merge again.");
      const tree = settings.conflicts ? null : await mergeTrees(refs.get(pull.base.ref), head);
      if (!tree) return error(405, "Pull Request is not mergeable");
      const sha = await storeCommit({
        tree,
        parents: [refs.get(pull.base.ref), head],
        message: `Merge pull request #${pull.number} from ${owner}/${pull.head.ref}\n\n${pull.title}`,
        author: person,
      });
      refs.set(pull.base.ref, sha);
      Object.assign(pull, { state: "closed", merged: true, merge_commit_sha: sha });
      afterPush(pull.base.ref, sha, false);
      workflowRuns.push({
        id: nextId++,
        name: "pages-build-deployment",
        path: "dynamic/pages/pages-build-deployment",
        head_branch: pull.base.ref,
        head_sha: sha,
        event: "dynamic",
        status: "queued",
        conclusion: null,
        readsLeft: workflowReads,
        created_at: new Date(now()).toISOString(),
        html_url: `https://github.com/${owner}/${repo}/actions/runs/${nextId}`,
      });
      return json(200, { sha, merged: true, message: "Pull Request successfully merged" });
    }],
    ["PUT", /^\/pulls\/(\d+)\/update-branch$/, async (match, request, body) => {
      const pull = pulls[Number(match[1]) - 1];
      const head = refs.get(pull.head.ref);
      if (body.expected_head_sha && body.expected_head_sha !== head) return error(422, "expected_head_sha does not match");
      const tree = await mergeTrees(head, refs.get(pull.base.ref));
      if (!tree) return error(422, "merge conflict between base and head");
      const sha = await storeCommit({ tree, parents: [head, refs.get(pull.base.ref)], message: `Merge branch '${pull.base.ref}' into ${pull.head.ref}`, author: person });
      refs.set(pull.head.ref, sha);
      afterPush(pull.head.ref, sha, false);
      return json(202, { message: "Updating pull request branch.", url: `${API}/repos/${owner}/${repo}/pulls/${pull.number}` });
    }],
    // Merging one branch into another without a pull request, as GitHub does
    // it at once: 201 and the merge commit, 204 when base has head already,
    // 409 on a conflict (here, both sides changed the same file).
    ["POST", /^\/merges$/, async (match, request, body) => {
      const base = refs.get(body.base);
      const head = refs.get(body.head) || (commits.has(body.head) ? body.head : null);
      if (!base || !head) return error(404, "Base or head does not exist");
      if (ancestors(base).has(head)) return new Response(null, { status: 204 });
      const tree = await mergeTrees(base, head);
      if (!tree) return error(409, "Merge conflict");
      const message = body.commit_message || `Merge ${body.head} into ${body.base}`;
      const sha = await storeCommit({ tree, parents: [base, head], message, author: person });
      refs.set(body.base, sha);
      afterPush(body.base, sha, false);
      return json(201, { sha, commit: { message }, parents: [{ sha: base }, { sha: head }] });
    }],
    // The commits that changed a path, newest first, from `sha` back: those
    // whose blob for it differs from every parent's, as git's simplified
    // history lists them.
    ["GET", /^\/commits$/, (match, request, body, url) => {
      const from = refs.get(url.searchParams.get("sha")) || url.searchParams.get("sha");
      const path = url.searchParams.get("path");
      const limit = Number(url.searchParams.get("per_page") || 30);
      if (!commits.has(from)) return error(422, `No commit found for SHA: ${from}`);
      const blobAt = (sha) => treeOf(sha).get(path);
      const listed = [...ancestors(from)]
        .map((sha) => commits.get(sha))
        .filter((commit) => blobAt(commit.sha) !== undefined || commit.parents.some((parent) => blobAt(parent) !== undefined))
        .filter((commit) => (commit.parents.length ? commit.parents.every((parent) => blobAt(parent) !== blobAt(commit.sha)) : blobAt(commit.sha) !== undefined))
        .sort((a, b) => (a.author.date < b.author.date ? 1 : -1))
        .slice(0, limit);
      return json(200, listed.map((commit) => ({ sha: commit.sha, commit: { message: commit.message, tree: { sha: commit.tree }, author: commit.author }, parents: commit.parents.map((sha) => ({ sha })) })));
    }],
    ["GET", /^\/commits\/([0-9a-f]+)\/check-runs$/, (match) => {
      const runs = checkRuns.filter((run) => run.head_sha === match[1]);
      runs.forEach(advanceRun);
      return json(200, {
        total_count: runs.length,
        check_runs: runs.map(({ id, name, head_sha, status, conclusion, app, html_url }) => ({ id, name, head_sha, status, conclusion, app, html_url, details_url: html_url })),
      });
    }],
    ["POST", /^\/actions\/workflows\/([^/]+)\/dispatches$/, (match, request, body) => {
      const file = decodeURIComponent(match[1]);
      const sha = refs.get(body.ref);
      if (!sha) return error(422, `No ref found for: ${body.ref}`);
      if (file === "ci.yml") {
        startCi(sha, "workflow_dispatch");
      }
      workflowRuns.push({
        id: nextId++,
        name: file === "ci.yml" ? "Test suite" : file === "update-visual-baselines.yml" ? "Update visual baselines" : file,
        path: `.github/workflows/${file}`,
        head_branch: body.ref,
        head_sha: sha,
        event: "workflow_dispatch",
        status: "queued",
        conclusion: null,
        readsLeft: workflowReads,
        hiddenReads: settings.dispatchLag,
        created_at: new Date(now()).toISOString(),
        html_url: `https://github.com/${owner}/${repo}/actions/runs/${nextId}`,
      });
      return new Response(null, { status: 204 });
    }],
    ["GET", /^\/actions\/workflows\/([^/]+)\/runs$/, async (match, request, body, url) => {
      const file = decodeURIComponent(match[1]);
      const branch = url.searchParams.get("branch");
      const event = url.searchParams.get("event");
      const runs = workflowRuns
        .filter((run) => run.path === `.github/workflows/${file}` && (!branch || run.head_branch === branch) && (!event || run.event === event))
        .filter(listed)
        .reverse();
      for (const run of runs) await advanceWorkflow(run);
      return json(200, { total_count: runs.length, workflow_runs: runs.map(publicRun) });
    }],
    ["GET", /^\/actions\/runs$/, async (match, request, body, url) => {
      const branch = url.searchParams.get("branch");
      const runs = workflowRuns.filter((run) => !branch || run.head_branch === branch).filter(listed).reverse();
      for (const run of runs) await advanceWorkflow(run);
      return json(200, { total_count: runs.length, workflow_runs: runs.map(publicRun) });
    }],
  ];

  function publicRun({ id, name, path, head_branch, head_sha, event, status, conclusion, created_at, html_url }) {
    return { id, name, path, head_branch, head_sha, event, status, conclusion, created_at, html_url };
  }

  async function fetch(input, init = {}) {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const bodyText = method === "GET" || method === "HEAD" ? "" : await request.text();
    const body = bodyText ? JSON.parse(bodyText) : {};
    const prefix = `/repos/${owner}/${repo}`;
    requests.push({ method, path: url.pathname.replace(prefix, "") + url.search, body: bodyText ? body : undefined });

    if (url.origin !== API) return error(404, "Not a GitHub API URL");
    const token = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
    if (settings.expireNextRequest || !validTokens.has(token)) {
      settings.expireNextRequest = false;
      return error(401, "Bad credentials");
    }
    if (!url.pathname.startsWith(prefix)) return error(404, "Not Found");
    const rest = url.pathname.slice(prefix.length);
    for (const [routeMethod, pattern, handler] of routes) {
      if (routeMethod !== method) continue;
      const match = pattern.exec(rest);
      if (match) return handler(match, request, body, url);
    }
    return error(404, "Not Found");
  }

  return {
    fetch,
    settings,
    requests,
    user,
    acceptToken: (token) => validTokens.add(token),
    revokeToken: (token) => validTokens.delete(token),
    head: (branch) => refs.get(branch) || null,
    branches: () => [...refs.keys()],
    commit: (sha) => commits.get(sha),
    fileAt: (branch, path) => {
      const sha = refs.get(branch);
      const blob = sha && treeOf(sha).get(path);
      return blob ? blobs.get(blob) : null;
    },
    pulls: () => pulls.map(pullJson),
    checkRuns: (sha) => checkRuns.filter((run) => !sha || run.head_sha === sha),
    workflowRuns: () => workflowRuns.map(publicRun),
    // Merges a pull request as the GitHub website would (merge commit; the
    // branch stays, as delete_branch_on_merge is off on the site repositories).
    async mergeOnGitHub(number) {
      const response = await fetch(`${API}/repos/${owner}/${repo}/pulls/${number}/merge`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${[...validTokens][0]}`, "Content-Type": "application/json" },
        body: JSON.stringify({ merge_method: "merge" }),
      });
      return response.json();
    },
    // Closes a pull request without merging, as the GitHub website would.
    async closeOnGitHub(number) {
      const response = await fetch(`${API}/repos/${owner}/${repo}/pulls/${number}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${[...validTokens][0]}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      });
      return response.json();
    },
    // Commits straight to a branch, as another device (or the bot) would.
    async commitAs(branch, changes, { bot = false, message = "Change from elsewhere" } = {}) {
      const head = refs.get(branch);
      const tree = await storeFiles(treeOf(head), Object.entries(changes));
      const sha = await storeCommit({ tree, parents: [head], message, author: bot ? BOT : person });
      refs.set(branch, sha);
      afterPush(branch, sha, bot);
      return sha;
    },
  };
}
