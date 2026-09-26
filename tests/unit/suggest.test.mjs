import assert from "node:assert/strict";
import { test } from "node:test";
import { createSuggester, SuggestError } from "../../src/suggest.js";

const WORKER = "https://site-editor-auth.thomaswhite.workers.dev";
const CHANGES = [{ file: "Home", path: "index.html", changes: ["“a” → “b”"] }];

function setup(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return answer();
  };
  const suggest = createSuggester({ workerUrl: WORKER, fetch, getAccessToken: async () => "ghu_now" });
  return { suggest, calls };
}

const json = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });

test("asks the Worker's /describe with a fresh token, the kind and the changes", async () => {
  const { suggest, calls } = setup(() => json(200, { title: "Reword Home", body: "One word." }));
  assert.deepEqual(await suggest("commit", CHANGES), { title: "Reword Home", body: "One word." });
  assert.equal(calls[0].url, `${WORKER}/describe`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { access_token: "ghu_now", kind: "commit", changes: CHANGES });
});

test("the Worker's refusals become readable errors", async () => {
  const failure = async (answer) => {
    const { suggest } = setup(answer);
    return suggest("pr", CHANGES).then(
      () => assert.fail("expected an error"),
      (error) => error,
    );
  };
  const off = await failure(() => json(503, { error: "ai_not_configured" }));
  assert.ok(off instanceof SuggestError);
  assert.equal(off.code, "ai_not_configured");
  assert.match(off.message, /no Groq key/);
  assert.match((await failure(() => json(429, { error: "rate_limited", retry_after: "7" }))).message, /allowance.*Groq asks for 7 s/);
  assert.equal((await failure(() => new Response("oops", { status: 500 }))).code, "http_500");
  const offline = await failure(() => {
    throw new TypeError("fetch failed");
  });
  assert.equal(offline.code, "network");
});
