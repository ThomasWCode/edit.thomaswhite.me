// The browser half of sign-in. The Worker (worker/index.mjs) returns the GitHub
// App's user tokens in the URL fragment; this module stores them, refreshes the
// access token before it expires (GitHub rotates the refresh token every time)
// and signs out.
//
// Tokens live in localStorage: a cookie on the Worker's workers.dev origin would
// be a third-party cookie, which Safari blocks and Firefox partitions. The
// defence against theft is no XSS (strict CSP, no inline or third-party script,
// a script-less preview frame), not the storage choice.
//
// Every side effect is passed in so tests/unit/auth.test.mjs can drive it with
// fakes; editor.js builds the real instance from browser globals.

const STORAGE_KEY = "siteEditor.session.v1";
const LOCK_NAME = "siteEditor.refresh";
const REFRESH_WITHIN_MS = 5 * 60 * 1000;
const EXPIRY_SLACK_MS = 60 * 1000;

export class SignedOutError extends Error {
  constructor(message = "You are signed out.") {
    super(message);
    this.name = "SignedOutError";
  }
}

export class AuthNetworkError extends Error {
  constructor(message = "The sign-in service could not be reached.") {
    super(message);
    this.name = "AuthNetworkError";
  }
}

function expiry(now, seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? now + value * 1000 - EXPIRY_SLACK_MS : null;
}

// Builds a session from the Worker's fields (fragment or /refresh JSON).
export function sessionFromFields(fields, now) {
  const get = (key) => (typeof fields.get === "function" ? fields.get(key) : fields[key]);
  const accessToken = get("access_token");
  const login = get("login");
  const userId = Number(get("user_id"));
  if (!accessToken || !login || !Number.isInteger(userId)) return null;
  return {
    login,
    userId,
    accessToken,
    accessExpiresAt: expiry(now, get("expires_in")),
    refreshToken: get("refresh_token") || null,
    refreshExpiresAt: expiry(now, get("refresh_token_expires_in")),
  };
}

function isSession(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.accessToken === "string" &&
    typeof value.login === "string" &&
    Number.isInteger(value.userId)
  );
}

export function createAuth({
  workerUrl,
  storage,
  fetch,
  locks = null,
  now = () => Date.now(),
  location,
  history,
  addEventListener = null,
}) {
  const listeners = new Set();

  function read() {
    try {
      const value = JSON.parse(storage.getItem(STORAGE_KEY));
      return isSession(value) ? value : null;
    } catch {
      return null;
    }
  }

  function write(session) {
    storage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function notify() {
    const session = read();
    for (const listener of listeners) listener(session ? { login: session.login, userId: session.userId } : null);
  }

  function clear() {
    storage.removeItem(STORAGE_KEY);
    notify();
  }

  const fresh = (session) => session.accessExpiresAt === null || session.accessExpiresAt - now() > REFRESH_WITHIN_MS;
  const refreshExpired = (session) => session.refreshExpiresAt !== null && session.refreshExpiresAt <= now();
  const withLock = (callback) => (locks ? locks.request(LOCK_NAME, callback) : callback());

  if (addEventListener) {
    addEventListener("storage", (event) => {
      if (event.key === STORAGE_KEY || event.key === null) notify();
    });
  }

  async function refresh(session) {
    let response;
    try {
      response = await fetch(`${workerUrl}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
      });
    } catch {
      throw new AuthNetworkError();
    }
    if (response.status === 401 || response.status === 403) {
      // Another tab without Web Locks may have rotated the pair a moment ago;
      // its refresh token is the one GitHub still accepts.
      const latest = read();
      if (latest && latest.refreshToken !== session.refreshToken && fresh(latest)) return latest.accessToken;
      clear();
      throw new SignedOutError("Your sign-in has expired. Sign in again.");
    }
    if (!response.ok) throw new AuthNetworkError(`The sign-in service answered ${response.status}.`);
    const next = sessionFromFields(await response.json(), now());
    if (!next) throw new AuthNetworkError("The sign-in service sent an incomplete answer.");
    write(next);
    return next.accessToken;
  }

  return {
    storageKey: STORAGE_KEY,

    currentUser() {
      const session = read();
      if (!session || refreshExpired(session)) return null;
      return { login: session.login, userId: session.userId };
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // Reads the Worker's redirect (#access_token=... or #error=...), stores the
    // session and removes the fragment from the address bar and history.
    completeSignInFromFragment() {
      if (!location.hash || location.hash === "#") return null;
      const fields = new URLSearchParams(location.hash.slice(1));
      if (!fields.has("access_token") && !fields.has("error")) return null;
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      if (fields.has("error")) return { error: fields.get("error") };
      const session = sessionFromFields(fields, now());
      if (!session) return { error: "incomplete_sign_in" };
      write(session);
      notify();
      return { user: { login: session.login, userId: session.userId } };
    },

    // Returns a usable access token, refreshing it first when it expires within
    // five minutes. `rejected` is a token GitHub just answered 401 to: refresh
    // unless another tab has already replaced it.
    async getAccessToken({ rejected = null } = {}) {
      const session = read();
      if (!session) throw new SignedOutError();
      if (refreshExpired(session)) {
        clear();
        throw new SignedOutError("Your sign-in has expired. Sign in again.");
      }
      if (!rejected && fresh(session)) return session.accessToken;
      return withLock(async () => {
        const latest = read();
        if (!latest) throw new SignedOutError();
        if (latest.accessToken !== rejected && fresh(latest)) return latest.accessToken;
        if (!latest.refreshToken) {
          clear();
          throw new SignedOutError("Your sign-in has expired. Sign in again.");
        }
        return refresh(latest);
      });
    },

    signIn() {
      location.assign(`${workerUrl}/login?return_to=${encodeURIComponent(location.origin)}`);
    },

    // Clears this device first, then asks the Worker to revoke the token (or,
    // with everywhere, the whole grant: every device's tokens). Returns whether
    // GitHub confirmed the revocation.
    async signOut({ everywhere = false } = {}) {
      const session = read();
      clear();
      if (!session) return true;
      try {
        const response = await fetch(`${workerUrl}/logout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access_token: session.accessToken, everywhere }),
        });
        return response.status === 204;
      } catch {
        return false;
      }
    },
  };
}
