// Entry point. Wires sign-in, the GitHub client and the interface together.
import { AuthNetworkError, createAuth, SignedOutError } from "./auth.js";
import { activeTarget, auth as authOrigins } from "./config.js";
import { createGitHubClient, GitHubError } from "./github-client.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isLoopback = () => ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);

const SIGN_IN_ERRORS = {
  access_denied: "Sign-in was cancelled on GitHub.",
  bad_verification_code: "That sign-in had expired. Try again.",
  redirect_uri_mismatch: "The GitHub App's callback URL does not match the sign-in service (see docs/setup.md).",
  incorrect_client_credentials: "The sign-in service has the wrong client secret (see docs/setup.md).",
  github_unavailable: "GitHub did not answer. Try again in a minute.",
  missing_code: "GitHub did not send a sign-in code. Try again.",
  incomplete_sign_in: "Sign-in came back incomplete. Try again.",
};

// frame-ancestors cannot be set from a meta tag, so refuse to run inside a frame.
function framed() {
  if (window.top === window.self) return false;
  document.documentElement.textContent = "";
  return true;
}

function showView(view) {
  $("app").dataset.view = view;
  $("signin-view").hidden = view !== "signin";
  $("editor-view").hidden = view !== "editor";
  $("topbar-actions").hidden = view !== "editor";
  $("sidebar-toggle").hidden = view !== "editor";
}

function setStatus(text) {
  $("status-line").textContent = text;
}

function showSignIn(auth, message = "", tone = "error") {
  showView("signin");
  const notice = $("signin-message");
  notice.textContent = message;
  notice.hidden = !message;
  notice.className = tone === "info" ? "notice" : `notice notice--${tone}`;
  $("sign-in-button").onclick = () => auth.signIn();
  setStatus("");
}

function stageMessage(text, { tone = "info", link = null } = {}) {
  const box = $("stage-message");
  box.replaceChildren();
  if (!text) return;
  const paragraph = document.createElement("p");
  paragraph.className = tone === "info" ? "notice" : `notice notice--${tone}`;
  paragraph.textContent = text;
  if (link) {
    paragraph.append(" ");
    const anchor = document.createElement("a");
    anchor.href = link.href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = link.text;
    paragraph.append(anchor);
  }
  box.append(paragraph);
}

function describeGitHubError(error, target) {
  if (error instanceof SignedOutError) return error.message;
  if (error instanceof AuthNetworkError) return "The sign-in service could not be reached. Your edits are still in this tab.";
  if (!(error instanceof GitHubError)) return `Something went wrong: ${error.message}`;
  switch (error.code) {
    case "network":
      return "No connection to GitHub. Your edits are still in this tab.";
    case "not_found":
      return `The GitHub App cannot see ${target.owner}/${target.repo}. Install “Homepage Site Editor” on it, then reload.`;
    case "rate_limited":
      return `GitHub's rate limit was reached. Try again in ${Math.ceil((error.retryAfter || 60) / 60)} minutes.`;
    default:
      return `GitHub said: ${error.message}`;
  }
}

let signingOut = false;

function wireAccountMenu(auth) {
  const signOut = async (everywhere) => {
    $("account").open = false;
    signingOut = true;
    const confirmed = await auth.signOut({ everywhere });
    signingOut = false;
    if (confirmed) showSignIn(auth, everywhere ? "Signed out on every device." : "Signed out.", "info");
    else showSignIn(auth, "Signed out here, but GitHub could not be told. If this device is lost, revoke the app under Authorized GitHub Apps.", "warning");
  };
  $("sign-out-button").onclick = () => signOut(false);
  $("sign-out-everywhere-button").onclick = () => signOut(true);
}

async function openEditor({ auth, client, target, user }) {
  showView("editor");
  $("account-summary").textContent = user.login;
  $("account-name").textContent = `Signed in as ${user.login}`;
  $("site-link").href = `${target.assets}/`;
  $("site-link").textContent = new URL(target.assets).host;
  setStatus(`Editing ${target.owner}/${target.repo}`);
  stageMessage(`Checking access to ${target.owner}/${target.repo}…`);
  try {
    const repository = await client.getRepo();
    const canWrite = Boolean(repository.permissions && repository.permissions.push);
    stageMessage(
      canWrite
        ? `Connected to ${repository.full_name} (default branch ${repository.default_branch}).`
        : `Connected to ${repository.full_name}, but without permission to write to it.`,
      { tone: canWrite ? "info" : "warning" },
    );
  } catch (error) {
    if (error instanceof SignedOutError) {
      showSignIn(auth, error.message);
      return;
    }
    stageMessage(describeGitHubError(error, target), { tone: "error" });
  }
}

async function start() {
  if (framed()) return;
  const target = activeTarget();
  const workerUrl = isLoopback() && params.get("worker") === "local" ? authOrigins.local : authOrigins.production;
  const auth = createAuth({
    workerUrl,
    storage: localStorage,
    fetch: (input, init) => window.fetch(input, init),
    locks: navigator.locks || null,
    location,
    history,
    addEventListener: (type, listener) => window.addEventListener(type, listener),
  });
  const client = createGitHubClient({
    target,
    fetch: (input, init) => window.fetch(input, init),
    getAccessToken: (options) => auth.getAccessToken(options),
  });

  wireAccountMenu(auth);
  auth.onChange((user) => {
    if (!user && !signingOut && $("app").dataset.view === "editor") {
      showSignIn(auth, "You’re signed out. Sign in again to carry on; unsaved edits stay in this tab.", "warning");
    }
  });

  const result = auth.completeSignInFromFragment();
  if (result && result.error) {
    showSignIn(auth, SIGN_IN_ERRORS[result.error] || `Sign-in failed (${result.error}).`);
    return;
  }
  const user = auth.currentUser();
  if (!user) {
    showSignIn(auth);
    return;
  }
  await openEditor({ auth, client, target, user });
}

start();
