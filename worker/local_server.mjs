// Local preview: serves frontend/ and the real API code (src/index.js) on one port, backed by node:sqlite.
// Usage: node local_server.mjs   (then seed: ADMIN_TOKEN=local-admin-token node ../scripts/seed.mjs)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import worker from "./src/index.js";
import { Database } from "./node_sqlite.mjs";

const workerRoot = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.join(workerRoot, "..", "frontend");
const databasePath = process.env.LOCAL_DB || path.join(workerRoot, ".wrangler", "local-node", "annotation.sqlite3");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

function loadDevVars() {
  const file = path.join(workerRoot, ".dev.vars");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf("=");
    if (!trimmed || trimmed.startsWith("#") || separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!(key in process.env)) process.env[key] = trimmed.slice(separator + 1).trim();
  }
}

loadDevVars();
const env = {
  DB: new Database(databasePath),
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || `http://${host}:${port},http://localhost:${port}`,
  ACCESS_CODE: process.env.ACCESS_CODE || "LOCAL-ANNOTATE-2026",
  TOKEN_SECRET: process.env.TOKEN_SECRET || "local-development-token-secret",
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "local-admin-token"
};

const mime = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };

async function handleApi(req, res) {
  const chunks = [];
  if (!["GET", "HEAD"].includes(req.method)) for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://${host}:${port}${req.url}`, {
    method: req.method, headers: req.headers, body, ...(body ? { duplex: "half" } : {})
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function handleStatic(req, res) {
  const url = new URL(req.url || "/", `http://${host}:${port}`);
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const resolved = path.resolve(frontendRoot, requested);
  if (!resolved.startsWith(frontendRoot + path.sep) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": `${mime[path.extname(resolved)] || "application/octet-stream"}; charset=utf-8`, "Cache-Control": "no-store" });
  fs.createReadStream(resolved).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    if (String(req.url || "").startsWith("/api/")) await handleApi(req, res);
    else handleStatic(req, res);
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Local server error." }));
  }
}).listen(port, host, () => {
  console.log(`CBT annotation (local): http://${host}:${port}`);
  console.log(`Access code: ${env.ACCESS_CODE}`);
  console.log(`Database: ${databasePath}`);
});
