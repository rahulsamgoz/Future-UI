/**
 * Run + worker store over SQLite (R2 stream D). The lease pattern is the same
 * as apps/api/src/jobs.ts (claim → lease token + expiry → heartbeat →
 * terminal, at-least-once delivery) but duplicated locally on purpose: no
 * imports across apps. Differences from the API job queue:
 *
 * - A worker claims the NEXT queued run for itself (pull), not a specific job.
 * - A worker executes at most one run at a time; `busy` workers get nothing.
 * - A worker heartbeat also extends the lease of the run the worker is
 *   currently executing, so an active worker never loses its run lease.
 * - A run whose lease expires is re-queued and its worker is marked dead
 *   (it stopped heartbeating; the pool respawns a fresh worker).
 */
import { newId, UiIntelligenceError } from "@ui-intelligence/protocol";
import type { Db } from "./db.js";
import { nowIso } from "./db.js";

export const LEASE_MS = 30_000;
/** A worker is dead after this long without a heartbeat (3 missed 10s beats). */
export const WORKER_EXPIRY_MS = 60_000;

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export type ScenarioResult = {
  scenarioId: string;
  status: "captured" | "failed";
  captureId?: string;
  error?: string;
};

export type RunRecord = {
  runId: string;
  projectId: string;
  repoUrl: string;
  commitSha: string;
  scenarios: string[];
  status: RunStatus;
  workerId: string | null;
  attempt: number;
  maxAttempts: number;
  error: string | null;
  results: ScenarioResult[] | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateRunInput = {
  projectId: string;
  repoUrl: string;
  commitSha: string;
  scenarios: string[];
  maxAttempts?: number;
};

function runFromRow(row: Record<string, unknown>): RunRecord {
  const resultJson = row.result_json as string | null;
  return {
    runId: row.id as string,
    projectId: row.project_id as string,
    repoUrl: row.repo_url as string,
    commitSha: row.commit_sha as string,
    scenarios: JSON.parse(row.scenarios_json as string) as string[],
    status: row.status as RunStatus,
    workerId: (row.worker_id as string | null) ?? null,
    attempt: row.attempt as number,
    maxAttempts: row.max_attempts as number,
    error: (row.error as string | null) ?? null,
    results: resultJson ? (JSON.parse(resultJson) as { results: ScenarioResult[] }).results : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowById(db: Db, runId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined;
}

export function createRun(db: Db, input: CreateRunInput): string {
  const runId = newId("run");
  const now = nowIso();
  db.prepare(
    "INSERT INTO runs (id, project_id, repo_url, commit_sha, scenarios_json, status, attempt, max_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)"
  ).run(runId, input.projectId, input.repoUrl, input.commitSha, JSON.stringify(input.scenarios), input.maxAttempts ?? 3, now, now);
  return runId;
}

export function getRun(db: Db, runId: string): RunRecord | null {
  const row = rowById(db, runId);
  return row ? runFromRow(row) : null;
}

export type WorkerKind = "docker" | "process";
export type WorkerStatus = "idle" | "busy" | "dead";

export function registerWorker(db: Db, kind: WorkerKind): string {
  const workerId = newId("worker");
  db.prepare("INSERT INTO workers (id, kind, status, last_heartbeat, registered_at) VALUES (?, ?, 'idle', ?, ?)").run(
    workerId,
    kind,
    nowIso(),
    nowIso()
  );
  return workerId;
}

function workerRow(db: Db, workerId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM workers WHERE id = ?").get(workerId) as Record<string, unknown> | undefined;
}

/** Heartbeat: refreshes worker liveness and extends any run lease it holds. */
export function heartbeatWorker(db: Db, workerId: string, leaseMs = LEASE_MS): { leaseExpiresAt: string | null } {
  const row = workerRow(db, workerId);
  if (!row) {
    throw new UiIntelligenceError("NOT_FOUND", `worker ${workerId} not found`, { httpStatus: 404 });
  }
  if (row.status === "dead") {
    throw new UiIntelligenceError("JOB_LEASE_LOST", "worker was marked dead; register a new worker", { httpStatus: 409 });
  }
  const now = nowIso();
  db.prepare("UPDATE workers SET last_heartbeat = ? WHERE id = ?").run(now, workerId);
  // An active worker never loses its run lease: extend it here (the worker
  // heartbeats every 10s, well inside the 30s lease).
  const run = db
    .prepare("SELECT id FROM runs WHERE worker_id = ? AND status = 'running'")
    .get(workerId) as { id: string } | undefined;
  if (run) {
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    db.prepare("UPDATE runs SET lease_expires_at = ?, updated_at = ? WHERE id = ?").run(leaseExpiresAt, now, run.id);
    return { leaseExpiresAt };
  }
  return { leaseExpiresAt: null };
}

export type RunClaim = {
  runId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  run: {
    projectId: string;
    repoUrl: string;
    commitSha: string;
    scenarios: string[];
  };
};

/**
 * Reap dead infrastructure inside the claim transaction: workers without a
 * recent heartbeat become dead, their running runs go back to the queue, and
 * any run whose lease expired is re-queued with its worker marked dead.
 */
function reapExpired(db: Db): void {
  const now = nowIso();
  const staleWorkerCutoff = new Date(Date.now() - WORKER_EXPIRY_MS).toISOString();
  db.prepare("UPDATE workers SET status = 'dead' WHERE status IN ('idle','busy') AND last_heartbeat < ?").run(staleWorkerCutoff);
  // Re-queue runs whose lease expired OR whose worker died (dead workers
  // cannot complete their runs even if the run lease is still current).
  db.prepare(
    "UPDATE runs SET status = 'queued', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ? OR worker_id IN (SELECT id FROM workers WHERE status = 'dead'))"
  ).run(now, now);
  // A live busy worker whose run was re-queued has nothing left to do.
  db.prepare(
    "UPDATE workers SET status = 'idle' WHERE status = 'busy' AND id NOT IN (SELECT worker_id FROM runs WHERE status = 'running' AND worker_id IS NOT NULL)"
  ).run();
}

/**
 * Claim the next queued run for a worker. Returns null when nothing is
 * available (queue empty or this worker is busy/dead).
 */
export function claimNextRun(db: Db, workerId: string, leaseMs = LEASE_MS): RunClaim | null {
  const tx = db.transaction((): RunClaim | null => {
    reapExpired(db);
    const worker = workerRow(db, workerId);
    if (!worker) {
      throw new UiIntelligenceError("NOT_FOUND", `worker ${workerId} not found`, { httpStatus: 404 });
    }
    if (worker.status === "dead") {
      throw new UiIntelligenceError("JOB_LEASE_LOST", "worker was marked dead; register a new worker", { httpStatus: 409 });
    }
    if (worker.status === "busy") {
      return null; // one run per worker at a time
    }
    const run = db
      .prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    if (!run) return null;
    const leaseToken = newId("lease");
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const now = nowIso();
    db.prepare(
      "UPDATE runs SET status = 'running', worker_id = ?, lease_token = ?, lease_expires_at = ?, attempt = attempt + 1, updated_at = ? WHERE id = ?"
    ).run(workerId, leaseToken, leaseExpiresAt, now, run.id as string);
    db.prepare("UPDATE workers SET status = 'busy', last_heartbeat = ? WHERE id = ?").run(now, workerId);
    return {
      runId: run.id as string,
      leaseToken,
      leaseExpiresAt,
      run: {
        projectId: run.project_id as string,
        repoUrl: run.repo_url as string,
        commitSha: run.commit_sha as string,
        scenarios: JSON.parse(run.scenarios_json as string) as string[],
      },
    };
  });
  return tx() as RunClaim | null;
}

export type CompleteRunInput = {
  workerId: string;
  leaseToken: string;
  succeeded: boolean;
  results?: ScenarioResult[];
  error?: string;
};

/** Terminal transition; idempotent for the same lease token (like jobs.ts). */
export function completeRun(db: Db, runId: string, input: CompleteRunInput): { status: RunStatus } {
  const tx = db.transaction((): { status: RunStatus } => {
    const row = rowById(db, runId);
    if (!row) {
      throw new UiIntelligenceError("NOT_FOUND", `run ${runId} not found`, { httpStatus: 404 });
    }
    const status = row.status as RunStatus;
    const now = nowIso();
    if (status === "succeeded" || status === "failed") {
      // Idempotent replay with the same lease is a no-op.
      if (row.lease_token === input.leaseToken) return { status };
      throw new UiIntelligenceError("JOB_LEASE_LOST", "lease token does not match the current lease", { httpStatus: 409 });
    }
    if (status !== "running" || row.lease_token !== input.leaseToken || row.worker_id !== input.workerId) {
      throw new UiIntelligenceError("JOB_LEASE_LOST", "lease token does not match the current lease", { httpStatus: 409 });
    }
    db.prepare("UPDATE workers SET status = 'idle' WHERE id = ? AND status = 'busy'").run(input.workerId);
    if (input.succeeded) {
      // Keep the lease token on terminal rows so a replayed complete with the
      // same lease stays idempotent.
      db.prepare("UPDATE runs SET status = 'succeeded', result_json = ?, error = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(
        JSON.stringify({ results: input.results ?? [] }),
        now,
        runId
      );
      return { status: "succeeded" };
    }
    const attempt = row.attempt as number;
    const maxAttempts = row.max_attempts as number;
    if (attempt >= maxAttempts) {
      db.prepare("UPDATE runs SET status = 'failed', error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(
        input.error ?? "unknown error",
        now,
        runId
      );
      return { status: "failed" };
    }
    // Retryable failure: back to the queue with a bounded attempt count.
    db.prepare("UPDATE runs SET status = 'queued', error = ?, worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(
      input.error ?? "unknown error",
      now,
      runId
    );
    return { status: "queued" };
  });
  return tx() as { status: RunStatus };
}

export function getWorkerStatus(db: Db, workerId: string): WorkerStatus | null {
  const row = workerRow(db, workerId);
  return row ? (row.status as WorkerStatus) : null;
}
