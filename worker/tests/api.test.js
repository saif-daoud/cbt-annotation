// End-to-end API test: real Worker router + schema on in-memory SQLite.
import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import { Database } from "../node_sqlite.mjs";
import { TAXONOMY } from "../../frontend/taxonomy.js";
import * as M from "../../frontend/model.js";

const ORIGIN = "https://saif-daoud.github.io";
const env = {
  DB: new Database(":memory:"),
  ALLOWED_ORIGINS: ORIGIN,
  ACCESS_CODE: "TEST-CODE",
  TOKEN_SECRET: "test-secret",
  ADMIN_TOKEN: "admin"
};

const turns = Array.from({ length: 6 }, (_, i) => ({
  turn_index: i,
  speaker: i % 2 === 0 ? "therapist" : "patient",
  utterance_id: `${i % 2 === 0 ? "therapist" : "patient"}_${Math.floor(i / 2)}`,
  text: `Utterance ${i}`
}));

async function call(path, { method = "GET", body, token, origin = ORIGIN } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  const response = await worker.fetch(new Request(`https://api.test${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
  return { status: response.status, data: await response.json().catch(() => ({})), headers: response.headers };
}

test("full annotation flow", async () => {
  // Seed.
  assert.equal((await call("/api/admin/seed", { method: "POST", body: { admin_token: "wrong", sessions: [] } })).status, 403);
  const seeded = await call("/api/admin/seed", {
    method: "POST",
    body: { admin_token: "admin", sessions: [{ id: "S01", display_order: 1, user_idx: 3, session_idx: 4, patient: "X", title: "t", summary: "s", conditions: ["Anxiety"], therapist_turns: 3, patient_turns: 3, word_count: 12, turns }] }
  });
  assert.equal(seeded.status, 200);
  assert.equal(seeded.data.turns, 6);

  // CORS.
  assert.equal((await call("/api/health", { origin: "https://evil.example" })).status, 403);
  const health = await call("/api/health");
  assert.equal(health.headers.get("Access-Control-Allow-Origin"), ORIGIN);

  // Login and profile; email is the identifier (case-insensitive).
  assert.equal((await call("/api/login", { method: "POST", body: { email: "a@b.org", access_code: "nope" } })).status, 401);
  const login = await call("/api/login", { method: "POST", body: { email: "Expert@Clinic.org", access_code: "TEST-CODE" } });
  assert.equal(login.status, 200);
  assert.equal(login.data.needs_profile, true);
  const token = login.data.token;
  assert.equal((await call("/api/sessions", { token })).status, 403);
  assert.equal((await call("/api/profile", { method: "POST", token, body: { name: "E" } })).status, 400);
  const profile = await call("/api/profile", { method: "POST", token, body: { name: "Dr E", role: "Psychologist", institution: "Clinic", latest_degree: "PhD", years_experience: 9 } });
  assert.equal(profile.data.expert.email, "expert@clinic.org");
  const relogin = await call("/api/login", { method: "POST", body: { email: "expert@clinic.org", access_code: "TEST-CODE" } });
  assert.equal(relogin.data.needs_profile, false);
  assert.equal((await call("/api/sessions", { token: "bad.token" })).status, 401);

  // List and open.
  const list = await call("/api/sessions", { token });
  assert.equal(list.data.sessions[0].status, "not_started");
  assert.equal(list.data.sessions[0].ctrs_overall_sum, undefined, "GPT CTRS scores are never shown to experts");
  const detail = await call("/api/sessions/S01", { token });
  assert.equal(detail.data.session.turns.length, 6);
  assert.equal(detail.data.annotation, null);

  // Autosave with optimistic concurrency.
  const doc = M.emptyDocument();
  M.splitAt(TAXONOMY, doc, turns, 2);
  const macro = TAXONOMY.macro_actions[0];
  M.setPhaseMacro(TAXONOMY, doc, turns, 0, macro.name);
  M.setPhaseMacro(TAXONOMY, doc, turns, 1, M.OTHER, "Scheduling");
  let save = await call("/api/sessions/S01/annotation", { method: "PUT", token, body: { data: doc, revision: 0, stage: "segment", active_seconds_delta: 30 } });
  assert.equal(save.status, 200);
  assert.equal(save.data.annotation.revision, 1);
  const stale = await call("/api/sessions/S01/annotation", { method: "PUT", token, body: { data: doc, revision: 0, stage: "segment" } });
  assert.equal(stale.status, 409);

  doc.segmentation_done = true;
  save = await call("/api/sessions/S01/annotation", { method: "PUT", token, body: { data: doc, revision: 1, stage: "annotate", event: "segmentation_completed", active_seconds_delta: 99999 } });
  assert.equal(save.data.annotation.revision, 2);
  assert.equal(save.data.annotation.active_seconds, 30 + 900, "active time deltas are capped");

  // Incomplete submission is rejected with reasons.
  const early = await call("/api/sessions/S01/submit", { method: "POST", token, body: { data: doc, revision: 2 } });
  assert.equal(early.status, 422);
  assert.ok(early.data.errors.length > 0);

  doc.phases[0].state_updates = { "Automatic Thoughts": "Negative" };
  doc.phases.forEach(p => { p.state_done = true; p.reward = 2; });
  doc.phases[0].micro = { 0: { action: macro.micro_actions[0].name } };
  doc.phases[1].micro = { 2: { action: M.NONE }, 4: { action: M.OTHER, other: "Logistics" } };
  for (const item of TAXONOMY.ctrs.items) doc.ctrs[item.key] = 5;
  const submit = await call("/api/sessions/S01/submit", { method: "POST", token, body: { data: doc, revision: 2, active_seconds_delta: 10 } });
  assert.equal(submit.status, 200, JSON.stringify(submit.data));
  assert.equal((await call("/api/sessions/S01/annotation", { method: "PUT", token, body: { data: doc, revision: 3, stage: "ctrs" } })).status, 409, "submitted sessions are locked");

  const after = await call("/api/sessions", { token });
  assert.equal(after.data.sessions[0].status, "submitted");

  // Reopen.
  const reopened = await call("/api/sessions/S01/reopen", { method: "POST", token, body: { revision: 3 } });
  assert.equal(reopened.data.annotation.status, "in_progress");

  // Export.
  assert.equal((await call("/api/admin/export", { method: "POST", body: { admin_token: "x" } })).status, 403);
  const exported = await call("/api/admin/export", { method: "POST", body: { admin_token: "admin", include_snapshots: true } });
  assert.equal(exported.status, 200);
  const record = exported.data.annotations[0];
  assert.equal(record.email, "expert@clinic.org");
  assert.equal(record.dataset_user_idx, 3);
  assert.equal(record.annotation.ctrs.overall_sum, 55);
  assert.equal(record.annotation.phases[1].state_at_start["Automatic Thoughts"], "Negative");
  assert.equal(record.annotation.phases[1].macro_action_other, "Scheduling");
  assert.deepEqual(record.annotation.micro_actions.map(m => m.utterance_id), ["therapist_0", "therapist_1", "therapist_2"]);
  assert.deepEqual(exported.data.snapshots.map(s => s.event), ["segmentation_completed", "submitted", "reopened"]);
});
