import assert from "node:assert/strict";
import { test } from "node:test";
import { changedLines, checkPage, checkSite, curlQuotes, isExternalRedirect, siteContext } from "../../src/checks.js";
import { lineHunks, trimEqualRuns, wordDiff } from "../../src/diff-view.js";
import { setAttribute, setNowUpdated } from "../../src/edits.js";
import { buildPageModel } from "../../src/page-model.js";
import { blockKeyStarting, editBlock, loadModel, PAGE_FILES, renderedSnapshot, siteFiles } from "../support/fixtures.mjs";
import { commitTextEdit } from "../../src/edits.js";

const originals = new Map(PAGE_FILES.map((path) => [path, loadModel(path)]));
const context = siteContext({
  pages: [...originals.values()].map((model) => ({
    permalink: model.permalink,
    ids: model.ids,
    externalRedirect: isExternalRedirect(model),
  })),
  files: siteFiles(),
});

const check = (model) => checkPage(model, originals.get(model.path), context);
const codes = (findings, level) => findings.filter((item) => !level || item.level === level).map((item) => item.code);

test("the unmodified pages, which pass the site's CI, raise nothing", () => {
  for (const [path, model] of originals) {
    assert.deepEqual(check(model), [], path);
  }
  assert.deepEqual(checkSite([...originals.values()]), []);
  assert.deepEqual([...context.samePagePaths].includes("/gravatar/"), false, "the Gravatar short link is an external redirect");
  assert.ok(context.samePagePaths.has("/sport/") && context.samePagePaths.has("/cv/"));
});

test("blocking: Liquid markers", () => {
  const model = editBlock(originals.get("index.html"), "Pick whatever", "interesting", "{{ interesting }}");
  const findings = check(model);
  assert.deepEqual(codes(findings, "block"), ["liquid"]);
  assert.equal(findings[0].line, 262);
});

test("blocking: banned words in text and in checked attributes, not in longer words", () => {
  const home = originals.get("index.html");
  assert.deepEqual(codes(check(editBlock(home, "Pick whatever", "interesting", "incredible")), "block"), ["banned-word"]);
  assert.deepEqual(codes(check(editBlock(home, "Pick whatever", "interesting", "journeys")), "block"), []);
  const image = home.images.find((item) => item.node.attrs.some((attr) => attr.value === "Tom smiling in a garden"));
  const alt = setAttribute(home, image.key, "alt", "Tom on a Journey");
  assert.deepEqual(codes(check(alt), "block"), ["banned-word"]);
});

test("blocking: a school year needs a data-review date around it", () => {
  const home = originals.get("index.html");
  const uncovered = editBlock(home, "Pick whatever", "interesting", "interesting from Year 12");
  assert.deepEqual(codes(check(uncovered), "block"), ["school-year"]);
  const covered = editBlock(home, "I’m in Year 12", "London.", "London, Year 12.");
  assert.deepEqual(codes(check(covered), "block"), []);
  assert.deepEqual(codes(check(covered), "warn"), ["school-year-edited"]);
});

test("blocking: the Now section must show its Updated month; the helper keeps them together", () => {
  const home = originals.get("index.html");
  const mismatched = setAttribute(home, home.now.key, "data-updated", "2026-10");
  const findings = check(mismatched);
  assert.deepEqual(codes(findings, "block"), ["now-updated"]);
  assert.equal(findings[0].fix, "now");
  assert.deepEqual(check(setNowUpdated(home, "2026-10")), []);
});

test("blocking: the new-tab rule for links, both ways", () => {
  const home = originals.get("index.html");
  const reading = home.links.find((link) => link.href === "/physics/#reading");
  const external = check(setAttribute(home, reading.key, "href", "https://example.com/"));
  assert.deepEqual(codes(external, "block"), ["link-same-tab"]);
  assert.equal(external[0].fix, "new-tab");

  const dusty = home.links.find((link) => link.href === "https://dusty.thomaswhite.me");
  const internal = check(setAttribute(home, dusty.key, "href", "/programming/"));
  assert.deepEqual(codes(internal, "block"), ["link-new-tab"]);
  assert.deepEqual(codes(check(setAttribute(home, dusty.key, "href", "https://github.com/ThomasWCode")), "block"), []);
});

test("blocking: a relative link, with its root form as the fix", () => {
  const blog = originals.get("blog/index.html");
  const link = blog.links.find((item) => item.href.startsWith("/blog/"));
  const findings = check(setAttribute(blog, link.key, "href", "how-this-site-works/#top"));
  assert.deepEqual(codes(findings, "block"), ["relative-link"]);
  assert.equal(findings[0].fix, "absolute");
  assert.equal(findings[0].value, "/blog/how-this-site-works/#top");
  const home = originals.get("index.html");
  const reading = home.links.find((item) => item.href === "/physics/#reading");
  const up = check(setAttribute(home, reading.key, "href", "../contact/"));
  assert.equal(up.find((item) => item.code === "relative-link").value, "/contact/");
  assert.deepEqual(codes(check(setAttribute(home, reading.key, "href", "mailto:tom@thomaswhite.me")), "block"), ["link-same-tab"], "a scheme is not relative");
});

test("blocking: local references must be pages or repository files; anchors must exist", () => {
  const home = originals.get("index.html");
  const reading = home.links.find((link) => link.href === "/physics/#reading");
  const at = (href) => codes(check(setAttribute(home, reading.key, "href", href)), "block");
  assert.deepEqual(at("/nowhere/"), ["missing-file"]);
  assert.deepEqual(at("/Images/nope.png"), ["missing-file"]);
  assert.deepEqual(at("/programming/#nope"), ["anchor-missing"]);
  assert.deepEqual(at("#nope"), ["anchor-missing"]);
  assert.deepEqual(at("/programming/#projects"), []);
  assert.deepEqual(at("#interests"), []);
  assert.deepEqual(at("/sport/"), []);
});

test("srcset: only root paths are checked as repository files", () => {
  const home = originals.get("index.html");
  const withSrcset = (candidates) =>
    buildPageModel(
      home.source.replace("/Images/optimized/thomasw-480.webp 480w,\n                      /Images/optimized/thomasw-960.webp 960w", candidates),
      { path: "index.html" },
    );
  const external = withSrcset("https://cdn.example.com/a.webp 480w, //cdn.example.com/b.webp 960w, data:image/webp;base64,UklGRg== 1x");
  assert.notEqual(external.source, home.source);
  assert.deepEqual(codes(check(external)).filter((code) => code === "missing-file"), []);
  const missing = withSrcset("/Images/optimized/nope-480.webp 480w");
  assert.deepEqual(codes(check(missing)).filter((code) => code === "missing-file"), ["missing-file"]);
});

test("blocking: an emptied heading; warning: an emptied paragraph", () => {
  const home = originals.get("index.html");
  const headingKey = blockKeyStarting(home, "What do you want to look at?");
  const emptyHeading = commitTextEdit(home, headingKey, { ...renderedSnapshot(home, headingKey), children: [] }).model;
  assert.deepEqual(codes(check(emptyHeading), "block"), ["empty-heading"]);

  const paragraphKey = blockKeyStarting(home, "Pick whatever");
  const emptyParagraph = commitTextEdit(home, paragraphKey, { ...renderedSnapshot(home, paragraphKey), children: [] }).model;
  const findings = check(emptyParagraph);
  assert.deepEqual(codes(findings, "block"), []);
  assert.deepEqual(codes(findings, "warn"), ["empty-block"]);
});

test("blocking: 'passionate' once across the whole site", () => {
  const home = editBlock(originals.get("index.html"), "Pick whatever", "interesting", "passionate");
  assert.deepEqual(checkSite([home, ...[...originals.values()].slice(1)]), []);
  const programming = editBlock(originals.get("programming.html"), "My first language was Lua", "Lua.", "Lua. I'm passionate about it.");
  const findings = checkSite([home, programming]);
  assert.deepEqual(codes(findings), ["passionate"]);
  assert.match(findings[0].message, /2 times .*index\.html.*programming\.html/);
});

test("blocking: changes outside main or inside a locked block", () => {
  const home = originals.get("index.html");
  const footer = buildPageModel(home.source.replace("Thanks for stopping by.", "Thanks for visiting."), { path: "index.html" });
  assert.deepEqual(codes(check(footer), "block"), ["outside-main"]);
  const heading = buildPageModel(home.source.replace("<h1>Hi, I’m Tom.</h1>", "<h1>Hello, I’m Tom.</h1>"), { path: "index.html" });
  assert.deepEqual(codes(check(heading), "block"), ["locked-changed"]);
});

test("warnings: exclamation marks, straight quotes, the Now helper, the shared call to action", () => {
  const programming = originals.get("programming.html");
  const bangs = editBlock(programming, "My first language was Lua", "Lua.", "Lua!");
  assert.deepEqual(codes(check(bangs), "warn"), ["exclamations"]);

  const quotes = editBlock(originals.get("index.html"), "Pick whatever", "interesting", "you'd find \"interesting\"");
  const quoteFindings = check(quotes);
  assert.deepEqual(codes(quoteFindings, "warn"), ["straight-quotes"]);
  assert.equal(quoteFindings[0].fix, "curl-quotes");

  const home = originals.get("index.html");
  const nowLine = editBlock(home, "Contributing to Namesake.", "Contributing", "Still contributing");
  assert.deepEqual(codes(check(nowLine), "warn"), ["now-helper"]);
  assert.deepEqual(codes(check(setNowUpdated(nowLine, "2026-10")), "warn"), []);

  const cta = editBlock(home, "Anything big, small", "second pair", "fresh pair");
  assert.deepEqual(codes(check(cta), "warn"), ["shared-cta"]);
});

test("warnings: a gallery caption that no longer matches its expanded-photo caption", () => {
  const gallery = originals.get("gallery.html");
  const edited = editBlock(gallery, "The wall climb", "wall climb", "big wall");
  const findings = check(edited);
  assert.deepEqual(codes(findings, "warn"), ["gallery-caption"]);
  assert.equal(findings[0].fix, "gallery-caption");
});

test("curlQuotes follows the site's typography", () => {
  assert.equal(curlQuotes(`I'd say "yes" and 'no'`), "I’d say “yes” and ‘no’");
  assert.equal(curlQuotes(`Tom's (“fine”)`), "Tom’s (“fine”)");
});

test("changedLines reports new and changed lines of the working file", () => {
  assert.deepEqual([...changedLines("a\nb\nc", "a\nB\nc\nd")], [2, 4]);
  assert.deepEqual([...changedLines("a\nb", "a\nb")], []);
});

test("the Save dialog's word runs, trimmed context and line hunks", () => {
  assert.deepEqual(wordDiff("I like red apples", "I like green apples"), [
    { type: "equal", text: "I like" },
    { type: "delete", text: "red" },
    { type: "insert", text: "green" },
    { type: "equal", text: "apples" },
  ]);
  const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
  const runs = trimEqualRuns(wordDiff(`${long} old`, `${long} new`), 3);
  assert.equal(runs[0].text, "… twelve thirteen fourteen");

  const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n");
  const after = before.replace("2", "two").replace("9", "nine");
  const hunks = lineHunks(before, after, 1);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0], { oldStart: 1, newStart: 1, rows: [{ type: " ", text: "1" }, { type: "-", text: "2" }, { type: "+", text: "two" }, { type: " ", text: "3" }] });
  assert.equal(lineHunks(before, after, 3).length, 1, "close changes merge into one hunk");
});
