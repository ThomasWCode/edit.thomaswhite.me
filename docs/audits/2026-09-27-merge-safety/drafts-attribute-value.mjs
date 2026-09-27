// Finding 6. The site's live build (scripts/drafts.mjs --strip, run by the
// "Publish the live site" workflow) finds data-draft with a regular expression
// over each start tag's attribute text, quoted values included. An attribute
// value that mentions data-draft makes the whole element a "draft", and it is
// left out of thomaswhite.me. The editor reads real attributes (parse5) and
// says the element is live.
//
// Exits 1 while such an element is stripped.
import { liveSource } from "../../../src/drafting.js";
import { buildPageModel } from "../../../src/page-model.js";
import { siteDrafts } from "./site-repo.mjs";

const { findDrafts, stripDrafts } = await siteDrafts();
const cases = [
  '<p title="how data-draft works">A live paragraph.</p>',
  '<img src="/Images/a.png" alt="A page with a data-draft element">',
  '<a href="/blog/how-this-site-works/" aria-label="Read how data-draft hides text">Read it</a>',
];
let stripped = 0;
for (const html of cases) {
  const page = `---\npermalink: /x/\n---\n<!doctype html><html><head><title>x</title></head><body><main id="main-content">\n${html}\n</main></body></html>\n`;
  const model = buildPageModel(page, { path: "x.html" });
  const site = { seenAsDraft: findDrafts(html).map((draft) => draft.tag), servedOnThomaswhiteMe: stripDrafts(html) };
  const editor = { draftsFound: model.drafts.length, saysLive: liveSource(model).includes(html) };
  if (site.servedOnThomaswhiteMe !== html) stripped += 1;
  console.log(JSON.stringify({ html, site, editor }));
}
console.log(stripped ? `UNSAFE: ${stripped} of ${cases.length} live elements would be left out of thomaswhite.me.` : "SAFE: every element stays live.");
process.exitCode = stripped ? 1 : 0;
