// Load data/sessions.json (private, git-ignored) into the Worker's database.
// Usage: ADMIN_TOKEN=... node scripts/seed.mjs [--api https://cbt-annotation-api.<subdomain>.workers.dev]
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const apiIndex = args.indexOf("--api");
const api = (apiIndex >= 0 ? args[apiIndex + 1] : process.env.API_BASE || "http://127.0.0.1:8787").replace(/\/+$/, "");
const token = process.env.ADMIN_TOKEN;
if (!token) {
  console.error("Set ADMIN_TOKEN in the environment.");
  process.exit(1);
}

const sessions = JSON.parse(await readFile(path.join(root, "data", "sessions.json"), "utf8"));
const response = await fetch(`${api}/api/admin/seed`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ admin_token: token, sessions })
});
const result = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`Seeding failed (${response.status}):`, result.error || result);
  process.exit(1);
}
console.log(`Seeded ${result.sessions} sessions / ${result.turns} turns into ${api}`);
