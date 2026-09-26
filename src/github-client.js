// A thin wrapper over the GitHub REST API calls the editor makes, for one
// target repository (src/config.js). It adds the standard headers, retries once
// with a refreshed token after a 401, and turns failures into GitHubError with
// a code the UI can explain. It holds no state beyond the target.
//
// Files are read as blobs by SHA from the tree of the commit the editor loaded,
// so the bytes always match the SHA recorded for stale-file detection. Saves go
// through the Git Data API: one tree and one commit for every changed file, then
// a fast-forward-only update of the branch.

const API = "https://api.github.com";
// The runs that publish a site: GitHub Pages' automatic build, and the live
// site's own workflow, which leaves drafts out.
export const DEPLOY_RUN_NAMES = new Set(["pages-build-deployment", "Publish the live site"]);

export class GitHubError extends Error {
  constructor({ status, code, message, retryAfter = null, details = null }) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.details = details;
  }
}

function errorCode(status, message) {
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 405) return "not_mergeable";
  if (status === 409) return "conflict";
  if (status === 422 && /fast.?forward/i.test(message)) return "not_fast_forward";
  if (status === 422 && /already exists/i.test(message)) return "already_exists";
  if (status === 422 && /does not exist/i.test(message)) return "does_not_exist";
  if (status === 422) return "unprocessable";
  if (status >= 500) return "server_error";
  return "http_error";
}

async function toError(response, nowSeconds) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const message = (body && body.message) || `GitHub answered ${response.status}.`;
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfterHeader = response.headers.get("retry-after");
  if ((response.status === 403 || response.status === 429) && (remaining === "0" || retryAfterHeader)) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : Math.max(0, Math.ceil(reset - nowSeconds()));
    return new GitHubError({ status: response.status, code: "rate_limited", message, retryAfter, details: body });
  }
  return new GitHubError({ status: response.status, code: errorCode(response.status, message), message, details: body });
}

const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

export function createGitHubClient({ target, fetch, getAccessToken, now = () => Date.now() }) {
  const repo = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const nowSeconds = () => now() / 1000;

  async function request(method, path, { body, accept = "application/vnd.github+json", allow = [] } = {}) {
    let token = await getAccessToken();
    for (let attempt = 0; ; attempt += 1) {
      const headers = {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      let response;
      try {
        response = await fetch(`${API}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          // Revalidate every GET with its ETag: never a stale ref or PR state from
          // the HTTP cache, and a 304 does not count against the rate limit.
          cache: method === "GET" ? "no-cache" : "no-store",
        });
      } catch {
        throw new GitHubError({ status: 0, code: "network", message: "No connection to GitHub." });
      }
      if (response.status === 401 && attempt === 0) {
        token = await getAccessToken({ rejected: token });
        continue;
      }
      if (response.ok || allow.includes(response.status)) return response;
      throw await toError(response, nowSeconds);
    }
  }

  const json = async (method, path, options) => {
    const response = await request(method, path, options);
    return response.status === 204 ? null : response.json();
  };

  const client = {
    target,

    getRepo: () => json("GET", repo),

    // The commit SHA a branch points at, or null when the branch does not exist.
    async getRef(branch) {
      const response = await request("GET", `${repo}/git/ref/heads/${encodePath(branch)}`, { allow: [404] });
      if (response.status === 404) return null;
      const ref = await response.json();
      return ref.object.sha;
    },

    getCommit: (sha) => json("GET", `${repo}/git/commits/${sha}`),

    // Every file path in a commit, with its blob SHA.
    async getCommitTree(commitSha) {
      const commit = await client.getCommit(commitSha);
      const tree = await json("GET", `${repo}/git/trees/${commit.tree.sha}?recursive=1`);
      if (tree.truncated) {
        throw new GitHubError({ status: 200, code: "tree_truncated", message: "The repository tree is too large to list." });
      }
      const files = new Map();
      for (const entry of tree.tree) if (entry.type === "blob") files.set(entry.path, entry.sha);
      return { commit, treeSha: commit.tree.sha, files };
    },

    // A text file's exact bytes, decoded as UTF-8 (invalid UTF-8 throws). The
    // JSON form (base64) is always served by api.github.com, the only API host
    // the CSP's connect-src allows.
    async getBlobText(sha) {
      const blob = await json("GET", `${repo}/git/blobs/${sha}`);
      if (blob.encoding !== "base64") {
        throw new GitHubError({ status: 200, code: "unexpected", message: `The file came back as ${blob.encoding}, not base64.` });
      }
      const binary = atob(blob.content.replace(/\s/g, ""));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },

    async createBranch(branch, sha) {
      try {
        await json("POST", `${repo}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha } });
        return sha;
      } catch (error) {
        if (error instanceof GitHubError && error.code === "already_exists") return client.getRef(branch);
        throw error;
      }
    },

    // One commit with every file, fast-forwarding `branch` from parentSha. A
    // non-fast-forward (someone moved the branch) throws code "not_fast_forward".
    async commitFiles({ branch, parentSha, files, message }) {
      const parent = await client.getCommit(parentSha);
      const tree = await json("POST", `${repo}/git/trees`, {
        body: {
          base_tree: parent.tree.sha,
          tree: files.map(({ path, content }) => ({ path, mode: "100644", type: "blob", content })),
        },
      });
      const commit = await json("POST", `${repo}/git/commits`, {
        body: { message, tree: tree.sha, parents: [parentSha] },
      });
      await json("PATCH", `${repo}/git/refs/heads/${encodePath(branch)}`, { body: { sha: commit.sha, force: false } });
      return { sha: commit.sha, treeSha: tree.sha };
    },

    compare: (base, head) => json("GET", `${repo}/compare/${encodePath(base)}...${encodePath(head)}`),

    async findOpenPr() {
      const head = `${target.owner}:${target.branch}`;
      const pulls = await json(
        "GET",
        `${repo}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(target.base)}&per_page=10`,
      );
      return pulls[0] || null;
    },

    createPr: ({ title, body }) =>
      json("POST", `${repo}/pulls`, { body: { title, head: target.branch, base: target.base, body } }),

    updatePrBody: (number, body) => json("PATCH", `${repo}/pulls/${number}`, { body: { body } }),

    // Title and description together ({ title, body }; either may be left out).
    updatePr: (number, fields) => json("PATCH", `${repo}/pulls/${number}`, { body: fields }),

    getPr: (number) => json("GET", `${repo}/pulls/${number}`),

    async prFiles(number) {
      return json("GET", `${repo}/pulls/${number}/files?per_page=100`);
    },

    // Check runs from GitHub Actions on a commit (other apps' checks are ignored).
    async listCheckRuns(sha) {
      const result = await json("GET", `${repo}/commits/${sha}/check-runs?per_page=100`);
      return result.check_runs.filter((run) => run.app && run.app.slug === "github-actions");
    },

    dispatchWorkflow: (file, ref) =>
      json("POST", `${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, { body: { ref } }),

    async listWorkflowRuns(file, { branch, event = "workflow_dispatch" } = {}) {
      const query = new URLSearchParams({ per_page: "10" });
      if (branch) query.set("branch", branch);
      if (event) query.set("event", event);
      const result = await json("GET", `${repo}/actions/workflows/${encodeURIComponent(file)}/runs?${query}`);
      return result.workflow_runs;
    },

    // The deployment runs on the base branch, newest first: GitHub Pages' own
    // automatic build, or the workflow that builds thomaswhite.me leaving
    // drafts out ("Publish the live site", the site's .github/workflows/pages.yml).
    async deployRuns() {
      const query = new URLSearchParams({ branch: target.base, per_page: "10" });
      const result = await json("GET", `${repo}/actions/runs?${query}`);
      return result.workflow_runs.filter((run) => DEPLOY_RUN_NAMES.has(run.name));
    },

    // Merge commit, and only if the PR head is still `headSha` (409 otherwise).
    mergePr: (number, headSha) =>
      json("PUT", `${repo}/pulls/${number}/merge`, { body: { merge_method: "merge", sha: headSha } }),

    updateBranch: (number, expectedHeadSha) =>
      json("PUT", `${repo}/pulls/${number}/update-branch`, { body: { expected_head_sha: expectedHeadSha } }),

    async deleteBranch(branch) {
      await request("DELETE", `${repo}/git/refs/heads/${encodePath(branch)}`, { allow: [404, 422] });
    },
  };
  return client;
}

// Git's blob id for a UTF-8 text: SHA-1 of "blob <byte length>\0<bytes>". Lets
// the editor know a file's new blob SHA after a save without another request.
export async function gitBlobSha(text) {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
