// SQLite schema for the AnnotationStore Durable Object (applied idempotently on start-up).
export const SCHEMA = `
-- Experts are identified by their normalised (lower-case) email address.
CREATE TABLE IF NOT EXISTS experts (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  institution TEXT NOT NULL,
  latest_degree TEXT NOT NULL,
  years_experience INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- Session content is loaded from the private seed (data/seed.sql); it is never committed to git.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  display_order INTEGER NOT NULL,
  user_idx INTEGER NOT NULL,
  session_idx INTEGER NOT NULL,
  patient TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  conditions_json TEXT NOT NULL,
  therapist_turns INTEGER NOT NULL,
  patient_turns INTEGER NOT NULL,
  word_count INTEGER NOT NULL,
  ctrs_overall_sum INTEGER
);

CREATE TABLE IF NOT EXISTS session_turns (
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('therapist', 'patient')),
  utterance_id TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_index)
);

-- One evolving annotation document per expert and session (autosaved).
CREATE TABLE IF NOT EXISTS annotations (
  email TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'submitted')),
  stage TEXT NOT NULL CHECK (stage IN ('segment', 'annotate', 'ctrs', 'done')),
  data_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  PRIMARY KEY (email, session_id)
);

-- Immutable copies written at every stage transition and submission (audit / recovery).
CREATE TABLE IF NOT EXISTS annotation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL,
  stage TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_annotations_session ON annotations(session_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_owner ON annotation_snapshots(email, session_id);
`;
