// The Markdown files the editor opens as plain text: docs/record.md and the
// blog sources in docs/blog-sources/. They are saved in the same commit as
// page edits, with LF endings and one final newline.

import { MONTHS } from "./edits.js";

// LF line endings and exactly one final newline (an empty file stays empty).
export function normaliseMarkdown(text) {
  const lf = text.replace(/\r\n?/g, "\n");
  if (!lf.trim()) return "";
  return `${lf.replace(/\n+$/, "")}\n`;
}

// The record's "### slug" headings: the values data-record may take.
export function recordSlugs(recordText) {
  return new Set(Array.from(recordText.matchAll(/^### ([a-z0-9-]+)\s*$/gm), (match) => match[1]));
}

// "Born 6 June 2010" in the record's Identity section.
export function birthDateFromRecord(recordText) {
  const match = /Born (\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})/.exec(recordText);
  if (!match) return null;
  return { day: Number(match[1]), month: MONTHS.indexOf(match[2]) + 1, year: Number(match[3]) };
}

export function ageOn(birth, date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hadBirthday = month > birth.month || (month === birth.month && day >= birth.day);
  return year - birth.year - (hadBirthday ? 0 : 1);
}

export function slugify(title) {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

// A new blog source from the conventions in docs/blog-sources/README.md: the
// eyebrow line (month, year and age), the title and a lede, "##" subheadings,
// and a Related list. Returns { path, text }.
export function newPostSource({ title, today, recordText, folder = "docs/blog-sources/", existing = [] }) {
  const clean = title.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("Give the post a title.");
  const slug = slugify(clean);
  if (!slug) throw new Error("The title needs at least one letter or number.");
  const path = `${folder}${slug}.md`;
  if (existing.includes(path)) throw new Error(`${path} already exists.`);
  const birth = recordText ? birthDateFromRecord(recordText) : null;
  const monthYear = `${MONTHS[today.getUTCMonth()]} ${today.getUTCFullYear()}`;
  const eyebrow = birth ? `${monthYear}, age ${ageOn(birth, today)}` : monthYear;
  const text = [
    eyebrow,
    "",
    `# ${clean}`,
    "",
    "One or two sentences on what this post is about.",
    "",
    "<!--",
    "Write in your own voice. Add a ## subheading every 300 to 400 words; they",
    "become the small italic subheadings on the page. A Claude session converts",
    "this file into blog/" + slug + ".html (docs/blog-sources/README.md).",
    "-->",
    "",
    "## First section",
    "",
    "## Related",
    "",
    "- /blog/",
    "",
  ].join("\n");
  return { path, text };
}
