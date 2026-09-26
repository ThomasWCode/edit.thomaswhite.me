// Local server for the editor: `npm run dev`, then open http://127.0.0.1:4174/
// (add ?mock=1 for the in-memory fake GitHub, ?worker=local for `npm run worker:dev`).
//
// It serves only what GitHub Pages publishes (the allowlist in
// tests/unit/publish-allowlist.test.mjs) plus dev/, so a page that works here
// does not depend on an excluded file. In memory, it adds 'self' (for the mock's
// seed files) and the local Worker to the CSP's connect-src; the committed
// index.html never names a loopback address.
import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const LOCAL_WORKER = "http://127.0.0.1:8787";

const SERVED_FILES = new Set(["index.html", "editor.css", "frame.css", "robots.txt", "favicon.ico", "favicon.png"]);
const SERVED_DIRECTORIES = ["src/", "vendor/", "dev/"];
const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

export function isServed(relativePath) {
  if (SERVED_FILES.has(relativePath)) return true;
  return SERVED_DIRECTORIES.some((directory) => relativePath.startsWith(directory)) && !relativePath.endsWith("/");
}

// Adds the local Worker and this origin (the ?mock=1 seed files) to connect-src.
export function withLocalWorker(html) {
  return html.replace(/connect-src ([^;"]*)/, (match, sources) =>
    sources.includes(LOCAL_WORKER) ? match : `connect-src 'self' ${sources} ${LOCAL_WORKER}`,
  );
}

async function fixtureList(directory, prefix = "") {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(...(await fixtureList(path.join(directory, entry.name), `${relative}/`)));
    else found.push(relative);
  }
  return found;
}

export function createDevServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${HOST}`);
    if (url.pathname === "/dev/site/manifest.json") {
      const files = await fixtureList(path.join(root, "tests", "fixtures", "site"));
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(files));
      return;
    }
    let relativePath;
    try {
      relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    } catch {
      relativePath = "";
    }
    // ?mock=1 seeds its fake GitHub with the test fixtures, served at /dev/site/.
    const fixtures = path.join(root, "tests", "fixtures", "site");
    const requested = path.resolve(root, relativePath);
    const requestedRelative = path.relative(root, requested).split(path.sep).join("/");
    const absolute = requestedRelative.startsWith("dev/site/")
      ? path.resolve(fixtures, requestedRelative.slice("dev/site/".length))
      : requested;
    const normalised = requestedRelative;
    const inside = requestedRelative.startsWith("dev/site/")
      ? absolute.startsWith(fixtures + path.sep)
      : absolute.startsWith(root + path.sep);
    if (!inside || !isServed(normalised) || !["GET", "HEAD"].includes(request.method)) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found (or not published by GitHub Pages).\n");
      return;
    }
    try {
      let body = await readFile(absolute);
      if (normalised === "index.html") body = Buffer.from(withLocalWorker(body.toString("utf8")));
      response.writeHead(200, {
        "Content-Type": TYPES[path.extname(absolute)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found.\n");
    }
  });
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4174);
  createDevServer().listen(port, HOST, () => {
    console.log(`Editor at http://${HOST}:${port}/  (fake GitHub: http://${HOST}:${port}/?mock=1)`);
  });
}
