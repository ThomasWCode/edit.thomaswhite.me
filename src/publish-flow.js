// Save and Publish, against the target repository.
//
// Save: one commit of every changed file on the `edits` branch (created from
// main when missing). Nothing runs on GitHub until Publish, unless a pull
// request is already open (then CI runs on the new commit, as on any push).
// Publish: refresh the visual baselines on `edits` when a captured page
// changed, open the pull request (which starts CI), wait for the required
// checks, then merge with a merge commit and delete `edits`.
//
// Every write re-reads the ref it depends on first. Stale work is detected per
// file: if `edits` moved since the page was loaded, a file whose blob is
// unchanged on the new head is committed on top (the baseline bot only touches
// PNGs); a file that changed there is a conflict for the person to resolve.
//
// One mutation runs at a time (`busy`). The UI renders `state` and calls the
// methods; `sleep` and `now` are injected so tests run instantly.

import { describeFile, hasAutoTitle, noteOf, otherFile, prDescription, summarise } from "./describe.js";
import { gitBlobSha, GitHubError } from "./github-client.js";
import { sortPages } from "./site-files.js";

// The title when the changes can't be described (and of pull requests opened
// before titles were generated).
export const PR_TITLE = "Text edits from the editor";
export const BOT_LOGIN = "github-actions[bot]";
const BASELINE_POLL_MS = 15_000;
const BASELINE_TIMEOUT_MS = 30 * 60_000;
const UPDATE_POLL_MS = 2_000;
const UPDATE_TIMEOUT_MS = 60_000;
const MERGEABLE_RETRIES = 5;

export class SaveConflictError extends Error {
  constructor(conflicts, head) {
    super(`${conflicts.join(", ")} changed on GitHub since this tab loaded ${conflicts.length === 1 ? "it" : "them"}.`);
    this.name = "SaveConflictError";
    this.conflicts = conflicts;
    this.head = head;
  }
}

export class BusyError extends Error {
  constructor() {
    super("Another GitHub action is still running.");
    this.name = "BusyError";
  }
}

export function prBody(paths) {
  const pages = paths.filter((path) => path.endsWith(".html"));
  const other = paths.filter((path) => !path.endsWith(".html"));
  const list = (items) => items.map((path) => `- \`${path}\``).join("\n");
  return [
    "Edits made at https://edit.thomaswhite.me.",
    "",
    pages.length ? `Pages changed:\n\n${list(pages)}` : "No pages changed.",
    other.length ? `\nOther files:\n\n${list(other)}` : "",
    "",
    "If a fact changed, update `docs/record.md` (the editor's Record tab) in this pull request before merging.",
    "",
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");
}

const isBotCommit = (commit) =>
  [commit.author && commit.author.name, commit.committer && commit.committer.name].includes(BOT_LOGIN);

// The latest run of each required check on a commit.
export function summariseChecks(runs, required) {
  const latest = new Map();
  for (const run of runs) {
    const previous = latest.get(run.name);
    if (!previous || run.id > previous.id) latest.set(run.name, run);
  }
  const checks = required.map((name) => {
    const run = latest.get(name);
    if (!run) return { name, state: "waiting", url: null };
    if (run.status !== "completed") return { name, state: "running", url: run.html_url || null };
    const good = ["success", "neutral", "skipped"].includes(run.conclusion);
    return { name, state: good ? "passed" : "failed", conclusion: run.conclusion, url: run.html_url || run.details_url || null };
  });
  const failed = checks.filter((check) => check.state === "failed");
  return {
    checks,
    failed,
    passed: checks.every((check) => check.state === "passed"),
    started: checks.some((check) => check.state !== "waiting"),
  };
}

export function createPublishFlow({ client, target, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), onChange = () => {} }) {
  const state = {
    phase: "idle",
    busy: false,
    head: null,
    onBranch: false,
    files: new Map(),
    pr: null,
    checks: [],
    checkedSha: null,
    mergeable: null,
    behindBy: 0,
    aheadBy: 0,
    changedPaths: [],
    notice: "",
    error: null,
    baselineRun: null,
    changedImages: [],
    canRefreshScreenshots: false,
    canStartChecks: false,
    mergedSha: null,
    deploy: null,
  };

  const emit = () => onChange(state);
  const set = (changes) => {
    Object.assign(state, changes);
    emit();
  };

  async function exclusive(task) {
    if (state.busy) throw new BusyError();
    set({ busy: true, error: null });
    try {
      return await task();
    } catch (error) {
      set({ error });
      throw error;
    } finally {
      set({ busy: false });
    }
  }

  const baselineChanged = () => state.changedPaths.some((path) => target.visualBaselinePages.includes(path));

  // The branch's changes against main, from their merge base as the pull
  // request shows them: { files, screenshots, title }. Only reads.
  async function describeBranch() {
    const comparison = await client.compare(target.base, target.branch);
    const base = comparison.merge_base_commit ? (await client.getCommitTree(comparison.merge_base_commit.sha)).files : new Map();
    const files = [];
    const screenshots = [];
    // In the editor's order, not GitHub's alphabetical one: pages as the site
    // lists them, then the Record, then the rest.
    const changed = comparison.files || [];
    const pages = sortPages(changed.map((file) => file.filename).filter((path) => path.endsWith(".html")), { order: target.pageOrder, last: target.lockedFiles });
    const rank = (path) => (path.endsWith(".html") ? pages.indexOf(path) : path === "docs/record.md" ? pages.length : pages.length + 1);
    for (const file of [...changed].sort((a, b) => rank(a.filename) - rank(b.filename))) {
      if (/\.png$/i.test(file.filename)) {
        screenshots.push(file.filename);
        continue;
      }
      if (!/\.(html|md)$/.test(file.filename)) {
        files.push(otherFile(file.filename, file.status));
        continue;
      }
      const beforeSha = base.get(file.filename) ?? null;
      const afterSha = file.status === "removed" ? null : file.sha;
      const [before, after] = await Promise.all([
        beforeSha ? client.getBlobText(beforeSha) : null,
        afterSha ? client.getBlobText(afterSha) : null,
      ]);
      files.push(describeFile({ path: file.filename, before, after }));
    }
    return { files, screenshots, title: files.length ? summarise(files) : PR_TITLE };
  }

  // Rewrites an open pull request's description from the branch, keeping your
  // note (or setting `note`), and its title while it is still the generated
  // one (or setting `title`). `pr` should be fresh from GitHub.
  async function refreshPr(pr, { title = null, note = null } = {}) {
    const described = await describeBranch();
    const body = prDescription({ note: note ?? noteOf(pr.body), files: described.files, screenshots: described.screenshots, autoTitle: described.title });
    const nextTitle = title && title.trim() ? title.trim() : hasAutoTitle(pr, PR_TITLE) ? described.title : pr.title;
    const updated = await client.updatePr(pr.number, { title: nextTitle, body });
    return { ...pr, ...updated, title: nextTitle, body };
  }

  async function readBranchState() {
    const comparison = await client.compare(target.base, target.branch);
    set({
      aheadBy: comparison.ahead_by,
      behindBy: comparison.behind_by,
      changedPaths: (comparison.files || []).map((file) => file.filename),
    });
    return comparison;
  }

  // Loads the branch the editor works on: `edits` if it exists, else main.
  // An `edits` holding nothing main lacks, with no pull request open, is
  // deleted first: a pull request merged on GitHub itself leaves its branch
  // behind, and loading it would show an older copy of the site.
  async function load() {
    return exclusive(async () => {
      set({ phase: "loading", notice: "" });
      let branchHead = await client.getRef(target.branch);
      const pr = branchHead ? await client.findOpenPr() : null;
      if (branchHead && !pr && (await client.compare(target.base, branchHead)).ahead_by === 0) {
        await client.deleteBranch(target.branch);
        branchHead = null;
      }
      const head = branchHead || (await client.getRef(target.base));
      if (!head) throw new GitHubError({ status: 404, code: "not_found", message: `${target.base} was not found.` });
      const { files } = await client.getCommitTree(head);
      set({ head, onBranch: Boolean(branchHead), files, pr, phase: pr ? "checking" : "ready" });
      if (branchHead) await readBranchState();
      else set({ aheadBy: 0, behindBy: 0, changedPaths: [] });
      return { head, files, onBranch: Boolean(branchHead), pr };
    });
  }

  // Commits `changes` ([{ path, text, loadedSha }]; loadedSha is null for a new
  // file) as one commit on `edits`. Returns { sha, files } where files maps
  // each saved path to its new blob SHA.
  //
  // A file whose blob on the current head already equals the text being saved
  // is left out (a save whose response was lost, then retried), so a retry
  // never commits the same change twice. Once the branch has moved, the save
  // has happened: the follow-up reads can fail without failing it.
  async function save(changes, message) {
    return exclusive(async () => {
      set({ phase: "saving", notice: "" });
      const newShas = new Map();
      for (const change of changes) newShas.set(change.path, await gitBlobSha(change.text));
      let sha;
      let tree = null;
      for (let attempt = 1; ; attempt += 1) {
        let head = await client.getRef(target.branch);
        tree = null;
        if (!head) {
          const baseHead = await client.getRef(target.base);
          head = await client.createBranch(target.branch, baseHead);
        }
        let pending = changes;
        if (head !== state.head) {
          ({ files: tree } = await client.getCommitTree(head));
          const conflicts = [];
          pending = [];
          for (const change of changes) {
            const current = tree.get(change.path) ?? null;
            if (current === newShas.get(change.path)) continue;
            if (current !== (change.loadedSha ?? null)) conflicts.push(change.path);
            else pending.push(change);
          }
          if (conflicts.length) {
            set({ phase: state.pr ? "checking" : "ready" });
            throw new SaveConflictError(conflicts, head);
          }
        }
        if (!pending.length) {
          sha = head;
          break;
        }
        try {
          ({ sha } = await client.commitFiles({
            branch: target.branch,
            parentSha: head,
            files: pending.map(({ path, text }) => ({ path, content: text })),
            message,
          }));
          break;
        } catch (error) {
          if (error instanceof GitHubError && error.code === "not_fast_forward" && attempt < 3) continue;
          set({ phase: state.pr ? "checking" : "ready" });
          throw error;
        }
      }

      const files = new Map(tree || state.files);
      for (const [path, blob] of newShas) files.set(path, blob);
      set({ head: sha, onBranch: true, files });
      let pr = state.pr;
      let notice;
      try {
        await readBranchState();
        pr = pr || (await client.findOpenPr());
        if (pr) pr = await refreshPr(await client.getPr(pr.number));
        notice = pr
          ? "Saved. The pull request is open, so its checks run again on this commit."
          : "Saved to the edits branch. Nothing runs on GitHub until you publish.";
      } catch {
        notice = "Saved. GitHub didn't answer a follow-up request, so the branch summary may be behind until the next refresh.";
      }
      set(pr ? { pr, phase: "checking", checks: [], checkedSha: null, notice } : { phase: "ready", notice });
      return { sha, files: new Map(newShas) };
    });
  }

  // Dispatches the baseline workflow on `edits` and waits for its run.
  async function runBaselines() {
    const before = await client.getRef(target.branch);
    // The dispatch doesn't name the run it starts, and GitHub lists it only
    // after a few seconds: runs already listed are set aside, so the run
    // followed is a new one, never an earlier run on the same branch.
    const earlier = new Set((await client.listWorkflowRuns(target.baselineWorkflow, { branch: target.branch })).map((item) => item.id));
    const dispatchedAt = now();
    set({ phase: "baselines", notice: "Updating the screenshot baselines on GitHub (about four minutes)…", baselineRun: null, changedImages: [] });
    await client.dispatchWorkflow(target.baselineWorkflow, target.branch);
    let run = null;
    while (now() - dispatchedAt < BASELINE_TIMEOUT_MS) {
      await sleep(run ? BASELINE_POLL_MS : 5_000);
      const runs = await client.listWorkflowRuns(target.baselineWorkflow, { branch: target.branch });
      run = runs.find((item) => !earlier.has(item.id)) || null;
      if (run) set({ baselineRun: { status: run.status, conclusion: run.conclusion, url: run.html_url } });
      if (run && run.status === "completed") break;
    }
    if (!run || run.status !== "completed") throw new Error("The baseline update took longer than 30 minutes. Check it on GitHub.");
    if (run.conclusion !== "success") throw new Error("The baseline update failed. Open its run on GitHub for the details.");
    const after = await client.getRef(target.branch);
    let changedImages = [];
    if (after !== before) {
      const comparison = await client.compare(before, after);
      changedImages = (comparison.files || []).filter((file) => file.filename.endsWith(".png")).map((file) => ({ path: file.filename, url: file.blob_url || null }));
    }
    set({ head: after, changedImages });
    return { moved: after !== before };
  }

  // Publish: baselines when needed, then the pull request, titled `title` (or
  // the generated title) with `note` above the generated list of changes.
  async function publish({ title = "", note = "" } = {}) {
    return exclusive(async () => {
      const comparison = await readBranchState();
      if (comparison.ahead_by === 0) {
        set({ phase: "ready", notice: "Nothing to publish: edits and main are the same." });
        return { published: false };
      }
      let movedByBot = false;
      if (baselineChanged()) {
        const head = await client.getRef(target.branch);
        const commit = await client.getCommit(head);
        if (!isBotCommit(commit)) movedByBot = (await runBaselines()).moved;
      }
      set({ phase: "opening-pr", notice: "Opening the pull request…" });
      await readBranchState();
      let pr = await client.findOpenPr();
      if (!pr) {
        let described = null;
        try {
          described = await describeBranch();
        } catch {
          // A description that fails to build never stops a publish.
        }
        const autoTitle = described ? described.title : PR_TITLE;
        const body = described
          ? prDescription({ note, files: described.files, screenshots: described.screenshots, autoTitle })
          : [note.trim(), prBody(state.changedPaths)].filter(Boolean).join("\n\n");
        // A new pull request starts CI itself; dispatching as well would run it twice.
        pr = await client.createPr({ title: title.trim() || autoTitle, body });
      } else {
        pr = await refreshPr(await client.getPr(pr.number), { title, note: note.trim() ? note : null });
        // Commits pushed by the baseline workflow's GITHUB_TOKEN start no workflow.
        if (movedByBot) await client.dispatchWorkflow(target.ciWorkflow, target.branch);
      }
      set({ pr, phase: "checking", checks: [], checkedSha: null, notice: "Waiting for the checks (about fifteen minutes)." });
      return { published: true, pr };
    });
  }

  // Reads the pull request and its checks once; the UI calls this every 30
  // seconds while the tab is visible. Not exclusive: it only reads.
  async function refreshChecks() {
    if (!state.pr) return state;
    let pr = await client.getPr(state.pr.number);
    for (let attempt = 0; pr.mergeable === null && attempt < MERGEABLE_RETRIES; attempt += 1) {
      await sleep(2_000);
      pr = await client.getPr(state.pr.number);
    }
    // Merged or closed on GitHub itself: the interface reloads from the new state.
    if (pr.state !== "open") {
      if (pr.merged) {
        set({
          pr: null,
          phase: "published",
          mergedSha: pr.merge_commit_sha || null,
          mergedAt: now(),
          aheadBy: 0,
          behindBy: 0,
          changedPaths: [],
          checks: [],
          notice: `The pull request was merged on GitHub. ${new URL(target.assets).host} updates in about a minute.`,
        });
      } else {
        set({ pr: null, phase: "ready", checks: [], notice: "The pull request was closed on GitHub without merging." });
      }
      return state;
    }
    const runs = await client.listCheckRuns(pr.head.sha);
    const summary = summariseChecks(runs, target.requiredChecks);
    await readBranchState();
    const conflicted = pr.mergeable === false;
    const browserFailed = summary.failed.some((check) => /browser|visual/i.test(check.name));
    let phase = "checking";
    if (conflicted || summary.failed.length) phase = "attention";
    else if (summary.passed && pr.mergeable === true) phase = "publishable";
    set({
      pr,
      checks: summary.checks,
      checkedSha: pr.head.sha,
      mergeable: pr.mergeable,
      phase: state.busy ? state.phase : phase,
      canRefreshScreenshots: browserFailed && baselineChanged(),
      canStartChecks: !summary.started,
      notice: conflicted
        ? "This conflicts with main. Resolve it on the edits branch in a Claude session."
        : summary.failed.length
          ? `${summary.failed.map((check) => check.name).join(" and ")} failed.`
          : summary.passed
            ? "All checks passed."
            : "Waiting for the checks.",
    });
    return state;
  }

  // Merge commit, only if the head is still the one whose checks passed.
  async function merge() {
    return exclusive(async () => {
      const pr = await client.getPr(state.pr.number);
      if (pr.head.sha !== state.checkedSha) {
        set({ phase: "checking", notice: "The pull request changed since its checks ran; checking again." });
        return { merged: false };
      }
      set({ phase: "publishing", notice: "Merging…" });
      let result;
      try {
        result = await client.mergePr(pr.number, pr.head.sha);
      } catch (error) {
        if (error instanceof GitHubError && ["conflict", "not_mergeable"].includes(error.code)) {
          set({ phase: "attention", notice: error.code === "conflict" ? "The pull request changed during the merge; checking again." : `GitHub can't merge it yet (${pr.mergeable_state}).` });
          return { merged: false };
        }
        throw error;
      }
      // Delete edits only if it is still the head that was merged: another tab
      // may have saved on top meanwhile, and deleting would lose that commit.
      const branchHead = await client.getRef(target.branch);
      const newerSaves = Boolean(branchHead) && branchHead !== pr.head.sha;
      if (branchHead && !newerSaves) await client.deleteBranch(target.branch);
      const host = new URL(target.assets).host;
      set({
        phase: "published",
        pr: null,
        mergedSha: result.sha,
        mergedAt: now(),
        onBranch: newerSaves,
        aheadBy: 0,
        behindBy: 0,
        changedPaths: [],
        checks: [],
        notice: newerSaves
          ? `Merged; ${host} updates in about a minute. The edits branch has newer saves, kept for the next publish.`
          : `Merged. ${host} updates in about a minute.`,
      });
      return { merged: true, sha: result.sha, newerSaves };
    });
  }

  // The GitHub Pages deployment of the merge, for the "published" message.
  async function refreshDeploy() {
    if (!state.mergedSha) return null;
    const runs = await client.deployRuns();
    const run = runs.find((item) => item.head_sha === state.mergedSha) || null;
    set({ deploy: run ? { status: run.status, conclusion: run.conclusion, url: run.html_url } : null });
    return state.deploy;
  }

  // Merges main into edits (the pull request's "Update branch"). GitHub does
  // the merge a moment after accepting the request: this waits for edits to
  // move and reads its new tree, so the interface can reload the files before
  // anything is checked or saved against the old ones.
  async function updateFromMain() {
    return exclusive(async () => {
      const pr = await client.getPr(state.pr.number);
      await client.updateBranch(pr.number, pr.head.sha);
      const started = now();
      let head = pr.head.sha;
      while (head === pr.head.sha) {
        if (now() - started > UPDATE_TIMEOUT_MS) throw new Error("GitHub hasn't finished bringing in main's changes yet. Refresh in a minute.");
        await sleep(UPDATE_POLL_MS);
        head = await client.getRef(target.branch);
      }
      if (!head) throw new GitHubError({ status: 404, code: "not_found", message: `${target.branch} was not found.` });
      const { files } = await client.getCommitTree(head);
      set({ head, files, phase: "checking", checks: [], checkedSha: null, notice: "Brought in main's changes; the checks run again." });
      await readBranchState();
      return { updated: true, head };
    });
  }

  // After a failed browser job on a captured page: refresh the baselines, then
  // run CI (the bot's commit does not start it).
  async function refreshScreenshots() {
    return exclusive(async () => {
      await runBaselines();
      await client.dispatchWorkflow(target.ciWorkflow, target.branch);
      set({ phase: "checking", checks: [], checkedSha: null, canRefreshScreenshots: false, notice: "New screenshots committed; the checks run again." });
    });
  }

  // When no check has started on the head (e.g. after "Update from main").
  async function startChecks() {
    return exclusive(async () => {
      await client.dispatchWorkflow(target.ciWorkflow, target.branch);
      set({ canStartChecks: false, notice: "Started the checks." });
    });
  }

  // Your title and note for the open pull request, with the list of changes
  // regenerated below the note.
  async function updatePullRequest({ title = "", note = "" } = {}) {
    return exclusive(async () => {
      const pr = await refreshPr(await client.getPr(state.pr.number), { title, note });
      set({ pr, notice: "Updated the pull request's title and description." });
      return pr;
    });
  }

  return {
    state,
    load,
    save,
    publish,
    describeBranch,
    updatePullRequest,
    refreshChecks,
    merge,
    refreshDeploy,
    updateFromMain,
    refreshScreenshots,
    startChecks,
  };
}
