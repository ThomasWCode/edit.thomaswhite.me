import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSite } from "../../src/checks.js";
import { EditRejectedError } from "../../src/edits.js";
import {
  ageOn,
  birthDateFromRecord,
  newPostSource,
  normaliseMarkdown,
  recordSlugs,
  slugify,
} from "../../src/markdown-files.js";
import { blockText, buildPageModel, elementChildren } from "../../src/page-model.js";
import { addAfter, NEW_ITEM, NEW_PARAGRAPH, recordReferences, removalInfo, removeBlock } from "../../src/structure.js";
import { blockKeyStarting, lineChanges, loadModel, PAGE_FILES, readFixture } from "../support/fixtures.mjs";

const structuralKey = (model, startsWith) => model.blockByKey.get(blockKeyStarting(model, startsWith)).structuralKey;

// The exact file after inserting `text` right after the element `key` ends.
function insertedAfter(model, key, text) {
  const end = model.nodeOf.get(key).sourceCodeLocation.endOffset;
  return model.source.slice(0, end) + text + model.source.slice(end);
}

test("+ after a wrapped paragraph adds a copy with its own indentation", () => {
  const model = loadModel("programming.html");
  const key = structuralKey(model, "My first language was Lua");
  const { model: next, key: added } = addAfter(model, key);
  assert.equal(next.source, insertedAfter(model, key, `\n              <p>\n                ${NEW_PARAGRAPH}\n              </p>`));
  assert.equal(blockText(next, added), NEW_PARAGRAPH);
  assert.equal(next.blockByKey.get(added).structuralKey, added, "the new paragraph can itself be removed");
});

test("+ after a one-line paragraph, a draft note and a checked item drops the draft markers", () => {
  const home = loadModel("index.html");
  const oneLine = addAfter(home, structuralKey(home, "Pick whatever")).model;
  assert.deepEqual(lineChanges(home.source, oneLine.source).added, [`            <p>${NEW_PARAGRAPH}</p>`]);

  const programming = loadModel("programming.html");
  const note = programming.drafts.find((draft) => draft.kind === "note");
  const afterNote = addAfter(programming, note.key).model;
  assert.deepEqual(lineChanges(programming.source, afterNote.source).added, ["              <p>", `                ${NEW_PARAGRAPH}`, "              </p>"]);
  assert.equal(afterNote.drafts.length, programming.drafts.length, "the copy is not a draft");

  const tedx = loadModel("tedx.html");
  const checked = tedx.drafts.find((draft) => draft.node.tagName === "li" && draft.node.attrs.length === 2);
  const afterChecked = addAfter(tedx, checked.key).model;
  assert.deepEqual(lineChanges(tedx.source, afterChecked.source).added, ['                  <li data-review="2026-11-01">', `                    ${NEW_ITEM}`, "                  </li>"]);
});

test("+ after a compact-list item keeps its label and text spans and its dates, not its link", () => {
  const home = loadModel("index.html");
  const itemKey = structuralKey(home, "Contributing to Namesake.");
  const { model: next, key } = addAfter(home, itemKey);
  assert.equal(
    next.source,
    insertedAfter(
      home,
      itemKey,
      [
        "",
        "            <li>",
        '              <span class="compact-list-label">Label</span>',
        `              <span class="compact-list-text">${NEW_ITEM}</span>`,
        "            </li>",
      ].join("\n"),
    ),
  );
  assert.equal(elementChildren(next.nodeOf.get(key)).length, 2);

  const programming = loadModel("programming.html");
  const dated = addAfter(programming, structuralKey(programming, "Chrome Dino")).model;
  const { added } = lineChanges(programming.source, dated.source);
  assert.equal(added[0], '            <li data-record="early-projects" data-when="2020-06/2021-06" data-review="2027-09-01">');
  assert.deepEqual(added.slice(1), [
    '              <span class="compact-list-label">Label</span>',
    '              <span class="compact-list-text"',
    `                >${NEW_ITEM}</span`,
    "              >",
    "            </li>",
  ]);
});

test("× removes a paragraph with its lines, and + then × gives back the exact file", () => {
  const model = loadModel("programming.html");
  const key = structuralKey(model, "My first language was Lua");
  const removed = removeBlock(model, key);
  const { startOffset, endOffset } = model.nodeOf.get(key).sourceCodeLocation;
  const from = model.source.lastIndexOf("\n", startOffset) + 1;
  const to = model.source.indexOf("\n", endOffset) + 1;
  assert.equal(model.source.slice(from, to).split("\n").length - 1, 6, "the paragraph had six lines to itself");
  assert.equal(removed.source, model.source.slice(0, from) + model.source.slice(to));

  for (const path of ["index.html", "programming.html", "physics.html", "volunteering.html", "tedx.html"]) {
    const page = loadModel(path);
    for (const block of page.blocks.filter((item) => item.structuralKey).slice(0, 25)) {
      const { model: grown, key: newKey } = addAfter(page, block.structuralKey);
      assert.equal(removeBlock(grown, newKey).source, page.source, `${path} ${block.structuralKey}`);
    }
  }
});

test("removing the last item of a list is flagged for confirmation", () => {
  const source = readFixture("index.html").replace(
    '<p class="about-cv">',
    '<ul class="solo"><li>Only item</li></ul>\n              <p class="about-cv">',
  );
  const model = buildPageModel(source, { path: "index.html" });
  const key = structuralKey(model, "Only item");
  assert.deepEqual(removalInfo(model, key), { tag: "li", lastItem: true });
  const programming = loadModel("programming.html");
  assert.deepEqual(removalInfo(programming, structuralKey(programming, "Chrome Dino")), { tag: "li", lastItem: false });
});

test("structural edits refuse locked parts, headings and read-only pages", () => {
  const home = loadModel("index.html");
  const h1 = home.blocks.find((block) => block.tag === "h1").key;
  assert.throws(() => addAfter(home, h1), EditRejectedError);
  const updated = home.blocks.find((block) => block.lock && block.tag === "p").key;
  assert.throws(() => removeBlock(home, updated), EditRejectedError);
  const cv = loadModel("cv.html");
  const item = cv.blocks.find((block) => block.structuralKey);
  assert.throws(() => addAfter(cv, item.structuralKey), EditRejectedError);
});

test("Markdown keeps its bytes: LF, one final newline, nothing else touched", () => {
  for (const path of ["docs/record.md", "docs/blog-sources/README.md", "docs/blog-sources/how-this-site-works.md"]) {
    const text = readFixture(path);
    assert.equal(normaliseMarkdown(text), text, path);
    assert.equal(normaliseMarkdown(text.replace(/\n/g, "\r\n")), text, `${path} from CRLF`);
  }
  assert.equal(normaliseMarkdown("# Title\n\n\n"), "# Title\n");
  assert.equal(normaliseMarkdown("# Title"), "# Title\n");
  assert.equal(normaliseMarkdown("  \n"), "\n", "an emptied file still ends with a newline");
  assert.equal(normaliseMarkdown(""), "\n");
});

test("a new post source follows the blog-sources template", () => {
  const recordText = readFixture("docs/record.md");
  assert.deepEqual(birthDateFromRecord(recordText), { day: 6, month: 6, year: 2010 });
  assert.equal(ageOn({ day: 6, month: 6, year: 2010 }, new Date(Date.UTC(2026, 5, 5))), 15);
  assert.equal(ageOn({ day: 6, month: 6, year: 2010 }, new Date(Date.UTC(2026, 5, 6))), 16);
  assert.equal(slugify("Organising TEDxDulwich Youth: what I’d change"), "organising-tedxdulwich-youth-what-id-change");
  assert.equal(slugify("Physics & Ideas"), "physics-and-ideas");

  const { path, text } = newPostSource({
    title: "  Using AI in a small  research team ",
    today: new Date(Date.UTC(2026, 8, 26)),
    recordText,
    existing: ["docs/blog-sources/how-this-site-works.md"],
  });
  assert.equal(path, "docs/blog-sources/using-ai-in-a-small-research-team.md");
  assert.ok(text.startsWith("September 2026, age 16\n\n# Using AI in a small research team\n\n"));
  assert.match(text, /\n## Related\n\n- \/blog\/\n$/);
  assert.equal(normaliseMarkdown(text), text);
  assert.throws(
    () => newPostSource({ title: "How this site works", today: new Date(), recordText, existing: ["docs/blog-sources/how-this-site-works.md"] }),
    /already exists/,
  );
  assert.throws(() => newPostSource({ title: "  ", today: new Date(), recordText }), /title/);
});

test("every data-record on the pages is a heading in the record", () => {
  const recordText = readFixture("docs/record.md");
  const slugs = recordSlugs(recordText);
  assert.ok(slugs.has("namesake") && slugs.has("cradle") && slugs.has("early-projects"));
  const models = PAGE_FILES.map((path) => loadModel(path));
  assert.deepEqual(checkSite(models, { slugs }), []);
  const references = models.flatMap((model) => recordReferences(model));
  assert.ok(references.length > 40);

  const renamed = recordSlugs(recordText.replace("### cradle", "### magnetic-cradle"));
  const findings = checkSite(models, { slugs: renamed });
  assert.ok(findings.length > 0 && findings.every((item) => item.code === "record-slug"));
  assert.ok(findings.some((item) => item.path === "physics.html"));
});
