// scripts/serve.js — zero-dependency static file server for local development.
//
// Usage: npm start   (serves the repository root at http://localhost:5173)
//
// This mirrors GitHub Pages closely enough for testing: it serves files with
// correct MIME types and supports the service worker over http://localhost
// (which browsers treat as a secure context).

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const PORT = Number(process.env.PORT) || 5173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, `http://localhost`).pathname);
    let filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    let info;
    try {
      info = await stat(filePath);
    } catch {
      res.writeHead(404).end("Not found");
      return;
    }
    if (info.isDirectory()) filePath = join(filePath, "index.html");
    const data = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(data);
  } catch (err) {
    res.writeHead(500).end("Server error");
    // eslint-disable-next-line no-console
    console.error(err);
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Pickleball Planner dev server: http://localhost:${PORT}`);
});
