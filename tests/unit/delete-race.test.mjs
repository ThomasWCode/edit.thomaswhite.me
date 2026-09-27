// Finding 5 of the data-safety audit (docs/audits/2026-09-27-merge-safety.md).
// load() used to delete an `edits` that held nothing main lacks, as a pull
// request merged on GitHub leaves it, deciding from the SHA it read first: a
// save from another device that landed anywhere after that read was deleted
// with the branch, after that device was told "Saved". Now `edits` is only
// ever moved up to main by a fast-forward, which GitHub refuses once a save
// has landed on it, and the save is kept and loaded.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeGitHub } from "../../dev/fake-github.js";
import { targets } from "../../src/config.js";
import { createGitHubClient } from "../../src/github-client.js";
import { createPublishFlow } from "../../src/publish-flow.js";
import { readFixture } from "../support/fixtures.mjs";

const target = targets.preview;
const RECORD = "docs/record.md";

// Device B saves and publishes; the pull request is merged on GitHub itself,
// which leaves `edits` behind with nothing main lacks. Device A opens the
// editor, and as its request `landsDuring` reaches GitHub, device B saves again.
async function race(landsDuring) {
  const fake = await createFakeGitHub({ files: new Map(["index.html", RECORD].map((path) => [path, readFixture(path)])) });
  const device = (wrap = (fetch) => fetch) => {
    const client = createGitHubClient({ target, fetch: wrap(fake.fetch), getAccessToken: async () => "mock-token" });
    return createPublishFlow({ client, target, sleep: async () => {} });
  };
  const b = device();
  const { files } = await b.load();
  await b.save([{ path: RECORD, text: `${fake.fileAt("main", RECORD)}First save.\n`, loadedSha: files.get(RECORD) }], "First save");
  await b.publish();
  await fake.mergeOnGitHub(b.state.pr.number);
  await b.refreshChecks();
  const held = b.state.files.get(RECORD);
  let landed = false;
  const a = device((fetch) => async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!landed && (init.method || "GET") === "GET" && landsDuring.test(url)) {
      landed = true;
      await b.save([{ path: RECORD, text: `${fake.fileAt("edits", RECORD)}Second save, from device B.\n`, loadedSha: held }], "Second save");
    }
    return fetch(input, init);
  });
  const loaded = await a.load();
  return { fake, a, b, landed, loaded };
}

for (const [when, landsDuring] of [
  ["the pull-request lookup", /\/pulls\?state=open/],
  ["the compare", /\/compare\//],
]) {
  test(`a save landing on edits during ${when} of another device's load is kept, and loaded`, async () => {
    const { fake, a, b, landed, loaded } = await race(landsDuring);
    assert.ok(landed, "the second save landed during the load");
    assert.match(b.state.notice, /^Saved/, "device B was told it saved");
    assert.match(fake.fileAt("edits", RECORD), /Second save, from device B\./, "the save is still on edits");
    assert.equal(fake.requests.filter((request) => request.method === "DELETE").length, 0, "nothing was deleted");
    assert.equal(loaded.onBranch, true, "device A loads edits with the save");
    assert.equal(a.state.head, fake.head("edits"));
    assert.equal(a.state.aheadBy, 1);
  });
}
