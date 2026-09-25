// What the editor edits and where sign-in lives. This is the only place the
// target repository is named.
//
// Switching to the main site after the content-strategy merge (see
// docs/how-it-works.md, "Switching targets"): install the GitHub App
// "Homepage Site Editor" on ThomasWCode/ThomasWCode.github.io, change `active`
// to "main", commit. The CSP in index.html already allows both site origins.

const shared = {
  owner: "ThomasWCode",
  base: "main",
  branch: "edits",
  // Job names in the site repository's .github/workflows/ci.yml ("Test suite").
  requiredChecks: ["Static contracts and lint", "Browser and visual tests", "Lighthouse budgets"],
  ciWorkflow: "ci.yml",
  baselineWorkflow: "update-visual-baselines.yml",
  // Pages captured by a visual baseline (docs/updating-tests-and-baselines.md in the site repo).
  visualBaselinePages: ["index.html", "programming.html", "gallery.html"],
  // The CV needs a PDF rebuild; the other three are redirects.
  lockedFiles: ["cv.html", "sport.html", "music&drama.html", "gravatar.html"],
  // The file list follows the site's navigation; "blog/" places every post
  // after the Blog index. Other pages follow alphabetically, locked ones last.
  pageOrder: [
    "index.html",
    "programming.html",
    "physics.html",
    "physics/",
    "volunteering.html",
    "blog/index.html",
    "blog/",
    "sport-music-and-drama.html",
    "gallery.html",
    "tedx.html",
    "testimonials.html",
    "contact.html",
    "youtube.html",
  ],
  markdown: { record: "docs/record.md", blogSources: "docs/blog-sources/" },
};

export const targets = {
  preview: { ...shared, repo: "ThomasWCode.github.io-revised", assets: "https://new.thomaswhite.me" },
  main: { ...shared, repo: "ThomasWCode.github.io", assets: "https://thomaswhite.me" },
};

export const active = "preview";

export const auth = {
  production: "https://site-editor-auth.thomaswhite.workers.dev",
  local: "http://127.0.0.1:8787",
};

export const app = {
  name: "Homepage Site Editor",
  clientId: "Iv23lixP9BDtnDivY3vr",
  installationsUrl: "https://github.com/settings/installations",
  authorizationsUrl: "https://github.com/settings/apps/authorizations",
};

export function activeTarget() {
  return targets[active];
}
