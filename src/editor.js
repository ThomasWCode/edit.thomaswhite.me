// Entry point: sign-in, then the editor (app.js).
//
// ?mock=1 on a loopback address swaps GitHub and the Worker for an in-memory
// fake seeded with the test fixtures (dev/mock-session.js); dev/ is never
// published, so the switch does nothing on edit.thomaswhite.me.
// ?worker=local signs in through `npm run worker:dev` instead of the deployed Worker.

import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { activeTarget, auth as authOrigins } from "./config.js";
import { $ } from "./dom.js";
import { createGitHubClient } from "./github-client.js";
import { createSuggester } from "./suggest.js";

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

function showSignIn(auth, message = "", tone = "error") {
  showView("signin");
  const notice = $("signin-message");
  notice.textContent = message;
  notice.hidden = !message;
  notice.className = tone === "info" ? "notice" : `notice notice--${tone}`;
  $("sign-in-button").onclick = () => auth.signIn();
  $("status-line").textContent = "";
}

async function start() {
  if (framed()) return;
  const target = activeTarget();
  let auth;
  let fetchImpl = (input, init) => window.fetch(input, init);
  let mock = null;
  let suggest = null;
  if (isLoopback() && params.has("mock")) {
    const { createMockSession } = await import("../dev/mock-session.js");
    mock = await createMockSession({ target });
    auth = mock.auth;
    fetchImpl = mock.fetch;
    suggest = mock.suggest;
  } else {
    const workerUrl = isLoopback() && params.get("worker") === "local" ? authOrigins.local : authOrigins.production;
    suggest = createSuggester({ workerUrl, fetch: (input, init) => window.fetch(input, init), getAccessToken: () => auth.getAccessToken() });
    auth = createAuth({
      workerUrl,
      storage: localStorage,
      fetch: (input, init) => window.fetch(input, init),
      locks: navigator.locks || null,
      location,
      history,
      addEventListener: (type, listener) => window.addEventListener(type, listener),
    });
  }
  const client = createGitHubClient({ target, fetch: fetchImpl, getAccessToken: (options) => auth.getAccessToken(options) });

  let app = null;
  let signingOut = false;
  const signedOut = (message) => {
    if (app) app.stop();
    showSignIn(auth, message, "warning");
  };
  const signOut = async (everywhere) => {
    $("account").open = false;
    signingOut = true;
    const confirmed = await auth.signOut({ everywhere });
    signingOut = false;
    if (app) app.stop();
    if (confirmed) showSignIn(auth, everywhere ? "Signed out on every device." : "Signed out.", "info");
    else showSignIn(auth, "Signed out here, but GitHub could not be told. If this device is lost, revoke the app under Authorized GitHub Apps.", "warning");
  };
  $("sign-out-button").onclick = () => signOut(false);
  $("sign-out-everywhere-button").onclick = () => signOut(true);
  auth.onChange((user) => {
    if (!user && !signingOut && $("app").dataset.view === "editor") {
      signedOut("You're signed out. Sign in again to carry on; unsaved edits stay in this tab.");
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
  showView("editor");
  app = createApp({ target, client, user, onSignedOut: signedOut, suggest });
  if (mock) {
    mock.mountPanel(app);
    // For poking at the fake from the browser console while developing.
    window.siteEditorMock = { app, fake: mock.fake };
  }
  await app.start();
}

start();
