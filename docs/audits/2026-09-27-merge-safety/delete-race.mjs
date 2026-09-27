// Finding 5 (a documented limit, measured). load() deletes an `edits` that
// holds nothing main lacks, as a pull request merged on GitHub leaves it. It
// decides from the SHA read first, then lists open pull requests, compares,
// and deletes. Another device's save that lands anywhere in that span is
// deleted with the branch, after that device was told "Saved".
//
// Exits 1 while such a save can be lost.
import { createFakeGitHub } from "../../../dev/fake-github.js";
import { targets } from "../../../src/config.js";
import { createGitHubClient } from "../../../src/github-client.js";
import { createPublishFlow } from "../../../src/publish-flow.js";
import { readFixture } from "../../../tests/support/fixtures.mjs";

const target = targets.preview;
const RECORD = "docs/record.md";

async function run(landsDuring) {
  const fake = await createFakeGitHub({ files: new Map(["index.html", RECORD].map((path) => [path, readFixture(path)])) });
  const device = (wrap = (fetch) => fetch) => {
    const client = createGitHubClient({ target, fetch: wrap(fake.fetch), getAccessToken: async () => "mock-token" });
    return createPublishFlow({ client, target, sleep: async () => {} });
  };
  // Device B saves and publishes; the pull request is merged on GitHub itself,
  // which leaves `edits` behind with nothing main lacks.
  const b = device();
  const { files } = await b.load();
  await b.save([{ path: RECORD, text: `${fake.fileAt("main", RECORD)}First save.\n`, loadedSha: files.get(RECORD) }], "First save");
  await b.publish();
  await fake.mergeOnGitHub(b.state.pr.number);
  await b.refreshChecks();
  const held = b.state.files.get(RECORD);
  // Device A opens the editor. As its request `landsDuring` reaches GitHub,
  // device B saves again.
  let landed = false;
  const a = device((fetch) => async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!landed && (init.method || "GET") === "GET" && landsDuring.test(url)) {
      landed = true;
      await b.save([{ path: RECORD, text: `${fake.fileAt("edits", RECORD)}Second save, from device B.\n`, loadedSha: held }], "Second save");
    }
    return fetch(input, init);
  });
  await a.load();
  const kept = Boolean(fake.head("edits")) || fake.fileAt("main", RECORD).includes("Second save");
  return { secondSaveLandsDuring: String(landsDuring), deviceBToldSaved: b.state.notice.startsWith("Saved"), secondSaveStillOnABranch: kept };
}

const results = [await run(/\/pulls\?state=open/), await run(/\/compare\//)];
console.log(JSON.stringify(results, null, 1));
const lost = results.filter((result) => result.deviceBToldSaved && !result.secondSaveStillOnABranch).length;
console.log(lost ? `UNSAFE: a save told "Saved" was deleted with edits in ${lost} of ${results.length} timings.` : "SAFE: no save was lost.");
process.exitCode = lost ? 1 : 0;
