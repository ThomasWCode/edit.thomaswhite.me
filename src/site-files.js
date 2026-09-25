// Which files of the site repository the editor offers, and how it names them.
// The published-HTML rule mirrors listPublishedHtml() in the site's
// scripts/content-review.mjs: every .html file outside these folders and
// outside dot- or underscore-folders.

const SKIPPED_DIRECTORIES = new Set([
  ".git", ".github", ".lighthouseci", "CSS", "Fonts", "Images", "JS", "docs", "node_modules",
  "playwright-report", "scripts", "test-results", "tests",
]);

export function isPublishedHtml(path) {
  if (!path.endsWith(".html")) return false;
  const folders = path.split("/").slice(0, -1);
  return folders.every((folder) => !SKIPPED_DIRECTORIES.has(folder) && !folder.startsWith(".") && !folder.startsWith("_"));
}

export function readOnlyReason(target, path) {
  if (!target.lockedFiles.includes(path)) return null;
  if (path === "cv.html") {
    return "The CV is printed to Tom-White-CV.pdf, so change it in a Claude session that rebuilds the PDF too.";
  }
  return "This page only redirects to another address.";
}

// Markdown files the editor opens as plain text: the record and the blog sources.
export function markdownFiles(target, paths) {
  const { record, blogSources } = target.markdown;
  const sources = paths
    .filter((path) => path.startsWith(blogSources) && path.endsWith(".md") && path !== `${blogSources}README.md`)
    .sort();
  return { record: paths.includes(record) ? record : null, blogSources: sources };
}

// Pages in a sensible order: the homepage first, then top-level pages, then
// pages in folders, alphabetically within each group.
export function sortPages(paths) {
  const rank = (path) => (path === "index.html" ? 0 : path.includes("/") ? 2 : 1);
  return [...paths].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// A readable label before the page's <title> is known: "physics/magnetic-newtons-cradle.html"
// becomes "Physics / Magnetic newtons cradle".
export function fallbackLabel(path) {
  if (path === "index.html") return "Home";
  const words = path
    .replace(/\.html$/, "")
    .replace(/\/index$/, "")
    .split("/")
    .map((part) => part.replace(/[-_]+/g, " ").replace(/&/g, " & "));
  return words.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" / ");
}

// "Programming | Tom White" becomes "Programming".
export function labelFromTitle(title) {
  return title.replace(/\s*\|\s*Tom White\s*$/, "").trim();
}

// The live address of a page: its permalink on the target's site.
export function liveUrl(target, permalink) {
  return `${target.assets}${permalink || "/"}`;
}
