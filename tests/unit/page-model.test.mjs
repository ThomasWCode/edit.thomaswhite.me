import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../../vendor/parse5.js";
import {
  ANALISA_PHRASE,
  blockText,
  buildPageModel,
  classTokens,
  elementChildren,
  LOCK_REASONS,
  PageModelError,
} from "../../src/page-model.js";
import { FRAME_CSP, renderCopy } from "../../src/render-copy.js";
import { loadModel, ORIGINS, PAGE_FILES, readFixture } from "../support/fixtures.mjs";

// Editable-block counts per page (tests/fixtures/site/SOURCE.md): a fixture
// refresh that changes them is a markup change worth looking at.
const EXPECTED = {
  "index.html": { blocks: 60, locked: 2, links: 20, images: 7, drafts: 0 },
  "programming.html": { blocks: 107, locked: 13, links: 24, images: 3, drafts: 20 },
  "physics.html": { blocks: 64, locked: 6, links: 5, images: 1, drafts: 15 },
  "physics/magnetic-newtons-cradle.html": { blocks: 38, locked: 1, links: 2, images: 0, drafts: 9 },
  "volunteering.html": { blocks: 53, locked: 5, links: 6, images: 5, drafts: 6 },
  "blog/index.html": { blocks: 17, locked: 1, links: 4, images: 2, drafts: 1 },
  "blog/bridging-the-gap.html": { blocks: 24, locked: 1, links: 3, images: 0, drafts: 8 },
  "blog/how-this-site-works.html": { blocks: 25, locked: 1, links: 4, images: 0, drafts: 2 },
  "sport-music-and-drama.html": { blocks: 41, locked: 1, links: 2, images: 6, drafts: 0 },
  "gallery.html": { blocks: 21, locked: 1, links: 0, images: 17, drafts: 0 },
  "tedx.html": { blocks: 52, locked: 4, links: 5, images: 3, drafts: 6 },
  "testimonials.html": { blocks: 9, locked: 2, links: 1, images: 0, drafts: 0 },
  "contact.html": { blocks: 15, locked: 1, links: 5, images: 0, drafts: 0 },
  "youtube.html": { blocks: 14, locked: 1, links: 3, images: 1, drafts: 0 },
  "cv.html": { blocks: 61, locked: 1, links: 3, images: 0, drafts: 12 },
  "sport.html": { blocks: 2, locked: 1, links: 1, images: 0, drafts: 0 },
  "music&drama.html": { blocks: 2, locked: 1, links: 1, images: 0, drafts: 0 },
  "gravatar.html": { blocks: 2, locked: 1, links: 1, images: 0, drafts: 0 },
};

const models = new Map(PAGE_FILES.map((path) => [path, loadModel(path)]));

test("every fixture parses with the expected blocks, links, images and drafts", () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), [...PAGE_FILES].sort());
  for (const [path, model] of models) {
    const counts = {
      blocks: model.blocks.length,
      locked: model.blocks.filter((block) => block.lock).length,
      links: model.links.length,
      images: model.images.length,
      drafts: model.drafts.length,
    };
    assert.deepEqual(counts, EXPECTED[path], path);
    assert.ok(model.main, `${path} has main#main-content`);
  }
});

test("main holds no comments or scripts, so keys mean the same in parse5 and the browser", () => {
  for (const [path, model] of models) {
    const walk = (node) => {
      for (const child of node.childNodes) {
        assert.notEqual(child.nodeName, "#comment", `${path} has a comment in main`);
        assert.notEqual(child.tagName, "script", `${path} has a script in main`);
        if (child.childNodes) walk(child);
      }
    };
    walk(model.main);
  }
});

test("all visible text in main is reachable, and no block sits inside another", () => {
  for (const [path, model] of models) {
    assert.deepEqual(model.unreachable, [], path);
    const blockNodes = new Set(model.blocks.map((block) => block.node));
    for (const block of model.blocks) {
      for (let node = block.node.parentNode; node && node !== model.main; node = node.parentNode) {
        assert.ok(!blockNodes.has(node), `${path}: block ${block.key} is inside another block`);
      }
    }
  }
});

test("keys cover exactly the elements under main", () => {
  for (const [path, model] of models) {
    let count = 0;
    const walk = (node) =>
      elementChildren(node).forEach((child) => {
        count += 1;
        assert.equal(model.nodeOf.get(model.keyOf.get(child)), child);
        walk(child);
      });
    walk(model.main);
    assert.equal(model.nodeOf.size, count, path);
  }
});

test("locked: the h1, Analisa's words, the Updated line, proof-block labels, forms and buttons", () => {
  const lockedTexts = (path, reason) =>
    models.get(path).blocks.filter((block) => block.lock === reason).map((block) => blockText(models.get(path), block.key));

  for (const [path, model] of models) {
    const h1s = model.blocks.filter((block) => block.tag === "h1");
    assert.equal(h1s.length, 1, `${path} has one h1 block`);
    assert.equal(h1s[0].lock, LOCK_REASONS.h1);
  }
  for (const path of ["testimonials.html", "volunteering.html"]) {
    const [quote] = lockedTexts(path, LOCK_REASONS.analisa);
    assert.ok(quote && quote.includes(ANALISA_PHRASE), `${path} locks Analisa's quote`);
  }
  assert.deepEqual(lockedTexts("index.html", LOCK_REASONS.nowUpdated), ["Updated September 2026"]);
  assert.deepEqual(lockedTexts("programming.html", LOCK_REASONS.proofLabel).slice(0, 4), [
    "What it is",
    "What I did",
    "What was hard",
    "What I took from it",
  ]);

  const contact = models.get("contact.html");
  const form = [...contact.nodeOf].find(([, node]) => node.tagName === "form");
  assert.equal(contact.lockReasons.get(form[0]), LOCK_REASONS.form);
  assert.ok(!contact.blocks.some((block) => ["Send message", "Thanks!"].includes(blockText(contact, block.key))));

  const gallery = models.get("gallery.html");
  const buttons = [...gallery.nodeOf].filter(([, node]) => node.tagName === "button");
  assert.equal(buttons.length, 17);
  for (const [key] of buttons) assert.equal(gallery.lockReasons.get(key), LOCK_REASONS.button);
});

test("the CV and the redirect pages are read-only", () => {
  for (const path of ["cv.html", "sport.html", "music&drama.html", "gravatar.html"]) {
    assert.ok(models.get(path).readOnly, path);
  }
  for (const path of PAGE_FILES.filter((item) => !["cv.html", "sport.html", "music&drama.html", "gravatar.html"].includes(item))) {
    assert.equal(models.get(path).readOnly, null, path);
  }
});

test("drafts are classified as notes, inline slots or checks", () => {
  const programming = models.get("programming.html");
  const kinds = programming.drafts.map((draft) => draft.kind);
  assert.equal(kinds.filter((kind) => kind === "note").length, 4);
  assert.equal(kinds.filter((kind) => kind === "inline").length, 2);
  assert.equal(kinds.filter((kind) => kind === "check").length, 14);
  const inline = programming.drafts.find((draft) => draft.kind === "inline");
  assert.equal(programming.nodeOf.get(inline.blockKey).tagName, "p", "an inline draft sits inside its paragraph block");
  assert.ok(classTokens(inline.node).includes("draft-inline"));

  const post = models.get("blog/how-this-site-works.html");
  const article = post.drafts.find((draft) => draft.node.tagName === "article");
  assert.equal(article.kind, "check");
  assert.equal(article.blockKey, null, "a checked article is a marker, not a block");
});

test("links, images, the gallery triple and the Now section are found", () => {
  const gallery = models.get("gallery.html");
  for (const image of gallery.images) {
    assert.ok(image.gallery, "every gallery image is a gallery item");
    assert.equal(gallery.nodeOf.get(image.gallery.buttonKey).tagName, "button");
    assert.equal(gallery.nodeOf.get(image.gallery.captionKey).tagName, "figcaption");
  }
  const home = models.get("index.html");
  assert.equal(home.now.updated, "2026-09");
  assert.equal(blockText(home, home.now.lineKey), "Updated September 2026");
  assert.ok(home.ids.has("tech-projects") && home.ids.has("main-content") && home.ids.has("primary-navigation"));
  const cv = home.links.find((link) => link.href === "/Tom-White-CV.pdf" && link.blockKey);
  assert.ok(cv, "the About CV link is a block");
  assert.ok(home.blocks.filter((block) => block.shared).length >= 4, "the call to action is marked as shared");
});

test("the render copy strips scripts, adds the frame CSP, base and stylesheet, and keeps main's shape", () => {
  for (const [path, model] of models) {
    const copy = renderCopy(model, ORIGINS);
    assert.doesNotMatch(copy, /<script/i, path);
    assert.doesNotMatch(copy, /<noscript/i, path);
    const httpEquiv = [...copy.matchAll(/http-equiv="([^"]*)"/g)].map((match) => match[1]);
    assert.deepEqual(httpEquiv, ["Content-Security-Policy"], `${path} keeps only the frame CSP`);
    assert.ok(copy.includes(`content="${FRAME_CSP}"`));
    const csp = copy.indexOf("Content-Security-Policy");
    const base = copy.indexOf('<base href="https://new.thomaswhite.me/">');
    const frameCss = copy.indexOf('href="http://127.0.0.1:4174/frame.css"');
    const siteCss = copy.indexOf('href="/CSS/general.css"');
    assert.ok(csp > 0 && csp < base && base < siteCss && siteCss < frameCss, `${path}: CSP, base, site CSS, frame CSS in order`);

    const reparsed = buildPageModel(copy, { path });
    const shape = (m) => {
      const walk = (node) => `${node.tagName}(${elementChildren(node).map(walk).join("")})`;
      return walk(m.main);
    };
    assert.equal(shape(reparsed), shape(model), `${path}: the copy has the same elements under main`);
    for (const [key, node] of reparsed.nodeOf) {
      const keyAttribute = node.attrs.find((item) => item.name === "data-edit-key");
      assert.equal(keyAttribute && keyAttribute.value, key, `${path}: ${key} is labelled with its own key`);
    }
  }
});

test("nothing outside main is keyed, and only editable blocks and images get tabindex", () => {
  const model = models.get("index.html");
  const document = parse(renderCopy(model, ORIGINS));
  const outside = [];
  const walk = (node, insideMain) => {
    for (const child of node.childNodes || []) {
      if (typeof child.tagName !== "string") continue;
      const isMain = child.tagName === "main";
      const keyed = child.attrs.some((item) => item.name === "data-edit-key");
      if (keyed && !insideMain) outside.push(child.tagName);
      if (child.attrs.some((item) => item.name === "tabindex")) {
        const role = child.attrs.find((item) => item.name === "data-edit-role");
        assert.ok(role && /\b(block|image|gallery)\b/.test(role.value), `tabindex only on blocks and images, not <${child.tagName}>`);
      }
      walk(child, insideMain || isMain);
    }
  };
  walk(document, false);
  assert.deepEqual(outside, []);

  const readOnly = renderCopy(models.get("cv.html"), ORIGINS);
  assert.doesNotMatch(readOnly, /data-edit-role|tabindex="0"/, "a read-only page gets keys but no roles");
});

test("front matter is blanked in place, so offsets are file offsets", () => {
  const source = readFixture("index.html");
  const model = loadModel("index.html");
  assert.equal(model.html.length, source.length);
  assert.equal(model.permalink, "/");
  // "---", "permalink: /", "---" become 3, 12 and 3 spaces.
  assert.ok(model.html.startsWith(`${" ".repeat(3)}\n${" ".repeat(12)}\n${" ".repeat(3)}\n\n<!doctype html>`));
  const h1 = model.blocks.find((block) => block.tag === "h1").node;
  const { startOffset, endOffset } = h1.sourceCodeLocation;
  assert.equal(source.slice(startOffset, endOffset), "<h1>Hi, I’m Tom.</h1>");
  assert.ok(source.endsWith("</html>\n"), "the fixture ends with one newline");
});

test("a page without front matter or main is read-only; CRLF is refused", () => {
  const noFrontMatter = buildPageModel('<!doctype html><main id="main-content"><p>Hi</p></main>\n');
  assert.match(noFrontMatter.readOnly, /front matter/);
  const noMain = buildPageModel("---\npermalink: /x/\n---\n<!doctype html><p>Hi</p>\n");
  assert.match(noMain.readOnly, /main/);
  assert.throws(() => buildPageModel("---\r\npermalink: /\r\n---\r\n<p>x</p>\r\n", { path: "x.html" }), PageModelError);
  const implied = buildPageModel('---\npermalink: /x/\n---\n<!doctype html><main id="main-content"><p>One<p>Two</main>\n');
  assert.match(implied.readOnly, /no end tag/);
});
