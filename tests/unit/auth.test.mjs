import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthNetworkError, createAuth, SignedOutError } from "../../src/auth.js";

const WORKER = "https://site-editor-auth.thomaswhite.workers.dev";
const KEY = "siteEditor.session.v1";
const HOUR = 3600 * 1000;

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    data,
  };
}

// A mutex with the navigator.locks.request shape.
function fakeLocks() {
  let tail = Promise.resolve();
  return {
    request(_name, callback) {
      const run = tail.then(() => callback());
      tail = run.catch(() => {});
      return run;
    },
  };
}

function setup({ hash = "", session, now = Date.UTC(2026, 8, 25, 12), responses = [], locks = fakeLocks() } = {}) {
  let clock = now;
  const storage = memoryStorage(session ? { [KEY]: JSON.stringify(session) } : {});
  const calls = [];
  const queue = [...responses];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected fetch ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  const replaced = [];
  const assigned = [];
  const location = {
    hash,
    origin: "https://edit.thomaswhite.me",
    pathname: "/",
    search: "",
    assign: (url) => assigned.push(url),
  };
  const history = { replaceState: (_state, _title, url) => replaced.push(url) };
  const storageListeners = [];
  const auth = createAuth({
    workerUrl: WORKER,
    storage,
    fetch,
    locks,
    now: () => clock,
    location,
    history,
    addEventListener: (type, listener) => storageListeners.push({ type, listener }),
  });
  return {
    auth,
    storage,
    calls,
    replaced,
    assigned,
    storageListeners,
    advance: (ms) => (clock += ms),
    stored: () => JSON.parse(storage.getItem(KEY)),
  };
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

const NOW = Date.UTC(2026, 8, 25, 12);
const session = (overrides = {}) => ({
  login: "ThomasWCode",
  userId: 172206513,
  accessToken: "ghu_one",
  accessExpiresAt: NOW + 8 * HOUR - 60_000,
  refreshToken: "ghr_one",
  refreshExpiresAt: NOW + 180 * 24 * HOUR,
  ...overrides,
});
const rotated = {
  access_token: "ghu_two",
  expires_in: "28800",
  refresh_token: "ghr_two",
  refresh_token_expires_in: "15897600",
  login: "ThomasWCode",
  user_id: "172206513",
};

test("the sign-in fragment is stored with expiries a minute early and removed from the address bar", () => {
  const { auth, stored, replaced } = setup({
    hash: "#access_token=ghu_one&expires_in=28800&refresh_token=ghr_one&refresh_token_expires_in=15897600&login=ThomasWCode&user_id=172206513",
  });
  const result = auth.completeSignInFromFragment();
  assert.deepEqual(result, { user: { login: "ThomasWCode", userId: 172206513 } });
  assert.deepEqual(replaced, ["/"]);
  assert.deepEqual(stored(), {
    login: "ThomasWCode",
    userId: 172206513,
    accessToken: "ghu_one",
    accessExpiresAt: NOW + 28800 * 1000 - 60_000,
    refreshToken: "ghr_one",
    refreshExpiresAt: NOW + 15897600 * 1000 - 60_000,
  });
  assert.deepEqual(auth.currentUser(), { login: "ThomasWCode", userId: 172206513 });
});

test("an error fragment is reported and removed; an unrelated fragment is left alone", () => {
  const denied = setup({ hash: "#error=access_denied" });
  assert.deepEqual(denied.auth.completeSignInFromFragment(), { error: "access_denied" });
  assert.deepEqual(denied.replaced, ["/"]);
  assert.equal(denied.storage.getItem(KEY), null);

  const other = setup({ hash: "#main-content" });
  assert.equal(other.auth.completeSignInFromFragment(), null);
  assert.deepEqual(other.replaced, []);

  const incomplete = setup({ hash: "#access_token=ghu_x" });
  assert.deepEqual(incomplete.auth.completeSignInFromFragment(), { error: "incomplete_sign_in" });
  assert.equal(incomplete.storage.getItem(KEY), null);
});

test("a fresh token is returned without calling the Worker", async () => {
  const { auth, calls } = setup({ session: session() });
  assert.equal(await auth.getAccessToken(), "ghu_one");
  assert.equal(calls.length, 0);
});

test("within five minutes of expiry the token is refreshed and the rotated pair stored", async () => {
  const { auth, calls, stored } = setup({
    session: session({ accessExpiresAt: NOW + 4 * 60_000 }),
    responses: [json(200, rotated)],
  });
  assert.equal(await auth.getAccessToken(), "ghu_two");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${WORKER}/refresh`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(calls[0].body, { refresh_token: "ghr_one" });
  assert.equal(stored().refreshToken, "ghr_two");
  assert.equal(stored().accessExpiresAt, NOW + 28800 * 1000 - 60_000);
});

test("two callers needing a refresh at once share one refresh through the lock", async () => {
  const { auth, calls } = setup({
    session: session({ accessExpiresAt: NOW - 1 }),
    responses: [json(200, rotated)],
  });
  const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
  assert.deepEqual(tokens, ["ghu_two", "ghu_two"]);
  assert.equal(calls.length, 1);
});

test("a token another tab already rotated is used instead of refreshing again", async () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify(session({ accessExpiresAt: NOW - 1 })) });
  // The other tab writes between our first read and our turn with the lock.
  const locks = {
    request(_name, callback) {
      storage.setItem(KEY, JSON.stringify(session({ accessToken: "ghu_other", refreshToken: "ghr_other" })));
      return callback();
    },
  };
  const auth = createAuth({
    workerUrl: WORKER,
    storage,
    fetch: () => assert.fail("no refresh expected"),
    locks,
    now: () => NOW,
    location: {},
    history: {},
  });
  assert.equal(await auth.getAccessToken(), "ghu_other");
});

test("a 401 from GitHub forces one refresh, unless another tab already replaced the token", async () => {
  const forced = setup({ session: session(), responses: [json(200, rotated)] });
  assert.equal(await forced.auth.getAccessToken({ rejected: "ghu_one" }), "ghu_two");
  assert.equal(forced.calls.length, 1);

  const replacedElsewhere = setup({ session: session({ accessToken: "ghu_newer" }) });
  assert.equal(await replacedElsewhere.auth.getAccessToken({ rejected: "ghu_one" }), "ghu_newer");
  assert.equal(replacedElsewhere.calls.length, 0);
});

test("a spent refresh token signs out, but not when another tab has just rotated it", async () => {
  const spent = setup({ session: session({ accessExpiresAt: NOW - 1 }), responses: [json(401, { error: "bad_refresh_token" })] });
  const changes = [];
  spent.auth.onChange((user) => changes.push(user));
  await assert.rejects(spent.auth.getAccessToken(), SignedOutError);
  assert.equal(spent.storage.getItem(KEY), null);
  assert.deepEqual(changes, [null]);

  // No Web Locks: the other tab's rotation lands while our refresh is in flight.
  const raced = setup({
    session: session({ accessExpiresAt: NOW - 1 }),
    locks: null,
    responses: [
      () => {
        raced.storage.setItem(KEY, JSON.stringify(session({ accessToken: "ghu_other", refreshToken: "ghr_other" })));
        return json(401, { error: "bad_refresh_token" });
      },
    ],
  });
  assert.equal(await raced.auth.getAccessToken(), "ghu_other");
  assert.notEqual(raced.storage.getItem(KEY), null);
});

test("a network failure keeps the session so the edits are not lost", async () => {
  const offline = setup({ session: session({ accessExpiresAt: NOW - 1 }), responses: [new TypeError("Failed to fetch")] });
  await assert.rejects(offline.auth.getAccessToken(), AuthNetworkError);
  assert.notEqual(offline.storage.getItem(KEY), null);

  const outage = setup({ session: session({ accessExpiresAt: NOW - 1 }), responses: [json(502, { error: "github_unavailable" })] });
  await assert.rejects(outage.auth.getAccessToken(), AuthNetworkError);
  assert.notEqual(outage.storage.getItem(KEY), null);
});

test("an expired refresh token or no session means signed out without a network call", async () => {
  const expired = setup({ session: session({ refreshExpiresAt: NOW - 1 }) });
  await assert.rejects(expired.auth.getAccessToken(), SignedOutError);
  assert.equal(expired.calls.length, 0);
  assert.equal(expired.auth.currentUser(), null);

  const none = setup();
  await assert.rejects(none.auth.getAccessToken(), SignedOutError);
  assert.equal(none.auth.currentUser(), null);

  const corrupt = setup();
  corrupt.storage.setItem(KEY, "{not json");
  assert.equal(corrupt.auth.currentUser(), null);
});

test("sign in goes to the Worker with this origin; sign out clears first and revokes", async () => {
  const signIn = setup();
  signIn.auth.signIn();
  assert.deepEqual(signIn.assigned, [`${WORKER}/login?return_to=https%3A%2F%2Fedit.thomaswhite.me`]);

  const signOut = setup({ session: session(), responses: [new Response(null, { status: 204 })] });
  assert.equal(await signOut.auth.signOut(), true);
  assert.equal(signOut.storage.getItem(KEY), null);
  assert.equal(signOut.calls[0].url, `${WORKER}/logout`);
  assert.deepEqual(signOut.calls[0].body, { access_token: "ghu_one", everywhere: false });

  const everywhere = setup({ session: session(), responses: [new TypeError("offline")] });
  assert.equal(await everywhere.auth.signOut({ everywhere: true }), false);
  assert.equal(everywhere.storage.getItem(KEY), null, "the device is signed out even if revoking failed");
  assert.deepEqual(everywhere.calls[0].body, { access_token: "ghu_one", everywhere: true });
});

test("a sign-in or sign-out in another tab notifies this one", () => {
  const { auth, storageListeners, storage } = setup();
  const changes = [];
  auth.onChange((user) => changes.push(user));
  const [{ type, listener }] = storageListeners;
  assert.equal(type, "storage");
  storage.setItem(KEY, JSON.stringify(session()));
  listener({ key: KEY });
  listener({ key: "unrelated" });
  storage.removeItem(KEY);
  listener({ key: null });
  assert.deepEqual(changes, [{ login: "ThomasWCode", userId: 172206513 }, null]);
});
