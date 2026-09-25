/**
 * SQLite schema (dev profile). Mirrored in infra/dev/schema.sql — keep the
 * two in sync. Every table carries project_id; the dev tenant is "local".
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  name TEXT NOT NULL,
  repository TEXT NOT NULL,
  policy_revision INTEGER NOT NULL DEFAULT 1,
  meta_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  input_json TEXT NOT NULL,
  resolved_tips_json TEXT NOT NULL,
  selected_commits_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commits (
  sha TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  committed_at TEXT NOT NULL,
  parents_json TEXT NOT NULL,
  PRIMARY KEY (project_id, sha)
);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  commit_sha TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  build_id TEXT NOT NULL REFERENCES builds(id),
  scenario_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  evidence_label TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  request_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, request_key)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'project',
  retention TEXT NOT NULL DEFAULT 'standard',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ui_entities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  entity_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, entity_key)
);

CREATE TABLE IF NOT EXISTS entity_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  entity_id TEXT NOT NULL REFERENCES ui_entities(id),
  build_id TEXT,
  contract_digest TEXT NOT NULL,
  representation_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS occurrences (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  capture_id TEXT NOT NULL REFERENCES captures(id),
  entity_version_id TEXT,
  anchor TEXT,
  parent_id TEXT,
  visible_text TEXT,
  bounds_json TEXT NOT NULL,
  completeness TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_index (
  capture_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  anchor TEXT,
  text TEXT
);
CREATE INDEX IF NOT EXISTS idx_search_index_project ON search_index(project_id);

CREATE TABLE IF NOT EXISTS lineage_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  relation TEXT NOT NULL,
  from_entity TEXT NOT NULL,
  to_entity TEXT NOT NULL,
  evidence TEXT NOT NULL,
  score REAL NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'candidate',
  matcher_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  request_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  status TEXT NOT NULL,
  candidates_json TEXT,
  failure_json TEXT,
  accepted_candidate_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT NOT NULL DEFAULT 'planning',
  payload_json TEXT NOT NULL,
  dedup_key TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_token TEXT,
  lease_expires_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS upload_slots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_manifests (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  manifest_json TEXT NOT NULL
);

-- Device-synced profile preferences (R2 stream B). The API itself holds no
-- device preference state otherwise; this table is the server side of
-- POST /v1/profiles/:profileId/sync, namespaced by opaque profile id.
CREATE TABLE IF NOT EXISTS synced_preferences (
  profile_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  active_spec_digest TEXT,
  spec_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, project_id, scope, scope_key)
);

-- Retention/GC bookkeeping (R2 stream G): manual and scheduled runs record
-- their outcome here; the index-worker's daily check reads MAX(finished_at).
CREATE TABLE IF NOT EXISTS gc_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  dry_run INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_occurrences_capture ON occurrences(capture_id);
CREATE INDEX IF NOT EXISTS idx_captures_project_scenario ON captures(project_id, scenario_id);
`;
