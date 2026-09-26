import assert from "node:assert/strict";
import { test } from "node:test";
import { base64url, createHandler, fromBase64url, pkceChallenge } from "../../worker/index.mjs";

const WORKER = "https://site-editor-auth.thomaswhite.workers.dev";
const EDITOR = "https://edit.thomaswhite.me";
const ENV = {
  GITHUB_CLIENT_ID: "Iv23lixP9BDtnDivY3vr",
  GITHUB_CLIENT_SECRET: "test-secret",
  ALLOWED_USER_IDS: "172206513",
  ALLOWED_LOGINS: "ThomasWCode",
  EDITOR_ORIGINS: `${EDITOR},http://127.0.0.1:4174`,
};
const TOM = { id: 172206513, login: "ThomasWCode" };
const TOKENS = {
  access_token: "ghu_access",
  expires_in: 28800,
  refresh_token: "ghr_refresh",
  refresh_token_expires_in: 15897600,
  scope: "",
  token_type: "bearer",
};
const NOW = Date.UTC(2026, 8, 25, 20, 0, 0);

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function setup(routes = {}, { now = NOW } = {}) {
  const calls = [];
  const waits = [];
  let counter = 0;
  const fetch = async (input, init = {}) => {
    const url = String(input);
    const method = (init.method || "GET").toUpperCase();
    const call = { url, method, headers: new Headers(init.headers), body: init.body === undefined ? undefined : String(init.body) };
    calls.push(call);
    const route = routes[`${method} ${url}`];
    if (!route) throw new Error(`Unexpected request ${method} ${url}`);
    return route(call);
  };
  const randomBytes = (length) => Uint8Array.from({ length }, () => (counter++ * 37) % 256);
  const handle = createHandler({ fetch, randomBytes, now: () => now, sleep: async (ms) => void waits.push(ms) });
  return { handle, calls, waits };
}

function request(path, { method = "GET", headers = {}, body, base = WORKER } = {}) {
  return new Request(`${base}${path}`, { method, headers, body });
}

function cookieFrom(response) {
  const header = response.headers.get("Set-Cookie");
  return header.split(";")[0];
}

function decodeCookie(pair) {
  return JSON.parse(new TextDecoder().decode(fromBase64url(pair.slice(pair.indexOf("=") + 1))));
}

async function startLogin(handle, returnTo = EDITOR) {
  const response = await handle(request(`/login?return_to=${encodeURIComponent(returnTo)}`), ENV);
  const cookie = cookieFrom(response);
  return { response, cookie, saved: decodeCookie(cookie) };
}

const tokenRoute = (value) => ({ [`POST https://github.com/login/oauth/access_token`]: () => json(200, value) });
const userRoute = (user) => ({ [`GET https://api.github.com/user`]: () => json(200, user) });
const revokeRoute = (kind) => ({
  [`DELETE https://api.github.com/applications/${ENV.GITHUB_CLIENT_ID}/${kind}`]: () => new Response(null, { status: 204 }),
});

function assertBaseHeaders(response) {
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
}

test("base64url round-trips and the PKCE challenge matches RFC 7636's example", async () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(fromBase64url(base64url(bytes)), bytes);
  // RFC 7636 appendix B.
  assert.equal(
    await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("login redirects to GitHub with state, PKCE and the login hint, and sets the state cookie", async () => {
  const { handle, calls } = setup();
  const { response, saved } = await startLogin(handle);
  assert.equal(response.status, 302);
  assertBaseHeaders(response);
  const location = new URL(response.headers.get("Location"));
  assert.equal(`${location.origin}${location.pathname}`, "https://github.com/login/oauth/authorize");
  assert.equal(location.searchParams.get("client_id"), ENV.GITHUB_CLIENT_ID);
  assert.equal(location.searchParams.get("redirect_uri"), `${WORKER}/callback`);
  assert.equal(location.searchParams.get("state"), saved.state);
  assert.equal(location.searchParams.get("code_challenge"), await pkceChallenge(saved.verifier));
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(location.searchParams.get("login"), "ThomasWCode");
  assert.equal(location.searchParams.get("allow_signup"), "false");
  assert.equal(saved.verifier.length, 43);
  assert.equal(saved.return_to, EDITOR);
  assert.equal(saved.iat, Math.floor(NOW / 1000));

  const cookie = response.headers.get("Set-Cookie");
  assert.match(cookie, /^__Host-editor_oauth=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
  assert.equal(calls.length, 0, "login makes no GitHub calls");
});

test("login defaults to the first editor origin and refuses any other return address", async () => {
  const { handle } = setup();
  const plain = await handle(request("/login"), ENV);
  assert.equal(decodeCookie(cookieFrom(plain)).return_to, EDITOR);

  const local = await startLogin(handle, "http://127.0.0.1:4174");
  assert.equal(local.saved.return_to, "http://127.0.0.1:4174");

  for (const bad of ["https://evil.example", `${EDITOR}/`, `${EDITOR}.evil.example`, "https://edit.thomaswhite.me:444"]) {
    const response = await handle(request(`/login?return_to=${encodeURIComponent(bad)}`), ENV);
    assert.equal(response.status, 400, bad);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.match(response.headers.get("Content-Type"), /^text\/html/);
    assert.match(await response.text(), /noindex/);
  }
});

test("callback exchanges the code with the verifier, checks the user and returns tokens in the fragment", async () => {
  const { handle, calls } = setup({ ...tokenRoute(TOKENS), ...userRoute({ ...TOM, name: "Tom" }) });
  const { cookie, saved } = await startLogin(handle);
  const response = await handle(
    request(`/callback?code=the-code&state=${saved.state}`, { headers: { Cookie: `other=1; ${cookie}` } }),
    ENV,
  );
  assert.equal(response.status, 302);
  assertBaseHeaders(response);
  assert.equal(
    response.headers.get("Location"),
    `${EDITOR}/#access_token=ghu_access&expires_in=28800&refresh_token=ghr_refresh&refresh_token_expires_in=15897600&login=ThomasWCode&user_id=172206513`,
  );
  assert.match(response.headers.get("Set-Cookie"), /^__Host-editor_oauth=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0$/);

  assert.equal(calls.length, 2);
  const [exchange, user] = calls;
  assert.equal(exchange.method, "POST");
  assert.equal(exchange.headers.get("Accept"), "application/json");
  assert.equal(exchange.headers.get("Content-Type"), "application/x-www-form-urlencoded");
  assert.ok(exchange.headers.get("User-Agent"));
  assert.deepEqual(Object.fromEntries(new URLSearchParams(exchange.body)), {
    client_id: ENV.GITHUB_CLIENT_ID,
    client_secret: "test-secret",
    code: "the-code",
    redirect_uri: `${WORKER}/callback`,
    code_verifier: saved.verifier,
  });
  assert.equal(user.headers.get("Authorization"), "Bearer ghu_access");
  assert.equal(user.headers.get("Accept"), "application/vnd.github+json");
  assert.equal(user.headers.get("X-GitHub-Api-Version"), "2022-11-28");
  assert.ok(user.headers.get("User-Agent"));
});

test("callback refuses a wrong state, a missing cookie and an expired cookie without calling GitHub", async () => {
  const { handle, calls } = setup();
  const { cookie, saved } = await startLogin(handle);

  const wrongState = await handle(request(`/callback?code=c&state=${saved.state}x`, { headers: { Cookie: cookie } }), ENV);
  assert.equal(wrongState.status, 400);
  assert.match(wrongState.headers.get("Set-Cookie"), /Max-Age=0/);

  const noCookie = await handle(request(`/callback?code=c&state=${saved.state}`), ENV);
  assert.equal(noCookie.status, 400);
  assert.match(await noCookie.text(), /Sign-in expired/);

  const later = setup({}, { now: NOW + 601_000 });
  const expired = await later.handle(request(`/callback?code=c&state=${saved.state}`, { headers: { Cookie: cookie } }), ENV);
  assert.equal(expired.status, 400);

  const garbage = await handle(request(`/callback?code=c&state=x`, { headers: { Cookie: "__Host-editor_oauth=%%%" } }), ENV);
  assert.equal(garbage.status, 400);
  assert.equal(calls.length + later.calls.length, 0);
});

test("callback passes GitHub's errors back to the editor without exchanging anything", async () => {
  const { handle, calls } = setup();
  const { cookie, saved } = await startLogin(handle);
  const denied = await handle(
    request(`/callback?error=access_denied&error_description=The+user+has+denied&state=${saved.state}`, {
      headers: { Cookie: cookie },
    }),
    ENV,
  );
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.get("Location"), `${EDITOR}/#error=access_denied`);
  assert.match(denied.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.equal(calls.length, 0);
});

test("callback reports a failed exchange as an error fragment", async () => {
  const { handle } = setup(tokenRoute({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }));
  const { cookie, saved } = await startLogin(handle);
  const response = await handle(request(`/callback?code=old&state=${saved.state}`, { headers: { Cookie: cookie } }), ENV);
  assert.equal(response.headers.get("Location"), `${EDITOR}/#error=bad_verification_code`);
});

test("a stranger gets 403 and their grant is revoked", async () => {
  for (const stranger of [{ id: 1, login: "someone" }, { id: 1, login: "ThomasWCode" }, { id: TOM.id, login: "renamed" }]) {
    const { handle, calls } = setup({ ...tokenRoute(TOKENS), ...userRoute(stranger), ...revokeRoute("grant") });
    const { cookie, saved } = await startLogin(handle);
    const response = await handle(request(`/callback?code=c&state=${saved.state}`, { headers: { Cookie: cookie } }), ENV);
    assert.equal(response.status, 403, JSON.stringify(stranger));
    const body = await response.text();
    assert.doesNotMatch(body, /ghu_|ghr_/);
    const revoke = calls.at(-1);
    assert.equal(revoke.method, "DELETE");
    assert.equal(revoke.url, `https://api.github.com/applications/${ENV.GITHUB_CLIENT_ID}/grant`);
    assert.equal(revoke.headers.get("Authorization"), `Basic ${btoa(`${ENV.GITHUB_CLIENT_ID}:test-secret`)}`);
    assert.deepEqual(JSON.parse(revoke.body), { access_token: "ghu_access" });
  }
});

test("logins are compared case-insensitively but the numeric id must match exactly", async () => {
  const { handle } = setup({ ...tokenRoute(TOKENS), ...userRoute({ id: TOM.id, login: "thomaswcode" }) });
  const { cookie, saved } = await startLogin(handle);
  const response = await handle(request(`/callback?code=c&state=${saved.state}`, { headers: { Cookie: cookie } }), ENV);
  assert.equal(response.status, 302);
  assert.match(response.headers.get("Location"), /#access_token=/);
});

test("CORS: only the editor origins may call /refresh and /logout", async () => {
  const { handle } = setup();
  const preflight = await handle(
    request("/refresh", { method: "OPTIONS", headers: { Origin: EDITOR, "Access-Control-Request-Method": "POST" } }),
    ENV,
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), EDITOR);
  assert.equal(preflight.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assert.equal(preflight.headers.get("Access-Control-Allow-Headers"), "Content-Type");
  assert.equal(preflight.headers.get("Vary"), "Origin");
  assert.equal(preflight.headers.get("Access-Control-Allow-Credentials"), null);
  assertBaseHeaders(preflight);

  const local = await handle(request("/logout", { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:4174" } }), ENV);
  assert.equal(local.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:4174");

  for (const headers of [{ Origin: "https://evil.example" }, {}]) {
    const refused = await handle(
      request("/refresh", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" }),
      ENV,
    );
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get("Access-Control-Allow-Origin"), null);
  }

  const wrongMethod = await handle(request("/refresh", { headers: { Origin: EDITOR } }), ENV);
  assert.equal(wrongMethod.status, 405);
});

test("refresh rotates the token pair and re-checks the allowlist", async () => {
  const rotated = { ...TOKENS, access_token: "ghu_new", refresh_token: "ghr_new" };
  const { handle, calls } = setup({ ...tokenRoute(rotated), ...userRoute(TOM) });
  const response = await handle(
    request("/refresh", {
      method: "POST",
      headers: { Origin: EDITOR, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: "ghr_refresh" }),
    }),
    ENV,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), EDITOR);
  assertBaseHeaders(response);
  assert.deepEqual(await response.json(), {
    access_token: "ghu_new",
    expires_in: "28800",
    refresh_token: "ghr_new",
    refresh_token_expires_in: "15897600",
    login: "ThomasWCode",
    user_id: "172206513",
  });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), {
    client_id: ENV.GITHUB_CLIENT_ID,
    client_secret: "test-secret",
    grant_type: "refresh_token",
    refresh_token: "ghr_refresh",
  });
  assert.equal(calls[1].headers.get("Authorization"), "Bearer ghu_new");
});

test("refresh retries a passing identity-check failure, since the old refresh token is already spent", async () => {
  const rotated = { ...TOKENS, access_token: "ghu_new", refresh_token: "ghr_new" };
  const headers = { Origin: EDITOR, "Content-Type": "application/json" };
  const body = JSON.stringify({ refresh_token: "ghr_refresh" });
  const flaky = (failures) => {
    const left = [...failures];
    return {
      [`GET https://api.github.com/user`]: () => {
        const failure = left.shift();
        if (failure === "network") throw new TypeError("fetch failed");
        return failure ? json(failure, { message: "error" }) : json(200, TOM);
      },
    };
  };

  const recovered = setup({ ...tokenRoute(rotated), ...flaky(["network", 502]) });
  const response = await recovered.handle(request("/refresh", { method: "POST", headers, body }), ENV);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).refresh_token, "ghr_new");
  assert.deepEqual(recovered.waits, [250, 1000]);
  assert.equal(recovered.calls.filter((call) => call.url.endsWith("/user")).length, 3);

  const outage = setup({ ...tokenRoute(rotated), ...flaky([503, 503, 503]) });
  assert.equal((await outage.handle(request("/refresh", { method: "POST", headers, body }), ENV)).status, 502);
  assert.equal(outage.calls.filter((call) => call.url.endsWith("/user")).length, 3, "three attempts, then give up");

  const refused = setup({ ...tokenRoute(rotated), ...flaky([401]) });
  assert.equal((await refused.handle(request("/refresh", { method: "POST", headers, body }), ENV)).status, 502);
  assert.deepEqual(refused.waits, [], "a 401 is not a passing failure");
});

test("refresh reports a spent refresh token as 401 and a stranger as 403 with the grant revoked", async () => {
  const spent = setup(tokenRoute({ error: "bad_refresh_token" }));
  const body = JSON.stringify({ refresh_token: "ghr_old" });
  const headers = { Origin: EDITOR, "Content-Type": "application/json" };
  const unauthorised = await spent.handle(request("/refresh", { method: "POST", headers, body }), ENV);
  assert.equal(unauthorised.status, 401);
  assert.deepEqual(await unauthorised.json(), { error: "bad_refresh_token" });

  const stranger = setup({ ...tokenRoute(TOKENS), ...userRoute({ id: 5, login: "someone" }), ...revokeRoute("grant") });
  const refused = await stranger.handle(request("/refresh", { method: "POST", headers, body }), ENV);
  assert.equal(refused.status, 403);
  assert.equal(stranger.calls.at(-1).url, `https://api.github.com/applications/${ENV.GITHUB_CLIENT_ID}/grant`);

  const malformed = await spent.handle(request("/refresh", { method: "POST", headers, body: "not json" }), ENV);
  assert.equal(malformed.status, 400);
});

test("logout revokes one token, or the whole grant when asked", async () => {
  for (const [everywhere, kind] of [[false, "token"], [true, "grant"]]) {
    const { handle, calls } = setup(revokeRoute(kind));
    const response = await handle(
      request("/logout", {
        method: "POST",
        headers: { Origin: EDITOR, "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: "ghu_access", everywhere }),
      }),
      ENV,
    );
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), EDITOR);
    assert.equal(calls[0].url, `https://api.github.com/applications/${ENV.GITHUB_CLIENT_ID}/${kind}`);
    assert.deepEqual(JSON.parse(calls[0].body), { access_token: "ghu_access" });
  }
});

test("a token GitHub has already forgotten still counts as signed out", async () => {
  const { handle } = setup({
    [`DELETE https://api.github.com/applications/${ENV.GITHUB_CLIENT_ID}/token`]: () => new Response(null, { status: 404 }),
  });
  const response = await handle(
    request("/logout", {
      method: "POST",
      headers: { Origin: EDITOR, "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: "ghu_gone" }),
    }),
    ENV,
  );
  assert.equal(response.status, 204);
});

const GROQ = "https://api.groq.com/openai/v1/chat/completions";
const AI_ENV = { ...ENV, GROQ_API_KEY: "gsk_test", GROQ_MODEL: "openai/gpt-oss-120b" };
const CHANGES = [{ file: "Physics & Ideas", path: "physics.html", changes: ["“… then see which patterns survive.” → “… then watch which patterns survive.”"] }];
const describeRequest = (body, origin = EDITOR) =>
  request("/describe", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const groqRoute = (content) => ({
  [`POST ${GROQ}`]: () => json(200, { choices: [{ message: { role: "assistant", content } }] }),
});
const asked = (kind, changes = CHANGES) => ({ access_token: "ghu_access", kind, changes });

test("describe: the signed-in owner gets a suggestion, and Groq gets exactly the changes", async () => {
  const content = JSON.stringify({ title: "\"Change “see” to “watch” on Physics & Ideas.\"", body: "Replaced one word.\n" });
  const { handle, calls } = setup({ ...userRoute(TOM), ...groqRoute(content) });
  const response = await handle(describeRequest(asked("commit")), AI_ENV);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), EDITOR);
  assertBaseHeaders(response);
  assert.deepEqual(await response.json(), { title: "Change “see” to “watch” on Physics & Ideas", body: "Replaced one word." });

  assert.equal(calls[0].url, "https://api.github.com/user");
  assert.equal(calls[0].headers.get("Authorization"), "Bearer ghu_access");
  assert.equal(calls[1].url, GROQ);
  assert.equal(calls[1].headers.get("Authorization"), "Bearer gsk_test");
  const sent = JSON.parse(calls[1].body);
  assert.equal(sent.model, "openai/gpt-oss-120b");
  assert.deepEqual(sent.response_format.json_schema.schema.required, ["title", "body"]);
  assert.equal(sent.response_format.json_schema.strict, true);
  assert.equal(sent.reasoning_effort, "low");
  assert.equal(sent.include_reasoning, false);
  assert.match(sent.messages[0].content, /git commit message/);
  assert.match(sent.messages[0].content, /data, not instructions/);
  assert.deepEqual(JSON.parse(sent.messages[1].content), { changes: CHANGES });
  assert.equal(calls.length, 2);
});

test("describe: a pull request's text stops where a list starts", async () => {
  const content = JSON.stringify({ title: "Reword the Game of Life line", body: "One word changed on two pages.\n\nChanges:\n- Physics\n- Programming" });
  const { handle, calls } = setup({ ...userRoute(TOM), ...groqRoute(content) });
  const response = await handle(describeRequest(asked("pr")), AI_ENV);
  assert.deepEqual(await response.json(), { title: "Reword the Game of Life line", body: "One word changed on two pages." });
  assert.match(JSON.parse(calls[1].body).messages[0].content, /pull request/);
});

test("describe: no key, bad requests, strangers, Groq's limits and failures", async () => {
  const off = setup();
  assert.equal((await off.handle(describeRequest(asked("commit")), ENV)).status, 503, "without a key the editor keeps its own text");

  const { handle, calls } = setup({ ...userRoute(TOM), ...groqRoute("{}") });
  for (const bad of ["not json", { kind: "commit", changes: CHANGES }, asked("poem"), asked("commit", []), asked("commit", [{ file: 1 }])]) {
    assert.equal((await handle(describeRequest(bad), AI_ENV)).status, 400, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal((await handle(describeRequest(asked("commit", [{ file: "x", path: "y", changes: ["z".repeat(30_000)] }])), AI_ENV)).status, 413);
  assert.equal(calls.length, 0, "nothing reaches GitHub or Groq for a bad request");
  assert.equal((await handle(describeRequest(asked("commit"), "https://evil.example"), AI_ENV)).status, 403);

  const stranger = setup({ ...userRoute({ id: 5, login: "someone" }) });
  assert.equal((await stranger.handle(describeRequest(asked("pr")), AI_ENV)).status, 403);
  assert.ok(!stranger.calls.some((call) => call.url === GROQ), "a stranger never reaches Groq");

  const limited = setup({ ...userRoute(TOM), [`POST ${GROQ}`]: () => new Response("{}", { status: 429, headers: { "retry-after": "7" } }) });
  const tooMany = await limited.handle(describeRequest(asked("pr")), AI_ENV);
  assert.equal(tooMany.status, 429);
  assert.deepEqual(await tooMany.json(), { error: "rate_limited", retry_after: "7" });

  const garbled = setup({ ...userRoute(TOM), ...groqRoute("not json") });
  assert.equal((await garbled.handle(describeRequest(asked("pr")), AI_ENV)).status, 502);
  const failing = setup({ ...userRoute(TOM), [`POST ${GROQ}`]: () => json(500, { error: { message: "down" } }) });
  assert.equal((await failing.handle(describeRequest(asked("pr")), AI_ENV)).status, 502);
  const unreachable = setup({
    ...userRoute(TOM),
    [`POST ${GROQ}`]: () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal((await unreachable.handle(describeRequest(asked("pr")), AI_ENV)).status, 504);
});

test("health, unknown paths, wrong methods and a missing secret", async () => {
  const { handle } = setup();
  const health = await handle(request("/"), ENV);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "site-editor-auth is running. Client secret: set. AI suggestions: off (no GROQ_API_KEY).\n");
  assertBaseHeaders(health);
  assert.match(await (await handle(request("/"), AI_ENV)).text(), /AI suggestions: on \(openai\/gpt-oss-120b\)\./);

  assert.equal((await handle(request("/nope"), ENV)).status, 404);
  assert.equal((await handle(request("/login", { method: "POST" }), ENV)).status, 405);
  assert.equal((await handle(request("/login", { method: "HEAD" }), ENV)).status, 302);

  const unconfigured = { ...ENV, GITHUB_CLIENT_SECRET: "" };
  assert.match(await (await handle(request("/"), unconfigured)).text(), /Client secret: missing/);
  assert.equal((await handle(request("/login"), unconfigured)).status, 503);
  const refresh = await handle(
    request("/refresh", { method: "POST", headers: { Origin: EDITOR }, body: JSON.stringify({ refresh_token: "r" }) }),
    unconfigured,
  );
  assert.equal(refresh.status, 503);
});

test("wrangler dev on plain http uses a cookie without the __Host- prefix or Secure", async () => {
  const { handle } = setup({ ...tokenRoute(TOKENS), ...userRoute(TOM) });
  const base = "http://127.0.0.1:8787";
  const login = await handle(request(`/login?return_to=${encodeURIComponent("http://127.0.0.1:4174")}`, { base }), ENV);
  const header = login.headers.get("Set-Cookie");
  assert.match(header, /^editor_oauth=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/);
  assert.equal(new URL(login.headers.get("Location")).searchParams.get("redirect_uri"), `${base}/callback`);

  const cookie = header.split(";")[0];
  const state = decodeCookie(cookie).state;
  const back = await handle(request(`/callback?code=c&state=${state}`, { base, headers: { Cookie: cookie } }), ENV);
  assert.match(back.headers.get("Location"), /^http:\/\/127\.0\.0\.1:4174\/#access_token=/);
});

test("a GitHub outage during the exchange is an error page, not a crash", async () => {
  const { handle } = setup({
    [`POST https://github.com/login/oauth/access_token`]: () => {
      throw new TypeError("fetch failed");
    },
  });
  const { cookie, saved } = await startLogin(handle);
  const response = await handle(request(`/callback?code=c&state=${saved.state}`, { headers: { Cookie: cookie } }), ENV);
  assert.equal(response.status, 502);
  assert.match(response.headers.get("Set-Cookie"), /Max-Age=0/);
});
