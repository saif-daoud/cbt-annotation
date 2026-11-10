import { TAXONOMY } from "../../frontend/taxonomy.js";
import {
  MAX_DOC_BYTES,
  STAGES,
  documentProgress,
  flattenDocument,
  sanitizeDocument,
  submissionErrors
} from "../../frontend/model.js";

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_DELTA = 15 * 60;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------- utilities
function now() {
  return new Date().toISOString();
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean);
}

function corsHeaders(env, origin) {
  const allowed = allowedOrigins(env);
  const resolved = origin && allowed.includes(origin) ? origin : allowed[0] || "null";
  return {
    "Access-Control-Allow-Origin": resolved,
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function b64url(bytes) {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function unb64url(value) {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function secureEqual(a, b) {
  return bytesEqual(await sha256(a), await sha256(b));
}

function clip(value, max) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeEmail(value) {
  return clip(value, 254).toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function body(request, maxBytes = MAX_DOC_BYTES * 2) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request is too large.");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "Malformed JSON.");
  }
}

// ---------------------------------------------------------------- auth
async function makeToken(env, email) {
  if (!env.TOKEN_SECRET) throw new HttpError(500, "TOKEN_SECRET is not configured.");
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ email, exp: Date.now() + TOKEN_TTL_MS })));
  return `${payload}.${b64url(await hmac(env.TOKEN_SECRET, payload))}`;
}

async function authEmail(request, env) {
  if (!env.TOKEN_SECRET) throw new HttpError(500, "TOKEN_SECRET is not configured.");
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new HttpError(401, "Please sign in.");
  let parsed;
  try {
    if (!bytesEqual(await hmac(env.TOKEN_SECRET, payload), unb64url(signature))) throw new Error("bad signature");
    parsed = JSON.parse(new TextDecoder().decode(unb64url(payload)));
  } catch {
    throw new HttpError(401, "Your session is invalid. Please sign in again.");
  }
  if (!parsed.email || Date.now() > Number(parsed.exp || 0)) throw new HttpError(401, "Your session has expired. Please sign in again.");
  return String(parsed.email);
}

function publicExpert(row) {
  return row && {
    email: row.email,
    name: row.name,
    role: row.role,
    institution: row.institution,
    latest_degree: row.latest_degree,
    years_experience: Number(row.years_experience)
  };
}

async function loadExpert(env, email) {
  return env.DB.prepare("SELECT * FROM experts WHERE email = ?").bind(email).first();
}

async function requireExpert(request, env) {
  const email = await authEmail(request, env);
  const expert = await loadExpert(env, email);
  if (!expert) throw new HttpError(403, "Complete your profile first.", { needs_profile: true });
  await env.DB.prepare("UPDATE experts SET last_seen_at = ? WHERE email = ?").bind(now(), email).run();
  return expert;
}

// ---------------------------------------------------------------- data access
function publicSession(row) {
  return {
    id: row.id,
    display_order: Number(row.display_order),
    patient: row.patient,
    title: row.title,
    summary: row.summary,
    conditions: JSON.parse(row.conditions_json || "[]"),
    therapist_turns: Number(row.therapist_turns),
    patient_turns: Number(row.patient_turns),
    word_count: Number(row.word_count)
  };
}

async function loadSession(env, sessionId) {
  const row = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(sessionId).first();
  if (!row) throw new HttpError(404, "Session not found.");
  return row;
}

async function loadTurns(env, sessionId) {
  const { results } = await env.DB.prepare(
    "SELECT turn_index, speaker, utterance_id, text FROM session_turns WHERE session_id = ? ORDER BY turn_index"
  ).bind(sessionId).all();
  return results.map(t => ({ ...t, turn_index: Number(t.turn_index) }));
}

async function loadAnnotation(env, email, sessionId) {
  return env.DB.prepare("SELECT * FROM annotations WHERE email = ? AND session_id = ?").bind(email, sessionId).first();
}

function publicAnnotation(row) {
  if (!row) return null;
  return {
    data: JSON.parse(row.data_json),
    status: row.status,
    stage: row.stage,
    revision: Number(row.revision),
    active_seconds: Number(row.active_seconds),
    started_at: row.started_at,
    updated_at: row.updated_at,
    submitted_at: row.submitted_at
  };
}

function activeDelta(value) {
  const delta = Math.round(Number(value) || 0);
  return Math.min(Math.max(delta, 0), MAX_ACTIVE_DELTA);
}

// ---------------------------------------------------------------- handlers
async function handleLogin(request, env) {
  const input = await body(request);
  const email = normalizeEmail(input.email);
  if (!validEmail(email)) throw new HttpError(400, "Enter a valid email address.");
  if (!env.ACCESS_CODE) throw new HttpError(500, "ACCESS_CODE is not configured.");
  if (!(await secureEqual(String(input.access_code || "").trim(), String(env.ACCESS_CODE)))) {
    throw new HttpError(401, "The access code is not correct.");
  }
  const expert = await loadExpert(env, email);
  return json({ token: await makeToken(env, email), email, expert: publicExpert(expert), needs_profile: !expert });
}

async function handleProfile(request, env) {
  const email = await authEmail(request, env);
  const input = await body(request);
  const profile = {
    name: clip(input.name, 160),
    role: clip(input.role, 200),
    institution: clip(input.institution, 260),
    latest_degree: clip(input.latest_degree, 160),
    years_experience: Number(input.years_experience)
  };
  if (!profile.name || !profile.role || !profile.institution || !profile.latest_degree) {
    throw new HttpError(400, "Complete every profile field.");
  }
  if (!Number.isInteger(profile.years_experience) || profile.years_experience < 0 || profile.years_experience > 80) {
    throw new HttpError(400, "Years of clinical experience must be a whole number between 0 and 80.");
  }
  const stamp = now();
  await env.DB.prepare(
    `INSERT INTO experts (email, name, role, institution, latest_degree, years_experience, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, institution = excluded.institution,
       latest_degree = excluded.latest_degree, years_experience = excluded.years_experience,
       updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at`
  ).bind(email, profile.name, profile.role, profile.institution, profile.latest_degree, profile.years_experience, stamp, stamp, stamp).run();
  return json({ expert: publicExpert(await loadExpert(env, email)) });
}

async function handleSessionList(request, env) {
  const expert = await requireExpert(request, env);
  const { results: sessions } = await env.DB.prepare("SELECT * FROM sessions ORDER BY display_order").all();
  const { results: annotations } = await env.DB.prepare(
    "SELECT session_id, status, stage, data_json, updated_at, submitted_at, active_seconds FROM annotations WHERE email = ?"
  ).bind(expert.email).all();
  const bySession = new Map(annotations.map(row => [row.session_id, row]));
  const list = [];
  for (const row of sessions) {
    const annotation = bySession.get(row.id);
    let progress = null;
    if (annotation) {
      const turns = await loadTurns(env, row.id);
      progress = documentProgress(TAXONOMY, JSON.parse(annotation.data_json), turns);
    }
    list.push({
      ...publicSession(row),
      status: annotation ? annotation.status : "not_started",
      stage: annotation ? annotation.stage : null,
      updated_at: annotation?.updated_at || null,
      submitted_at: annotation?.submitted_at || null,
      active_seconds: annotation ? Number(annotation.active_seconds) : 0,
      progress
    });
  }
  return json({ expert: publicExpert(expert), sessions: list });
}

async function handleSessionDetail(request, env, sessionId) {
  const expert = await requireExpert(request, env);
  const session = await loadSession(env, sessionId);
  const turns = await loadTurns(env, sessionId);
  const annotation = await loadAnnotation(env, expert.email, sessionId);
  return json({ session: { ...publicSession(session), turns }, annotation: publicAnnotation(annotation) });
}

async function snapshot(env, email, sessionId, event, stage, dataJson) {
  return env.DB.prepare(
    "INSERT INTO annotation_snapshots (email, session_id, event, stage, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(email, sessionId, clip(event, 60), stage, dataJson, now());
}

async function saveDocument(env, email, sessionId, input, { status = "in_progress", stage, event = "", submitted = false }) {
  await loadSession(env, sessionId);
  const turns = await loadTurns(env, sessionId);
  const doc = sanitizeDocument(TAXONOMY, input.data, turns);
  const dataJson = JSON.stringify(doc);
  if (dataJson.length > MAX_DOC_BYTES) throw new HttpError(413, "The annotation is too large.");
  if (!STAGES.includes(stage)) throw new HttpError(400, "Unknown stage.");
  if (submitted) {
    const errors = submissionErrors(TAXONOMY, doc, turns);
    if (errors.length) throw new HttpError(422, "The annotation is incomplete.", { errors });
  }
  const revision = Number(input.revision);
  const delta = activeDelta(input.active_seconds_delta);
  const stamp = now();
  const existing = await loadAnnotation(env, email, sessionId);
  const statements = [];
  if (!existing) {
    if (revision !== 0) throw new HttpError(409, "This annotation changed elsewhere.", { annotation: null });
    statements.push(env.DB.prepare(
      `INSERT INTO annotations (email, session_id, status, stage, data_json, revision, active_seconds, started_at, updated_at, submitted_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    ).bind(email, sessionId, status, stage, dataJson, delta, stamp, stamp, submitted ? stamp : null));
  } else {
    if (Number(existing.revision) !== revision) {
      throw new HttpError(409, "This annotation was changed in another window.", { annotation: publicAnnotation(existing) });
    }
    statements.push(env.DB.prepare(
      `UPDATE annotations SET status = ?, stage = ?, data_json = ?, revision = revision + 1, active_seconds = active_seconds + ?,
         updated_at = ?, submitted_at = ? WHERE email = ? AND session_id = ? AND revision = ?`
    ).bind(status, stage, dataJson, delta, stamp, submitted ? stamp : status === "submitted" ? existing.submitted_at : null, email, sessionId, revision));
  }
  if (event) statements.push(await snapshot(env, email, sessionId, event, stage, dataJson));
  const results = await env.DB.batch(statements);
  if (existing && !results[0].meta?.changes) {
    throw new HttpError(409, "This annotation was changed in another window.", { annotation: publicAnnotation(await loadAnnotation(env, email, sessionId)) });
  }
  return publicAnnotation(await loadAnnotation(env, email, sessionId));
}

async function handleSave(request, env, sessionId) {
  const expert = await requireExpert(request, env);
  const input = await body(request);
  const existing = await loadAnnotation(env, expert.email, sessionId);
  if (existing?.status === "submitted") throw new HttpError(409, "This session is already submitted. Reopen it to make changes.", { annotation: publicAnnotation(existing) });
  const stage = STAGES.includes(input.stage) && input.stage !== "done" ? input.stage : "segment";
  const annotation = await saveDocument(env, expert.email, sessionId, input, { stage, event: input.event || "" });
  return json({ annotation: { ...annotation, data: undefined } });
}

async function handleSubmit(request, env, sessionId) {
  const expert = await requireExpert(request, env);
  const input = await body(request);
  const annotation = await saveDocument(env, expert.email, sessionId, input, {
    status: "submitted", stage: "done", event: "submitted", submitted: true
  });
  return json({ annotation: { ...annotation, data: undefined } });
}

async function handleReopen(request, env, sessionId) {
  const expert = await requireExpert(request, env);
  const input = await body(request);
  const existing = await loadAnnotation(env, expert.email, sessionId);
  if (!existing || existing.status !== "submitted") throw new HttpError(400, "This session is not submitted.");
  if (Number(existing.revision) !== Number(input.revision)) {
    throw new HttpError(409, "This annotation was changed in another window.", { annotation: publicAnnotation(existing) });
  }
  const stamp = now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE annotations SET status = 'in_progress', stage = 'ctrs', revision = revision + 1, updated_at = ? WHERE email = ? AND session_id = ?"
    ).bind(stamp, expert.email, sessionId),
    await snapshot(env, expert.email, sessionId, "reopened", "ctrs", existing.data_json)
  ]);
  return json({ annotation: publicAnnotation(await loadAnnotation(env, expert.email, sessionId)) });
}

async function requireAdmin(env, input) {
  if (!env.ADMIN_TOKEN || !(await secureEqual(String(input.admin_token || ""), String(env.ADMIN_TOKEN)))) {
    throw new HttpError(403, "Not allowed.");
  }
}

// Replace the session catalogue and transcripts (annotations are kept). Body: { admin_token, sessions: [...] }
async function handleSeed(request, env) {
  const input = await body(request, 20 * 1024 * 1024);
  await requireAdmin(env, input);
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  if (!sessions.length) throw new HttpError(400, "No sessions supplied.");
  const statements = [env.DB.prepare("DELETE FROM session_turns"), env.DB.prepare("DELETE FROM sessions")];
  let turnCount = 0;
  for (const s of sessions) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(s.id || "")) || !Array.isArray(s.turns) || !s.turns.length) {
      throw new HttpError(400, `Invalid session ${s.id}.`);
    }
    statements.push(env.DB.prepare(
      `INSERT INTO sessions (id, display_order, user_idx, session_idx, patient, title, summary, conditions_json,
         therapist_turns, patient_turns, word_count, ctrs_overall_sum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(s.id, Number(s.display_order), Number(s.user_idx), Number(s.session_idx), String(s.patient), String(s.title || ""),
      String(s.summary || ""), JSON.stringify(s.conditions || []), Number(s.therapist_turns), Number(s.patient_turns),
      Number(s.word_count), s.ctrs_overall_sum ?? null));
    for (const t of s.turns) {
      if (!["therapist", "patient"].includes(t.speaker)) throw new HttpError(400, `Invalid speaker in ${s.id}.`);
      statements.push(env.DB.prepare(
        "INSERT INTO session_turns (session_id, turn_index, speaker, utterance_id, text) VALUES (?, ?, ?, ?, ?)"
      ).bind(s.id, Number(t.turn_index), t.speaker, String(t.utterance_id), String(t.text)));
      turnCount += 1;
    }
  }
  await env.DB.batch(statements);
  return json({ ok: true, sessions: sessions.length, turns: turnCount });
}

async function handleExport(request, env) {
  const input = await body(request);
  await requireAdmin(env, input);
  const { results: experts } = await env.DB.prepare("SELECT * FROM experts ORDER BY created_at").all();
  const { results: sessions } = await env.DB.prepare("SELECT * FROM sessions ORDER BY display_order").all();
  const { results: annotations } = await env.DB.prepare("SELECT * FROM annotations ORDER BY session_id, email").all();
  const turnsBySession = new Map();
  for (const session of sessions) turnsBySession.set(session.id, await loadTurns(env, session.id));
  const out = annotations.map(row => {
    const doc = JSON.parse(row.data_json);
    const turns = turnsBySession.get(row.session_id) || [];
    const session = sessions.find(s => s.id === row.session_id);
    return {
      email: row.email,
      session_id: row.session_id,
      dataset_user_idx: session ? Number(session.user_idx) : null,
      dataset_session_idx: session ? Number(session.session_idx) : null,
      status: row.status,
      stage: row.stage,
      revision: Number(row.revision),
      active_seconds: Number(row.active_seconds),
      started_at: row.started_at,
      updated_at: row.updated_at,
      submitted_at: row.submitted_at,
      progress: documentProgress(TAXONOMY, doc, turns),
      annotation: flattenDocument(TAXONOMY, doc, turns),
      raw: doc
    };
  });
  let snapshots = [];
  if (input.include_snapshots) {
    snapshots = (await env.DB.prepare("SELECT * FROM annotation_snapshots ORDER BY id").all()).results.map(row => ({
      ...row, data_json: undefined, data: JSON.parse(row.data_json)
    }));
  }
  return json({
    exported_at: now(),
    experts: experts.map(e => ({ ...publicExpert(e), created_at: e.created_at, last_seen_at: e.last_seen_at })),
    sessions: sessions.map(s => ({ ...publicSession(s), dataset_user_idx: Number(s.user_idx), dataset_session_idx: Number(s.session_idx), ctrs_overall_sum_gpt: s.ctrs_overall_sum })),
    annotations: out,
    snapshots
  });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  if (path === "/api/health" && method === "GET") {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first();
    return json({ ok: true, sessions: Number(row?.n || 0) });
  }
  if (path === "/api/login" && method === "POST") return handleLogin(request, env);
  if (path === "/api/profile" && method === "POST") return handleProfile(request, env);
  if (path === "/api/sessions" && method === "GET") return handleSessionList(request, env);
  if (path === "/api/admin/export" && method === "POST") return handleExport(request, env);
  if (path === "/api/admin/seed" && method === "POST") return handleSeed(request, env);
  const match = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,40})(?:\/(annotation|submit|reopen))?$/);
  if (match) {
    const [, sessionId, action] = match;
    if (!action && method === "GET") return handleSessionDetail(request, env, sessionId);
    if (action === "annotation" && method === "PUT") return handleSave(request, env, sessionId);
    if (action === "submit" && method === "POST") return handleSubmit(request, env, sessionId);
    if (action === "reopen" && method === "POST") return handleReopen(request, env, sessionId);
  }
  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(env, origin);
    if (origin && !allowedOrigins(env).includes(origin)) {
      return new Response(JSON.stringify({ error: "Origin not allowed." }), { status: 403, headers: { ...JSON_HEADERS, ...cors } });
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    let response;
    try {
      response = await route(request, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      response = json({ error: status === 500 ? "Unexpected server error." : error.message, ...(error.extra || {}) }, status);
    }
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  }
};

