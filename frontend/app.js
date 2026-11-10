import { TAXONOMY } from "./taxonomy.js";
import * as M from "./model.js";

const API = String(window.APP_CONFIG?.apiBase || "").replace(/\/+$/, "");
const TOKEN_KEY = "cbt-annotation-token";
const STEPS = [
  { key: "micro", label: "Micro actions" },
  { key: "reward", label: "Phase reward" }
];
const STAGE_NAMES = { segment: "Stage 1", annotate: "Stage 2", ctrs: "Stage 3" };
const MACROS = TAXONOMY.macro_actions;

const $ = (selector, root = document) => root.querySelector(selector);
const app = $("#app");

// localStorage can be unavailable (private mode, blocked storage): every access is guarded.
const store = {
  get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
  remove(key) { try { window.localStorage.removeItem(key); } catch { /* storage unavailable */ } }
};

function emailFromToken(token) {
  try {
    const payload = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload + "===".slice((payload.length + 3) % 4))).email || "";
  } catch {
    return "";
  }
}

const S = {
  token: store.get(TOKEN_KEY) || "",
  email: "",
  expert: null,
  sessions: [],
  view: "loading",
  loginError: "",
  profileError: "",
  // open session
  session: null,
  turns: [],
  ann: null,
  sel: null,
  showIntro: false,
  microQuery: "",
  showPrev: null,
  allAnchors: false,
  openAnchors: new Set(),
  errors: [],
  conflict: false,
  save: { dirty: false, event: "", timer: null, chain: Promise.resolve(), status: "saved", error: "" },
  active: { unsent: 0, last: Date.now() }
};

// ------------------------------------------------------------------ helpers
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(message, ms = 3200) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), ms);
}

function minutes(seconds) {
  const m = Math.round((seconds || 0) / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

async function api(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(API + path, {
      method,
      headers: { "Content-Type": "application/json", ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    const error = new Error("Cannot reach the server. Check your connection.");
    error.status = 0;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function signOut(message = "") {
  S.token = "";
  S.expert = null;
  S.session = null;
  S.ann = null;
  store.remove(TOKEN_KEY);
  S.loginError = message;
  S.view = "login";
  if (location.hash !== "#/") history.replaceState(null, "", "#/");
  render();
}

function handleAuthError(error) {
  if (error.status === 401) { signOut(error.message); return true; }
  if (error.status === 403 && error.data?.needs_profile) { S.view = "profile"; render(); return true; }
  return false;
}

// ------------------------------------------------------------------ derived state
const doc = () => S.ann?.data;
const ui = () => doc().ui;
const curPhaseIndex = () => ui().phase;
const curPhase = () => doc().phases[curPhaseIndex()];
const ranges = () => M.phaseRanges(doc(), S.turns);
const turnByIndex = index => S.turns.find(turn => turn.turn_index === index);
const backupKey = () => `cbt-annotation:${S.email}:${S.session?.id}`;

function phaseProgressAll() {
  const r = ranges();
  return doc().phases.map((phase, index) => M.phaseProgress(TAXONOMY, phase, r[index]));
}

function microLabelText(label) {
  if (!label) return "";
  if (label.action === M.NONE) return "None";
  if (label.action === M.OTHER) return `Other: ${label.other || "…"}`;
  return label.action;
}

function canEnterAnnotate() {
  return doc().segmentation_done && M.segmentationErrors(doc()).length === 0;
}

function canEnterCtrs() {
  return canEnterAnnotate() && M.annotationErrors(TAXONOMY, doc(), S.turns).length === 0;
}

// ------------------------------------------------------------------ saving
function changed(event = "") {
  if (!S.ann || S.ann.status === "submitted") return;
  S.save.dirty = true;
  if (event) S.save.event = event;
  store.set(backupKey(), JSON.stringify({ revision: S.ann.revision, data: S.ann.data, at: Date.now() }));
  setSaveStatus("pending");
  clearTimeout(S.save.timer);
  S.save.timer = setTimeout(flushSave, event ? 0 : 700);
}

function flushSave() {
  clearTimeout(S.save.timer);
  S.save.timer = null;
  S.save.chain = S.save.chain.then(doSave).catch(() => {});
  return S.save.chain;
}

async function doSave() {
  const ann = S.ann;
  const session = S.session;
  if (!ann || !session || !S.save.dirty || ann.status === "submitted" || S.conflict) return;
  S.save.dirty = false;
  const event = S.save.event;
  S.save.event = "";
  const delta = S.active.unsent;
  S.active.unsent = 0;
  setSaveStatus("saving");
  try {
    const result = await api(`/api/sessions/${session.id}/annotation`, {
      method: "PUT",
      body: { data: ann.data, revision: ann.revision, stage: ann.stage, event, active_seconds_delta: delta }
    });
    ann.revision = result.annotation.revision;
    ann.active_seconds = result.annotation.active_seconds;
    if (S.ann === ann && !S.save.dirty) store.remove(backupKey());
    setSaveStatus(S.save.dirty ? "pending" : "saved");
  } catch (error) {
    S.active.unsent += delta;
    if (event && !S.save.event) S.save.event = event;
    if (handleAuthError(error)) return;
    if (error.status === 409) { showConflict(); return; }
    S.save.dirty = true;
    setSaveStatus("error", error.message);
    clearTimeout(S.save.timer);
    S.save.timer = setTimeout(flushSave, 5000);
  }
}

function setSaveStatus(status, message = "") {
  S.save.status = status;
  S.save.error = message;
  const el = $("#save-status");
  if (!el) return;
  const text = { saved: "All changes saved", pending: "Saving…", saving: "Saving…", error: "Not saved – retrying" }[status] || "";
  el.textContent = text;
  el.title = message;
  el.className = `save-status ${status}`;
}

function showConflict() {
  S.conflict = true;
  if (window.confirm("This session was changed in another tab or window. Reload it to continue with the latest saved version?")) {
    S.conflict = false;
    store.remove(backupKey());
    openSession(S.session.id);
  } else {
    setSaveStatus("error", "Changes are not being saved because the session was modified elsewhere. Reload the page.");
  }
}

window.addEventListener("beforeunload", event => {
  if (S.save.dirty || S.save.status === "saving") {
    flushSave();
    event.preventDefault();
    event.returnValue = "";
  }
});

// Active-time tracking (only while the tab is visible and the expert interacted in the last 90 s).
["pointerdown", "keydown", "wheel", "scroll", "mousemove"].forEach(type =>
  window.addEventListener(type, () => { S.active.last = Date.now(); }, { passive: true, capture: true }));
setInterval(() => {
  if (S.view !== "session" || !S.ann || S.ann.status === "submitted") return;
  if (document.visibilityState !== "visible" || Date.now() - S.active.last > 90000) return;
  S.active.unsent += 1;
  if (S.active.unsent >= 60 && !S.save.dirty && S.save.status !== "saving") {
    S.save.dirty = true;
    flushSave();
  }
}, 1000);

// ------------------------------------------------------------------ navigation
async function boot() {
  window.addEventListener("hashchange", route);
  S.email = emailFromToken(S.token);
  if (!S.token) { S.view = "login"; render(); return; }
  await route();
}

async function route() {
  if (!S.token) { S.view = "login"; render(); return; }
  if (S.view === "session" && S.session) await flushSave();
  const match = location.hash.match(/^#\/session\/([A-Za-z0-9_-]+)/);
  if (match) await openSession(match[1]);
  else await openDashboard();
}

async function openDashboard() {
  S.session = null;
  S.ann = null;
  try {
    const data = await api("/api/sessions");
    S.expert = data.expert;
    S.email = data.expert.email;
    S.sessions = data.sessions;
    S.view = "dashboard";
  } catch (error) {
    if (handleAuthError(error)) return;
    S.view = "error";
    S.errorMessage = error.message;
  }
  render();
}

async function openSession(sessionId) {
  S.view = "loading";
  render();
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!S.expert) {
      const list = await api("/api/sessions");
      S.expert = list.expert;
      S.email = list.expert.email;
      S.sessions = list.sessions;
    }
    S.session = data.session;
    S.turns = data.session.turns;
    S.ann = data.annotation || { data: M.emptyDocument(), revision: 0, status: "in_progress", stage: "segment", active_seconds: 0 };
    S.ann.data = M.sanitizeDocument(TAXONOMY, S.ann.data, S.turns);
    S.save = { dirty: false, event: "", timer: null, chain: Promise.resolve(), status: "saved", error: "" };
    S.conflict = false;
    S.sel = null;
    S.showIntro = false;
    S.microQuery = "";
    S.showPrev = null;
    S.errors = [];
    S.active.unsent = 0;
    const backup = parseBackup();
    if (backup && S.ann.status !== "submitted" && backup.revision === S.ann.revision) {
      S.ann.data = M.sanitizeDocument(TAXONOMY, backup.data, S.turns);
      changed();
      toast("Restored changes that had not been saved yet.");
    } else {
      store.remove(backupKey());
    }
    S.view = "session";
  } catch (error) {
    if (handleAuthError(error)) return;
    S.view = "error";
    S.errorMessage = error.message;
  }
  render();
}

function parseBackup() {
  try {
    const raw = store.get(backupKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ rendering: shell
function render() {
  renderHeader();
  if (S.view === "loading") app.innerHTML = '<p class="loading">Loading…</p>';
  else if (S.view === "login") app.innerHTML = loginHtml();
  else if (S.view === "profile") app.innerHTML = profileHtml();
  else if (S.view === "dashboard") app.innerHTML = dashboardHtml();
  else if (S.view === "session") renderSession();
  else app.innerHTML = `<div class="center-wrap"><div class="card login-card"><h2>Something went wrong</h2><p class="error">${esc(S.errorMessage || "")}</p><a class="btn" href="#/">Back to sessions</a></div></div>`;
}

function renderHeader() {
  const right = $("#header-right");
  if (!S.token || !S.expert || ["login", "profile"].includes(S.view)) {
    right.innerHTML = "";
    return;
  }
  right.innerHTML = `
    <span class="who-am-i">${esc(S.expert.name)} · ${esc(S.expert.email)}</span>
    <button class="btn ghost small" type="button" data-action="guide">Guide</button>
    <button class="btn ghost small" type="button" data-action="sign-out">Sign out</button>`;
}

function loginHtml() {
  return `
  <section class="center-wrap">
    <div class="card login-card">
      <h1>CBT session annotation</h1>
      <form id="login-form" class="form-grid" novalidate>
        <label class="field">Email address<input id="login-email" type="email" autocomplete="email" maxlength="254" required value="${esc(S.email)}" /></label>
        <label class="field">Study access code<input id="login-code" type="password" autocomplete="current-password" required /></label>
        ${S.loginError ? `<p class="error" role="alert">${esc(S.loginError)}</p>` : ""}
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </div>
  </section>`;
}

function profileHtml() {
  const e = S.expert || {};
  return `
  <section class="center-wrap">
    <div class="card login-card" style="width:min(620px,100%)">
      <h1>Complete your profile</h1>
      <p class="lead">Asked only on your first sign-in.</p>
      <form id="profile-form" class="form-grid two" novalidate>
        <label class="field full">Email address<input type="email" value="${esc(S.email)}" disabled /></label>
        <label class="field">Full name<input name="name" autocomplete="name" maxlength="160" required value="${esc(e.name || "")}" /></label>
        <label class="field">Role or specialty<input name="role" maxlength="200" required value="${esc(e.role || "")}" /></label>
        <label class="field">Institution<input name="institution" maxlength="260" required value="${esc(e.institution || "")}" /></label>
        <label class="field">Latest degree<input name="latest_degree" maxlength="160" required value="${esc(e.latest_degree || "")}" /></label>
        <label class="field full">Years of clinical experience<input name="years_experience" type="number" min="0" max="80" step="1" required value="${esc(e.years_experience ?? "")}" /></label>
        ${S.profileError ? `<p class="error full" role="alert">${esc(S.profileError)}</p>` : ""}
        <div class="form-actions full">
          <button class="btn ghost" type="button" data-action="sign-out">Back</button>
          <button class="btn primary" type="submit">Continue</button>
        </div>
      </form>
    </div>
  </section>`;
}

function statusOf(session) {
  if (session.status === "submitted") return { cls: "submitted", text: "Submitted ✓", pct: 100 };
  if (session.status === "not_started") return { cls: "not_started", text: "Not started", pct: 0 };
  const p = session.progress || {};
  if (session.stage === "segment") return { cls: "in_progress", text: `Stage 1 · ${p.phases || 1} phase${p.phases === 1 ? "" : "s"}`, pct: 10 };
  if (session.stage === "annotate") {
    return { cls: "in_progress", text: `Stage 2 · ${p.phasesComplete}/${p.phases} phases`, pct: 20 + Math.round(70 * (p.phasesComplete / Math.max(1, p.phases))) };
  }
  return { cls: "in_progress", text: `CTRS · ${p.ctrsDone}/${p.ctrsTotal} items`, pct: 92 };
}

function dashboardHtml() {
  const submitted = S.sessions.filter(s => s.status === "submitted").length;
  const first = String(S.expert?.name || "").split(/\s+/)[0];
  const rows = S.sessions.map(s => {
    const st = statusOf(s);
    const action = s.status === "submitted" ? "View" : s.status === "not_started" ? "Start" : "Continue";
    return `
    <div class="card session-row ${st.cls}">
      <span class="num">${s.display_order}</span>
      <div>
        <div class="patient">Patient “${esc(s.patient)}”</div>
        <div class="summary" title="${esc(s.summary)}">${esc(s.summary)}</div>
        <div class="chips">${s.conditions.map(c => `<span class="chip">${esc(c)}</span>`).join("")}</div>
      </div>
      <div class="len">${s.therapist_turns} therapist turns<br><span class="muted">about ${Math.max(5, Math.round(s.word_count / 230))} min to read</span></div>
      <div><span class="status ${st.cls}">${esc(st.text)}</span><div class="progress"><i style="width:${st.pct}%"></i></div>
        ${s.active_seconds >= 60 ? `<span class="muted small">${minutes(s.active_seconds)} spent</span>` : ""}</div>
      <a class="btn ${s.status === "submitted" ? "" : "primary"}" href="#/session/${esc(s.id)}">${action}</a>
    </div>`;
  }).join("");
  return `
  <section class="page">
    <div class="page-head">
      <div><h1>Welcome${first ? `, ${esc(first)}` : ""}</h1><p class="muted">${submitted} of ${S.sessions.length} sessions submitted</p></div>
      <button class="btn" type="button" data-action="guide">Annotation guide</button>
    </div>
    <div class="card howto">
      <ol>
        <li><b>Read and segment</b>Read the transcript and split it into phases, each labelled with a macro action.</li>
        <li><b>Annotate the phases</b>For each phase, give every therapist turn a micro action, then rate how well the phase achieved its goal.</li>
        <li><b>Rate and submit</b>Rate the whole session on the 11 CTRS items, then submit.</li>
      </ol>
    </div>
    <div class="session-list">${rows || '<p class="muted">No sessions are available yet.</p>'}</div>
  </section>`;
}

// ------------------------------------------------------------------ rendering: session
function introVisible() {
  if (S.ann.status === "submitted") return false;
  return S.showIntro || !doc().ui.seen?.[S.ann.stage];
}

function renderSession() {
  const stage = S.ann.status === "submitted" ? "done" : S.ann.stage;
  const key = `${S.session.id}:${stage}:${introVisible() ? "intro" : "work"}`;
  if (app.dataset.sessionKey !== key || !$("#session-body")) {
    app.dataset.sessionKey = key;
    app.innerHTML = `<div class="session-shell"><div class="session-bar" id="session-bar"></div><div class="session-body" id="session-body"></div></div>`;
    paintBody(true);
  } else {
    paintBody(false);
  }
  paintBar();
}

function stageState(stageKey) {
  const order = { segment: 0, annotate: 1, ctrs: 2, done: 3 };
  const current = S.ann.status === "submitted" ? 3 : order[S.ann.stage];
  const target = order[stageKey];
  const enabled = S.ann.status !== "submitted" && (stageKey === "segment" || (stageKey === "annotate" ? canEnterAnnotate() : canEnterCtrs()));
  const done = target < current || (stageKey === "segment" && doc().segmentation_done) || (stageKey === "annotate" && canEnterCtrs()) || S.ann.status === "submitted";
  return { current: target === current, done: done && target !== current, enabled };
}

function paintBar() {
  const bar = $("#session-bar");
  const stages = [["segment", "Read & segment"], ["annotate", "Annotate phases"], ["ctrs", "CTRS rating"]];
  bar.innerHTML = `
    <a class="back" href="#/">← Sessions</a>
    <span class="sb-title">Session ${S.session.display_order} · Patient “${esc(S.session.patient)}”</span>
    <ol class="stepper">${stages.map(([key, label], i) => {
      const st = stageState(key);
      return `${i ? '<li class="sep" aria-hidden="true">›</li>' : ""}<li><button type="button" class="${st.current ? "current" : st.done ? "done" : ""}" data-action="stage" data-stage="${key}" ${st.enabled && !st.current ? "" : "disabled"}><span class="n">${st.done ? "✓" : i + 1}</span><span class="lbl">${label}</span></button></li>`;
    }).join("")}</ol>
    <div class="sb-right">
      <span id="save-status" class="save-status"></span>
      ${S.ann.status !== "submitted" && !introVisible() ? '<button class="btn small" type="button" data-action="intro">Instructions</button>' : ""}
      <button class="btn small" type="button" data-action="info">Session info</button>
    </div>`;
  setSaveStatus(S.save.status, S.save.error);
}

function preserveScroll(selector, fn, reset) {
  const el = $(selector);
  const top = el ? el.scrollTop : 0;
  fn();
  const after = $(selector);
  if (after && !reset) after.scrollTop = top;
}

function paintBody(reset) {
  const body = $("#session-body");
  const stage = S.ann.status === "submitted" ? "done" : S.ann.stage;
  if (stage === "done") {
    body.innerHTML = `<div class="pane" style="flex:1">${doneHtml()}</div>`;
    return;
  }
  if (introVisible()) {
    body.innerHTML = `<div class="pane intro-pane" id="intro-pane">${introHtml(stage)}</div>`;
    return;
  }
  if (reset || !$("#pane-main")) {
    body.innerHTML = stage === "annotate"
      ? `<div class="phase-nav" id="phase-nav"></div><div class="split"><div class="pane pane-main" id="pane-main"></div><aside class="pane pane-side" id="pane-side"></aside></div>`
      : `<div class="split ${stage === "ctrs" ? "wide-side" : ""}"><div class="pane pane-main" id="pane-main"></div><aside class="pane pane-side" id="pane-side"></aside></div>`;
  }
  paintMain(reset);
  paintSide(reset);
  if (stage === "annotate") paintPhaseNav();
}

function paintMain(reset = false) {
  preserveScroll("#pane-main", () => {
    const stage = S.ann.stage;
    $("#pane-main").innerHTML = stage === "segment" ? segmentMainHtml() : stage === "annotate" ? annotateMainHtml() : ctrsMainHtml();
  }, reset);
}

function paintSide(reset = false) {
  preserveScroll("#pane-side .side-scroll", () => {
    const stage = S.ann.stage;
    $("#pane-side").innerHTML = stage === "segment" ? segmentSideHtml() : stage === "annotate" ? annotateSideHtml() : ctrsSideHtml();
  }, reset);
}

function turnHtml(turn, { phaseStart = null, splittable = false, faded = false, clickable = false, label = undefined, selected = false } = {}) {
  const therapist = turn.speaker === "therapist";
  let chip = "";
  if (therapist && label !== undefined) {
    if (!label || !M.microLabelComplete(label)) chip = `<span class="label-chip missing">${label?.action === M.OTHER ? "Other: describe…" : "no micro action"}</span>`;
    else chip = `<span class="label-chip ${label.action === M.NONE ? "none" : label.action === M.OTHER ? "other" : ""}">${esc(microLabelText(label))}</span>`;
  }
  const classes = ["turn", turn.speaker, faded ? "faded" : "", clickable && therapist ? "clickable" : "",
    clickable && therapist && !M.microLabelComplete(label) ? "unlabelled" : "", selected ? "selected" : ""].filter(Boolean).join(" ");
  return `<div class="${classes}" id="turn-${turn.turn_index}" data-turn="${turn.turn_index}" ${clickable && therapist ? 'data-action="select-turn"' : ""}>
    ${splittable && therapist && turn.turn_index !== phaseStart ? `<button class="split-btn" type="button" data-action="split" data-turn="${turn.turn_index}" title="Start a new phase at this therapist turn">New phase here</button>` : ""}
    <div class="who">${therapist ? "Therapist" : "Patient"} <span class="tn">#${turn.turn_index + 1}</span>${chip}</div>
    <div class="text">${esc(turn.text)}</div>
  </div>`;
}

function macroOptions(selected) {
  return `<option value="">Choose a macro action…</option>${MACROS.map(m => `<option value="${esc(m.name)}" ${m.name === selected ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
    <option value="${M.OTHER}" ${selected === M.OTHER ? "selected" : ""}>Other (describe)</option>`;
}

// ---------- stage 1
function segmentMainHtml() {
  const r = ranges();
  return `<div class="transcript">${doc().phases.map((phase, i) => `
    <section class="phase-block c${i % 6}" id="phase-${i}">
      <div class="phase-head">
        <span class="phase-num">Phase ${i + 1}</span>
        <span class="muted small">turns ${r[i].start + 1}–${r[i].end + 1}</span>
        <select data-action="macro" data-phase="${i}" class="${phase.macro ? "" : "unset"}" aria-label="Macro action for phase ${i + 1}">${macroOptions(phase.macro)}</select>
        ${i > 0 ? `<button class="link" type="button" data-action="merge" data-phase="${i}">Merge with previous</button>` : ""}
        ${phase.macro === M.OTHER ? `<input type="text" data-field="macro_other" data-phase="${i}" maxlength="300" placeholder="Describe the therapist's strategy in this phase" value="${esc(phase.macro_other)}" />` : ""}
      </div>
      ${r[i].turns.map(turn => turnHtml(turn, { phaseStart: phase.start, splittable: true })).join("")}
    </section>`).join("")}</div>`;
}

function sessionInfoCard() {
  const s = S.session;
  return `<div class="info-card"><b>Patient “${esc(s.patient)}”</b><p style="margin:4px 0 0">${esc(s.summary)}</p>
    <div class="chips">${s.conditions.map(c => `<span class="chip">${esc(c)}</span>`).join("")}</div></div>`;
}

function segmentSideHtml() {
  const r = ranges();
  const errors = M.segmentationErrors(doc());
  return `<div class="side-scroll">
    <div class="side-section">
      <h2>Stage 1 · Read and segment</h2>
      <ol class="task-list">
        <li>Read the whole transcript.</li>
        <li>Where the therapist moves to a new aim or strategy, hover over that therapist turn and click <b>New phase here</b>.</li>
        <li>Choose the macro action that best describes each phase, or <b>Other</b> if none fits.</li>
      </ol>
      <button class="link" type="button" data-action="intro">Read the Stage 1 instructions again</button>
    </div>
    <div class="side-section">${sessionInfoCard()}</div>
    <div class="side-section">
      <h3>Phases (${doc().phases.length})</h3>
      <ul class="phase-outline">${doc().phases.map((phase, i) => `
        <li><button type="button" data-action="goto-phase" data-phase="${i}"><span class="dot c${i % 6}"></span>
          <span class="lbl ${M.phaseLabelled(phase) ? "" : "unlab"}">${i + 1}. ${M.phaseLabelled(phase) ? esc(M.macroLabel(phase)) : "Not labelled yet"}</span>
          <span class="rng">${r[i].start + 1}–${r[i].end + 1}</span></button></li>`).join("")}</ul>
    </div>
    <div class="side-section">
      <h3>Macro actions</h3>
      ${MACROS.map(m => `<details class="ref"><summary>${esc(m.name)}</summary><p>${esc(m.description)}</p><p><b>Goal:</b> ${esc(m.goal.objective)}</p>
        <ul>${m.micro_actions.map(a => `<li>${esc(a.name)}</li>`).join("")}</ul></details>`).join("")}
    </div>
  </div>
  <div class="side-footer">
    ${errors.length && doc().phases.length > 0 ? `<p class="muted small" style="margin:0 0 8px">${errors.length} phase${errors.length > 1 ? "s" : ""} still need${errors.length > 1 ? "" : "s"} a label.</p>` : ""}
    <button class="btn primary" type="button" data-action="finish-seg" ${errors.length ? "disabled" : ""}>${doc().segmentation_done ? "Back to Stage 2 →" : "Finish segmentation → Stage 2"}</button>
  </div>`;
}

// ---------- stage 2
function paintPhaseNav() {
  const i = curPhaseIndex();
  const r = ranges()[i];
  const progress = phaseProgressAll();
  $("#phase-nav").innerHTML = `
    <button class="btn small" type="button" data-action="phase-prev" ${i === 0 ? "disabled" : ""} aria-label="Previous phase">‹</button>
    <div class="phase-dots" role="list">${progress.map((p, k) => {
      const partial = !p.complete && (p.microLabelled > 0 || p.rewardDone);
      return `<button type="button" role="listitem" class="${p.complete ? "complete" : partial ? "partial" : ""} ${k === i ? "current" : ""}" data-action="goto-phase2" data-phase="${k}" title="Phase ${k + 1}: ${esc(M.macroLabel(doc().phases[k]))}${p.complete ? " (complete)" : ""}">${k + 1}</button>`;
    }).join("")}</div>
    <button class="btn small" type="button" data-action="phase-next" ${i === doc().phases.length - 1 ? "disabled" : ""} aria-label="Next phase">›</button>
    <div class="phase-title"><b>Phase ${i + 1} of ${doc().phases.length}</b> · ${esc(M.macroLabel(curPhase()))} <span class="m">· turns ${r.start + 1}–${r.end + 1}</span></div>`;
}

function annotateMainHtml() {
  const i = curPhaseIndex();
  const phase = curPhase();
  const r = ranges();
  const step = ui().step;
  const showPrev = i > 0 && (S.showPrev ?? false);
  let html = '<div class="transcript">';
  if (i > 0) {
    const prev = doc().phases[i - 1];
    html += `<div class="prev-toggle"><span>Previous phase ${i}: ${esc(M.macroLabel(prev))} (turns ${r[i - 1].start + 1}–${r[i - 1].end + 1})</span>
      <button class="link" type="button" data-action="toggle-prev">${showPrev ? "Hide" : "Show"}</button></div>`;
    if (showPrev) html += r[i - 1].turns.map(turn => turnHtml(turn, { faded: true })).join("");
  }
  html += `<div class="divider-label">Phase ${i + 1} · ${esc(M.macroLabel(phase))}</div>`;
  html += r[i].turns.map(turn => turnHtml(turn, {
    clickable: step === "micro",
    label: turn.speaker === "therapist" ? phase.micro[String(turn.turn_index)] || null : undefined,
    selected: step === "micro" && S.sel === turn.turn_index
  })).join("");
  if (!r[i].therapist.length) html += '<p class="muted small">This phase has no therapist turns.</p>';
  return html + "</div>";
}

function annotateSideHtml() {
  const i = curPhaseIndex();
  const phase = curPhase();
  const progress = M.phaseProgress(TAXONOMY, phase, ranges()[i]);
  const step = ui().step;
  const done = { micro: progress.microDone, reward: progress.rewardDone };
  const tabs = `<div class="step-tabs" role="tablist">${STEPS.map((s, k) => `
    <button type="button" role="tab" class="${step === s.key ? "active" : ""}" aria-selected="${step === s.key}" data-action="step" data-step="${s.key}">
      ${k + 1}. ${s.label}${s.key === "micro" ? ` ${progress.microLabelled}/${progress.microTotal}` : ""} ${done[s.key] ? '<span class="tick">✓</span>' : ""}</button>`).join("")}</div>`;
  const content = step === "micro" ? microStepHtml() : rewardStepHtml();
  return tabs + content;
}

function microOptionList(phase) {
  if (phase.macro === M.OTHER) {
    const q = S.microQuery.trim().toLowerCase();
    return MACROS.map(m => ({
      group: m.name,
      items: m.micro_actions.filter(a => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
    })).filter(g => g.items.length);
  }
  const macro = M.macroByName(TAXONOMY, phase.macro);
  return [{ group: null, items: macro ? macro.micro_actions : [] }];
}

function microStepHtml() {
  const i = curPhaseIndex();
  const phase = curPhase();
  const r = ranges()[i];
  const progress = M.phaseProgress(TAXONOMY, phase, r);
  if (!r.therapist.length) {
    return `<div class="side-scroll"><p class="muted">This phase has no therapist turns, so there is nothing to label.</p></div>
      <div class="side-footer"><button class="btn primary" type="button" data-action="step" data-step="reward">Continue → Phase reward</button></div>`;
  }
  const turn = S.sel !== null ? turnByIndex(S.sel) : null;
  const label = turn ? phase.micro[String(turn.turn_index)] : null;
  const groups = microOptionList(phase);
  const optionsHtml = groups.map(g => `${g.group ? `<div class="option-group-title">${esc(g.group)}</div>` : ""}${g.items.map(a => `
    <button type="button" class="option ${label?.action === a.name ? "on" : ""}" data-action="micro" data-value="${esc(a.name)}">
      <span class="k" aria-hidden="true"></span><span><span class="t">${esc(a.name)}</span><span class="d">${esc(a.description)}</span></span></button>`).join("")}`).join("");
  const pct = Math.round(100 * progress.microLabelled / Math.max(1, progress.microTotal));
  return `<div class="side-scroll">
    <h2>Micro actions</h2>
    <p class="panel-intro">Select a therapist turn on the left, then choose the micro action that best describes it. The next unlabelled turn is selected automatically.</p>
    <div class="micro-progress"><span>${progress.microLabelled} of ${progress.microTotal} therapist turns labelled</span><span>${pct}%</span></div>
    <div class="progress" style="margin-bottom:12px"><i style="width:${pct}%"></i></div>
    ${turn ? `<div class="selected-turn"><div class="who">Therapist #${turn.turn_index + 1}</div>${esc(turn.text)}</div>` : '<div class="selected-turn muted">Select a therapist turn on the left.</div>'}
    ${phase.macro === M.OTHER ? `<input type="search" data-field="micro-query" placeholder="Search all micro actions…" value="${esc(S.microQuery)}" style="margin-bottom:8px" aria-label="Search micro actions" />` : ""}
    <div class="options">
      ${optionsHtml}
      <button type="button" class="option ${label?.action === M.NONE ? "on" : ""}" data-action="micro" data-value="${M.NONE}">
        <span class="k" aria-hidden="true"></span><span><span class="t">None</span><span class="d">No micro action applies (e.g. a minimal response such as “Mm-hmm” or “Okay”).</span></span></button>
      <button type="button" class="option ${label?.action === M.OTHER ? "on" : ""}" data-action="micro" data-value="${M.OTHER}">
        <span class="k" aria-hidden="true"></span><span><span class="t">Other</span><span class="d">None of the listed micro actions fits: describe what the therapist does.</span></span></button>
      ${label?.action === M.OTHER ? `<input class="other-input" id="micro-other" type="text" maxlength="300" data-field="micro_other" placeholder="Describe the micro action, then press Enter" value="${esc(label.other || "")}" />` : ""}
    </div>
  </div>
  <div class="side-footer">${progress.microDone
    ? '<button class="btn primary" type="button" data-action="step" data-step="reward">Continue → Phase reward</button>'
    : `<button class="btn" type="button" data-action="next-unlabelled">Go to next unlabelled turn (${progress.microTotal - progress.microLabelled} left)</button>`}</div>`;
}

function rewardStepHtml() {
  const i = curPhaseIndex();
  const phase = curPhase();
  const macro = phase.macro === M.OTHER ? null : M.macroByName(TAXONOMY, phase.macro);
  const levels = macro ? macro.goal.success_levels : M.GENERIC_SUCCESS_LEVELS;
  const last = i === doc().phases.length - 1;
  return `<div class="side-scroll">
    <h2>Phase reward</h2>
    <p class="panel-intro">How far did this phase achieve the goal of its macro action?</p>
    ${macro ? `<div class="goal-box"><span class="lab">Goal</span><p>${esc(macro.goal.objective)}</p><span class="lab">What to look for</span><p>${esc(macro.goal.reward_hint)}</p></div>`
      : `<label class="field" style="margin-bottom:12px">Goal of this phase (optional)<textarea data-field="goal_other" rows="2" maxlength="600" placeholder="What was the therapist trying to achieve?">${esc(phase.goal_other)}</textarea></label>`}
    <div class="reward-options" role="radiogroup">${M.REWARD_LEVELS.slice().reverse().map(level => `
      <button type="button" role="radio" aria-checked="${phase.reward === level.value}" class="reward-option ${phase.reward === level.value ? "on" : ""}" data-action="reward" data-value="${level.value}">
        <span class="score">${level.value}</span><span><span class="t">${level.label}</span><span class="d">${esc(levels[level.key])}</span></span></button>`).join("")}</div>
    <label class="field">Comment (optional)<textarea data-field="reward_comment" rows="2" maxlength="2000" placeholder="Anything that informed your rating">${esc(phase.reward_comment)}</textarea></label>
    ${S.errors.length ? `<ul class="error-list">${S.errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
  </div>
  <div class="side-footer"><button class="btn primary" type="button" data-action="complete-phase">${last ? "Finish phases → CTRS rating" : `Complete phase ${i + 1} → Phase ${i + 2}`}</button></div>`;
}

// ---------- stage 3
function ctrsMainHtml() {
  const r = ranges();
  return `<div class="transcript">${doc().phases.map((phase, i) => `
    <div class="divider-label">Phase ${i + 1} · ${esc(M.macroLabel(phase))}</div>
    ${r[i].turns.map(turn => turnHtml(turn)).join("")}`).join("")}</div>`;
}

function anchorFor(item, value) {
  if (value === undefined || value === null) return "";
  if (value % 2 === 0) return `<b>${value}:</b> ${esc(item.anchors[String(value)])}`;
  return `<b>${value}:</b> between ${value - 1} and ${value + 1}. <span>${esc(item.anchors[String(value - 1)])}</span> … <span>${esc(item.anchors[String(value + 1)])}</span>`;
}

function ctrsSideHtml() {
  const ctrs = TAXONOMY.ctrs;
  const scores = doc().ctrs;
  const doneCount = ctrs.items.filter(item => Number.isInteger(scores[item.key])).length;
  let number = 0;
  const parts = ctrs.parts.map(part => `<h3 class="ctrs-part">${esc(part.title)}</h3>${ctrs.items.filter(item => item.part === part.key).map(item => {
    number += 1;
    const value = scores[item.key];
    const open = S.allAnchors || S.openAnchors.has(item.key);
    return `<div class="ctrs-item" id="ctrs-${item.key}">
      <div class="ci-head"><span class="ci-num">${number}</span><b>${esc(item.label)}</b>
        <button class="link" type="button" data-action="anchors" data-key="${item.key}">${open ? "Hide anchors" : "Anchors"}</button></div>
      <div class="scale" role="radiogroup" aria-label="${esc(item.label)}">${ctrs.scale.map(s => `
        <button type="button" role="radio" aria-checked="${value === s.value}" class="${value === s.value ? "on" : ""} ${s.value % 2 === 0 ? "even" : ""}" title="${s.value} · ${esc(s.label)}" data-action="ctrs" data-key="${item.key}" data-value="${s.value}">${s.value}</button>`).join("")}</div>
      <div class="scale-labels"><span>Poor</span><span>Satisfactory</span><span>Excellent</span></div>
      ${Number.isInteger(value) && !open ? `<div class="anchor-now">${anchorFor(item, value)}</div>` : ""}
      ${open ? `<div class="anchors">${[0, 2, 4, 6].map(v => `<div><strong>${v}</strong><span>${esc(item.anchors[String(v)])}</span></div>`).join("")}${item.note ? `<p class="small" style="margin:4px 0 0"><i>${esc(item.note)}</i></p>` : ""}</div>` : ""}
    </div>`;
  }).join("")}`).join("");
  return `<div class="side-scroll">
    <h2>Cognitive Therapy Rating Scale</h2>
    <p class="panel-intro">Rate the therapist over the whole session from 0 (poor) to 6 (excellent). Anchors describe the even scores; use 1, 3 or 5 for performance between two anchors. The transcript is on the left for reference.</p>
    <button class="link" type="button" data-action="all-anchors">${S.allAnchors ? "Hide all anchors" : "Show all anchors"}</button>
    ${parts}
    <label class="field" style="margin-top:16px">Comments about the session (optional)<textarea data-field="ctrs_comments" rows="3" maxlength="4000">${esc(doc().ctrs_comments)}</textarea></label>
    ${S.errors.length ? `<ul class="error-list">${S.errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
  </div>
  <div class="side-footer">
    <p class="muted small" style="margin:0 0 8px">${doneCount} of ${ctrs.items.length} items rated.</p>
    <button class="btn primary" type="button" data-action="submit">Submit session</button>
  </div>`;
}

function doneHtml() {
  const flat = M.flattenDocument(TAXONOMY, doc(), S.turns);
  const progress = M.documentProgress(TAXONOMY, doc(), S.turns);
  return `<div class="card done-card">
    <div class="done-check">✓</div>
    <h1>Session submitted</h1>
    <p class="muted">Thank you. Your annotation of session ${S.session.display_order} (patient “${esc(S.session.patient)}”) has been saved.</p>
    <div class="done-stats">
      <div><b>${progress.phases}</b>phases</div>
      <div><b>${progress.microLabelled}</b>therapist turns labelled</div>
      <div><b>${flat.ctrs.overall_sum} / 66</b>CTRS total</div>
      <div><b>${minutes(S.ann.active_seconds)}</b>active time</div>
    </div>
    <div class="done-actions">
      <a class="btn primary" href="#/">Back to sessions</a>
      <button class="btn" type="button" data-action="reopen">Reopen to make changes</button>
    </div>
  </div>`;
}

// ---------- stage briefings (shown before each stage; reopened with "Instructions")
function introHeader(stage, title, lead) {
  const number = { segment: 1, annotate: 2, ctrs: 3 }[stage];
  return `<p class="intro-kicker">Session ${S.session.display_order} · Patient “${esc(S.session.patient)}” · Stage ${number} of 3</p>
    <h1>${title}</h1><p class="intro-lead">${lead}</p>`;
}

function introSteps(steps) {
  return `<ol class="intro-steps">${steps.map(([title, text]) => `<li><b>${title}</b><span>${text}</span></li>`).join("")}</ol>`;
}

function introActions(stage) {
  const label = doc().ui.seen?.[stage]
    ? `Back to ${STAGE_NAMES[stage]}`
    : { segment: "Start Stage 1: show the transcript", annotate: "Start Stage 2: annotate phase 1", ctrs: "Start the CTRS rating" }[stage];
  return `<div class="intro-actions"><button class="btn primary big" type="button" data-action="start-stage">${label} →</button></div>`;
}

function introHtml(stage) {
  if (stage === "segment") {
    const s = S.session;
    return `<div class="intro">
      ${introHeader(stage, "Read the session and divide it into phases", "In this first stage you read the whole transcript and describe how the session is structured.")}
      <div class="intro-session"><b>About this session</b><p>${esc(s.summary)}</p>
        <div class="chips">${s.conditions.map(c => `<span class="chip">${esc(c)}</span>`).join("")}</div>
        <span class="muted small">${s.therapist_turns} therapist turns · about ${Math.max(5, Math.round(s.word_count / 230))} minutes of reading</span></div>
      ${introSteps([
        ["Read the transcript", "Read the whole session first, as you would review a recorded session."],
        ["Mark where each phase begins", "Hover over the therapist turn where a new phase starts and click <b>New phase here</b>. The first phase starts automatically at the beginning."],
        ["Name each phase", "Choose the <b>macro action</b> that best describes what the therapist is doing in that phase. Choose <b>Other</b> and describe it in a few words if none of the 12 fits."]
      ])}
      <div class="intro-defs">
        <div><h3>What is a phase?</h3><p>A continuous part of the session in which the therapist pursues <b>one therapeutic aim with one overall approach</b>, for example building rapport, assessing the presenting problem, setting the agenda, restructuring an automatic thought, or planning homework. A new phase begins when the therapist moves on to a different aim or strategy.</p><p>A phase usually spans several exchanges. A brief aside does not need its own phase.</p></div>
        <div><h3>What is a macro action?</h3><p>The name of the therapist's <b>overall strategy</b> during a phase, comparable to the components of a structured CBT session (e.g. agenda setting, psychoeducation, cognitive restructuring, behavioural activation, homework review). Each phase gets exactly one macro action, and the same macro action can occur in several phases.</p></div>
      </div>
      <h2 class="intro-h2">The 12 macro actions</h2>
      <div class="macro-grid">${MACROS.map(m => `<div class="macro-card"><b>${esc(m.name)}</b><p>${esc(m.description)}</p></div>`).join("")}</div>
      ${introActions(stage)}
    </div>`;
  }
  if (stage === "annotate") {
    const example = MACROS.find(m => m.name.startsWith("Cognitive Interventions")) || MACROS[0];
    const levels = example.goal.success_levels;
    return `<div class="intro">
      ${introHeader(stage, "Annotate each phase", `You now go through your ${doc().phases.length} phases one at a time. Each phase has two steps.`)}
      ${introSteps([
        ["Micro action for every therapist turn", "Click a therapist turn and choose its <b>micro action</b>: the specific therapeutic move in that turn, such as a validating reflection, a Socratic question or assigning homework. The options are the micro actions of the phase's macro action. Choose <b>None</b> for minimal responses (“Mm-hmm”, “Okay”) and <b>Other</b> if the move is not listed, with a short description. Patient turns are context only."],
        ["Phase reward at the end of the phase", "Judge how far the phase achieved the <b>goal of its macro action</b>: <b>0 Unsuccessful</b>, <b>1 Acceptable</b> or <b>2 Ideal</b>. The goal and the criteria for each level are shown next to the transcript."]
      ])}
      <h2 class="intro-h2">Example: a “${esc(example.name)}” phase</h2>
      <div class="intro-defs">
        <div><h3>Micro actions you can choose from</h3><ol class="example-list">${example.micro_actions.map(a => `<li><b>${esc(a.name)}</b>: ${esc(a.description)}</li>`).join("")}</ol><p class="muted small">plus <b>None</b> and <b>Other</b></p></div>
        <div><h3>Phase reward</h3><p><b>Goal:</b> ${esc(example.goal.objective)}</p>
          <ul class="example-list"><li><b>2 Ideal</b>: ${esc(levels.ideal)}</li><li><b>1 Acceptable</b>: ${esc(levels.acceptable)}</li><li><b>0 Unsuccessful</b>: ${esc(levels.unsuccessful)}</li></ul></div>
      </div>
      <div class="intro-tip">After each choice, the next unlabelled turn is selected automatically. To change the phases themselves, go back to Stage 1 with the bar at the top.</div>
      ${introActions(stage)}
    </div>`;
  }
  const items = part => TAXONOMY.ctrs.items.filter(item => item.part === part).map(item => `<li>${esc(item.label)}</li>`).join("");
  return `<div class="intro">
    ${introHeader(stage, "Rate the whole session with the CTRS", "Finally, rate the therapist's competence over the whole session with the Cognitive Therapy Rating Scale (CTRS).")}
    ${introSteps([
      ["Score all 11 items from 0 to 6", "0 = poor, 2 = mediocre, 4 = good, 6 = excellent. Each item has anchors describing 0, 2, 4 and 6; use 1, 3 or 5 when performance falls between two anchors."],
      ["Judge the therapist's demonstrated skill", "Rate what the therapist actually did, taking into account how difficult the patient was. The whole transcript stays visible next to the form."],
      ["Submit", "Add an optional comment and submit. You can reopen a submitted session later if you need to change something."]
    ])}
    <div class="intro-defs">
      <div><h3>${esc(TAXONOMY.ctrs.parts[0].title)}</h3><ol class="example-list">${items("part1")}</ol></div>
      <div><h3>${esc(TAXONOMY.ctrs.parts[1].title)}</h3><ol class="example-list" start="7">${items("part2")}</ol></div>
    </div>
    ${introActions(stage)}
  </div>`;
}

function startStage() {
  const stage = S.ann.stage;
  doc().ui.seen = { ...(doc().ui.seen || {}), [stage]: true };
  S.showIntro = false;
  if (stage === "annotate" && ui().step === "micro") {
    S.sel = null;
    selectFirstUnlabelled();
  }
  changed();
  render();
  window.scrollTo(0, 0);
  if (stage === "annotate" && S.sel !== null) setTimeout(() => scrollToTurn(S.sel, "center"), 60);
}

// ------------------------------------------------------------------ actions
function refresh({ main = true, side = true, nav = true, bar = true, reset = false } = {}) {
  if (S.view !== "session") return;
  if (main && $("#pane-main")) paintMain(reset);
  if (side && $("#pane-side")) paintSide(reset);
  if (nav && $("#phase-nav")) paintPhaseNav();
  if (bar) paintBar();
}

function scrollToTurn(index, block = "nearest") {
  const el = document.getElementById(`turn-${index}`);
  if (el) el.scrollIntoView({ block, behavior: "smooth" });
}

function confirmStageTwoLoss(phases, what) {
  if (!doc().segmentation_done) return true;
  if (!phases.some(p => p && M.hasStageTwoData(p))) return true;
  return window.confirm(`This ${what} affects phases that already have Stage 2 annotations. Annotations that no longer fit (micro actions outside the phase or macro action, and the phase reward) will be cleared. Continue?`);
}

function splitAt(turnIndex) {
  const containing = doc().phases.find((p, k) => p.start <= turnIndex && (k + 1 >= doc().phases.length || doc().phases[k + 1].start > turnIndex));
  if (!confirmStageTwoLoss([containing], "split")) return;
  M.splitAt(TAXONOMY, doc(), S.turns, turnIndex);
  changed();
  refresh();
}

function mergePhase(index) {
  if (!confirmStageTwoLoss([doc().phases[index - 1], doc().phases[index]], "merge")) return;
  M.mergeWithPrevious(TAXONOMY, doc(), S.turns, index);
  changed();
  refresh();
}

function setMacro(index, value, select) {
  const phase = doc().phases[index];
  if (phase.macro && phase.macro !== value && !confirmStageTwoLoss([phase], "change of macro action")) {
    select.value = phase.macro;
    return;
  }
  M.setPhaseMacro(TAXONOMY, doc(), S.turns, index, value, phase.macro_other);
  changed();
  refresh();
  if (value === M.OTHER) document.querySelector(`input[data-field="macro_other"][data-phase="${index}"]`)?.focus();
}

function firstIncompleteStep(index) {
  const progress = M.phaseProgress(TAXONOMY, doc().phases[index], ranges()[index]);
  if (!progress.microDone) return "micro";
  if (!progress.rewardDone) return "reward";
  return "micro";
}

function goToPhase(index, step = null) {
  ui().phase = Math.min(Math.max(index, 0), doc().phases.length - 1);
  ui().step = step || firstIncompleteStep(ui().phase);
  S.showPrev = null;
  S.errors = [];
  S.sel = null;
  if (ui().step === "micro") selectFirstUnlabelled();
  changed();
  refresh({ reset: true });
  if (ui().step === "micro" && S.sel !== null) setTimeout(() => scrollToTurn(S.sel, "center"), 30);
}

function setStep(step) {
  if (ui().step === step) return;
  ui().step = step;
  S.showPrev = null;
  S.errors = [];
  if (step === "micro") {
    if (S.sel === null || !ranges()[curPhaseIndex()].therapist.some(t => t.turn_index === S.sel)) selectFirstUnlabelled();
  }
  changed();
  refresh({ reset: true });
  if (step === "micro" && S.sel !== null) setTimeout(() => scrollToTurn(S.sel, "center"), 30);
}

function therapistTurns() {
  return ranges()[curPhaseIndex()].therapist;
}

function selectFirstUnlabelled() {
  const turns = therapistTurns();
  const phase = curPhase();
  const next = turns.find(t => !M.microLabelComplete(phase.micro[String(t.turn_index)]));
  S.sel = (next || turns[0])?.turn_index ?? null;
}

function nextUnlabelled(after) {
  const turns = therapistTurns();
  const phase = curPhase();
  const unlabelled = turns.filter(t => !M.microLabelComplete(phase.micro[String(t.turn_index)]));
  if (!unlabelled.length) return null;
  return (unlabelled.find(t => t.turn_index > after) || unlabelled[0]).turn_index;
}

function chooseMicro(action) {
  if (S.sel === null) { toast("Select a therapist turn first."); return; }
  const phase = curPhase();
  const key = String(S.sel);
  if (action === M.OTHER) {
    const previous = phase.micro[key];
    phase.micro[key] = { action: M.OTHER, other: previous?.action === M.OTHER ? previous.other : "" };
    changed();
    refresh({ bar: false });
    $("#micro-other")?.focus();
    return;
  }
  phase.micro[key] = { action };
  const next = nextUnlabelled(S.sel);
  if (next !== null) S.sel = next;
  changed();
  refresh({ bar: false });
  if (next !== null) scrollToTurn(next, "center");
}

function completePhase() {
  const i = curPhaseIndex();
  const phase = curPhase();
  const progress = M.phaseProgress(TAXONOMY, phase, ranges()[i]);
  const errors = [];
  if (!progress.microDone) errors.push(`${progress.microTotal - progress.microLabelled} therapist turn(s) still need a micro action (step 1).`);
  if (!progress.rewardDone) errors.push("Choose the phase reward.");
  if (errors.length) {
    S.errors = errors;
    refresh({ main: false, nav: false, bar: false });
    return;
  }
  S.errors = [];
  const all = phaseProgressAll();
  const nextIncomplete = all.findIndex((p, k) => k > i && !p.complete);
  const anyIncomplete = all.findIndex(p => !p.complete);
  if (nextIncomplete >= 0) goToPhase(nextIncomplete, "micro");
  else if (anyIncomplete >= 0) { toast(`Phase ${anyIncomplete + 1} is not complete yet.`); goToPhase(anyIncomplete); }
  else goToStage("ctrs");
}

function goToStage(stage) {
  const prev = S.ann.stage;
  if (stage === prev) return;
  if (stage === "annotate") {
    const errors = M.segmentationErrors(doc());
    if (errors.length) { toast(errors[0]); return; }
    const event = doc().segmentation_done && prev === "segment" ? "segmentation_updated" : prev === "segment" ? "segmentation_completed" : "";
    doc().segmentation_done = true;
    S.ann.stage = "annotate";
    if (prev === "segment") {
      const firstOpen = phaseProgressAll().findIndex(p => !p.complete);
      ui().phase = firstOpen >= 0 ? firstOpen : 0;
      ui().step = firstIncompleteStep(ui().phase);
    }
    S.sel = null;
    if (ui().step === "micro") selectFirstUnlabelled();
    changed(event);
  } else if (stage === "ctrs") {
    const errors = M.annotationErrors(TAXONOMY, doc(), S.turns);
    if (errors.length) { toast(errors[0]); return; }
    S.ann.stage = "ctrs";
    changed(prev === "annotate" ? "annotation_completed" : "");
  } else if (stage === "segment") {
    S.ann.stage = "segment";
    changed(doc().segmentation_done ? "segmentation_reopened" : "");
  }
  S.errors = [];
  render();
}

async function submitSession() {
  const errors = M.submissionErrors(TAXONOMY, doc(), S.turns);
  if (errors.length) {
    S.errors = errors.slice(0, 6);
    refresh({ main: false, nav: false, bar: false });
    return;
  }
  if (!window.confirm("Submit this session? You can reopen it later if you need to change something.")) return;
  await flushSave();
  if (S.conflict) return;
  const delta = S.active.unsent;
  S.active.unsent = 0;
  try {
    const result = await api(`/api/sessions/${S.session.id}/submit`, {
      method: "POST", body: { data: doc(), revision: S.ann.revision, active_seconds_delta: delta }
    });
    Object.assign(S.ann, { status: "submitted", stage: "done", revision: result.annotation.revision, active_seconds: result.annotation.active_seconds });
    S.save.dirty = false;
    store.remove(backupKey());
    S.errors = [];
    render();
    window.scrollTo(0, 0);
  } catch (error) {
    S.active.unsent += delta;
    if (handleAuthError(error)) return;
    if (error.status === 409) { showConflict(); return; }
    S.errors = error.data?.errors || [error.message];
    refresh({ main: false, nav: false, bar: false });
  }
}

async function reopenSession() {
  try {
    const result = await api(`/api/sessions/${S.session.id}/reopen`, { method: "POST", body: { revision: S.ann.revision } });
    Object.assign(S.ann, { status: "in_progress", stage: "ctrs", revision: result.annotation.revision });
    render();
  } catch (error) {
    if (handleAuthError(error)) return;
    if (error.status === 409) { showConflict(); return; }
    toast(error.message);
  }
}

function openInfo() {
  const s = S.session;
  $("#info-body").innerHTML = `<dl class="meta">
    <dt>Patient</dt><dd>“${esc(s.patient)}”</dd>
    <dt>Presenting conditions</dt><dd><div class="chips">${s.conditions.map(c => `<span class="chip">${esc(c)}</span>`).join("")}</div></dd>
    <dt>Summary</dt><dd>${esc(s.summary)}</dd>
    <dt>Title</dt><dd>${esc(s.title)}</dd>
    <dt>Length</dt><dd>${s.therapist_turns} therapist turns, ${s.patient_turns} patient turns, ${s.word_count.toLocaleString()} words</dd>
  </dl>`;
  $("#info-dialog").showModal();
}

// ------------------------------------------------------------------ events
document.addEventListener("click", event => {
  const close = event.target.closest("[data-close]");
  if (close) { close.closest("dialog").close(); return; }
  if (event.target.matches("dialog")) { event.target.close(); return; }
  const el = event.target.closest("[data-action]");
  if (!el || el.tagName === "SELECT") return;
  const action = el.dataset.action;
  const phaseIdx = Number(el.dataset.phase);
  switch (action) {
    case "guide": $("#guide-dialog").showModal(); break;
    case "info": openInfo(); break;
    case "sign-out":
      flushSave().finally(() => signOut());
      break;
    case "stage": goToStage(el.dataset.stage); break;
    case "split": event.stopPropagation(); splitAt(Number(el.dataset.turn)); break;
    case "merge": mergePhase(phaseIdx); break;
    case "goto-phase": document.getElementById(`phase-${phaseIdx}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); break;
    case "finish-seg": goToStage("annotate"); break;
    case "goto-phase2": goToPhase(phaseIdx); break;
    case "phase-prev": goToPhase(curPhaseIndex() - 1); break;
    case "phase-next": goToPhase(curPhaseIndex() + 1); break;
    case "step": setStep(el.dataset.step); break;
    case "toggle-prev": {
      const shown = S.showPrev ?? false;
      S.showPrev = !shown;
      refresh({ side: false, nav: false, bar: false, reset: !shown });
      break;
    }
    case "select-turn":
      S.sel = Number(el.dataset.turn);
      refresh({ nav: false, bar: false });
      break;
    case "micro": chooseMicro(el.dataset.value); break;
    case "next-unlabelled": {
      const next = nextUnlabelled(S.sel ?? -1);
      if (next !== null) { S.sel = next; refresh({ nav: false, bar: false }); scrollToTurn(next, "center"); }
      break;
    }
    case "reward":
      curPhase().reward = Number(el.dataset.value);
      S.errors = [];
      changed();
      refresh({ main: false, bar: false });
      break;
    case "complete-phase": completePhase(); break;
    case "anchors":
      if (S.openAnchors.has(el.dataset.key)) S.openAnchors.delete(el.dataset.key); else S.openAnchors.add(el.dataset.key);
      refresh({ main: false, nav: false, bar: false });
      break;
    case "all-anchors":
      S.allAnchors = !S.allAnchors;
      S.openAnchors.clear();
      refresh({ main: false, nav: false, bar: false });
      break;
    case "ctrs":
      doc().ctrs[el.dataset.key] = Number(el.dataset.value);
      S.errors = [];
      changed();
      refresh({ main: false, nav: false });
      break;
    case "submit": submitSession(); break;
    case "intro":
      S.showIntro = true;
      render();
      window.scrollTo(0, 0);
      break;
    case "start-stage": startStage(); break;
    case "reopen": reopenSession(); break;
    default: break;
  }
});

document.addEventListener("change", event => {
  const el = event.target;
  if (el.matches('select[data-action="macro"]')) setMacro(Number(el.dataset.phase), el.value, el);
});

document.addEventListener("input", event => {
  const el = event.target;
  const field = el.dataset?.field;
  if (!field || S.view !== "session") return;
  if (field === "macro_other") {
    doc().phases[Number(el.dataset.phase)].macro_other = el.value;
    changed();
    refresh({ main: false, nav: false });
  } else if (field === "micro_other") {
    const label = curPhase().micro[String(S.sel)];
    if (label) label.other = el.value;
    changed();
    const caret = el.selectionStart;
    refresh({ bar: false });
    const again = $("#micro-other");
    if (again) { again.focus(); again.setSelectionRange(caret, caret); }
  } else if (field === "reward_comment") { curPhase().reward_comment = el.value; changed(); }
  else if (field === "goal_other") { curPhase().goal_other = el.value; changed(); }
  else if (field === "ctrs_comments") { doc().ctrs_comments = el.value; changed(); }
  else if (field === "micro-query") {
    S.microQuery = el.value;
    const start = el.selectionStart;
    refresh({ main: false, nav: false, bar: false });
    const again = document.querySelector(`[data-field="${field}"]`);
    if (again) { again.focus(); again.setSelectionRange(start, start); }
  }
});

document.addEventListener("keydown", event => {
  if (event.target.id === "micro-other" && event.key === "Enter") {
    event.preventDefault();
    const label = curPhase().micro[String(S.sel)];
    if (!M.microLabelComplete(label)) return;
    const next = nextUnlabelled(S.sel);
    if (next !== null) S.sel = next;
    refresh({ bar: false });
    if (next !== null) scrollToTurn(next, "center");
    return;
  }
});

document.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;
  if (form.id === "login-form") {
    const email = $("#login-email").value.trim();
    const code = $("#login-code").value;
    S.email = email;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const data = await api("/api/login", { method: "POST", body: { email, access_code: code } });
      S.token = data.token;
      S.email = data.email;
      S.expert = data.expert;
      store.set(TOKEN_KEY, data.token);
      S.loginError = "";
      if (data.needs_profile) { S.view = "profile"; render(); } else await route();
    } catch (error) {
      S.loginError = error.message;
      render();
    }
  } else if (form.id === "profile-form") {
    const values = Object.fromEntries(new FormData(form).entries());
    values.years_experience = Number(values.years_experience);
    try {
      const data = await api("/api/profile", { method: "POST", body: values });
      S.expert = data.expert;
      S.profileError = "";
      await route();
    } catch (error) {
      if (error.status === 401) { signOut(error.message); return; }
      S.profileError = error.message;
      render();
    }
  }
});

boot();
