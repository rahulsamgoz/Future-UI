/**
 * Runner-manager SQLite schema (R2 stream D). Own database file, separate
 * from the API's metadata store: this service only tracks capture runs and
 * the worker pool that executes them.
 */
export const RUNNER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  scenarios_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  worker_id TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_worker ON runs (worker_id);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('docker','process')),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','busy','dead')),
  last_heartbeat TEXT NOT NULL,
  registered_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workers_status ON workers (status, last_heartbeat);
`;
