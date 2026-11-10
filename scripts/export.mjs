// Download every expert profile and annotation (raw + analysis-ready) as JSON.
// Usage: ADMIN_TOKEN=... node scripts/export.mjs [--api URL] [--out exports/annotations.json] [--snapshots]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const api = option("--api", process.env.API_BASE || "https://cbt-annotation-api.saif-sedaoud.workers.dev").replace(/\/+$/, "");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = option("--out", path.join("exports", `cbt-annotation-${stamp}.json`));
const token = process.env.ADMIN_TOKEN;
if (!token) {
  console.error("Set ADMIN_TOKEN in the environment.");
  process.exit(1);
}

const response = await fetch(`${api}/api/admin/export`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ admin_token: token, include_snapshots: args.includes("--snapshots") })
});
const result = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`Export failed (${response.status}):`, result.error || result);
  process.exit(1);
}
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(result, null, 2));
const submitted = result.annotations.filter(a => a.status === "submitted").length;
console.log(`${result.experts.length} experts, ${result.annotations.length} annotations (${submitted} submitted) -> ${out}`);
