/**
 * Durable job queue with leases (spec section 11). SQLite-backed; usable from
 * both the API service and (with duplicated claim SQL in index-worker, since
 * cross-app imports are not allowed) the worker process.
 *
 * Claim: short transaction — assign lease token + expiry, release the
 * transaction before doing work. Only the current token can finalize.
 * Delivery is at least once.
 */
import { newId, backoffMs, UiIntelligenceError, type JobKind, type JobRecord, type JobStage, type LeaseClaim } from "@ui-intelligence/protocol";
import type { Db } from "./db.js";
import { nowIso } from "./db.js";
import { jobRecordFromRow } from "./store.js";

const LEASE_MS = 30_000;

export type EnqueueOptions = {
  projectId: string;
  kind: JobKind;
  payload: unknown;
  dedupKey?: string;
  maxAttempts?: number;
  stage?: JobStage;
};

export function enqueueJob(db: Db, options: EnqueueOptions): string {
  if (options.dedupKey) {
    const existing = db
      .prepare("SELECT id FROM jobs WHERE project_id = ? AND dedup_key = ? AND status IN ('queued','running')")
      .get(options.projectId, options.dedupKey) as { id: string } | undefined;
    if (existing) return existing.id;
  }
  const jobId = newId("job");
  const now = nowIso();
  db.prepare(
    "INSERT INTO jobs (id, project_id, kind, status, stage, payload_json, dedup_key, attempt, max_attempts, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?)"
  ).run(
    jobId,
    options.projectId,
    options.kind,
    options.stage ?? "planning",
    JSON.stringify(options.payload),
    options.dedupKey ?? null,
    options.maxAttempts ?? 3,
    now,
    now
  );
  return jobId;
}

export function insertOutbox(db: Db, projectId: string, jobId: string): void {
  db.prepare("INSERT INTO outbox (id, project_id, job_id, created_at) VALUES (?, ?, ?, ?)").run(
    newId("outbox"),
    projectId,
    jobId,
    nowIso()
  );
}

export function markOutboxProcessed(db: Db, jobId: string): void {
  db.prepare("UPDATE outbox SET processed_at = ? WHERE job_id = ?").run(nowIso(), jobId);
}

function rowOrNull(db: Db, projectId: string, jobId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM jobs WHERE project_id = ? AND id = ?").get(projectId, jobId) as
    | Record<string, unknown>
    | undefined;
}

/** Claim a specific job: only queued or lease-expired running jobs. */
export function claimJob(db: Db, projectId: string, jobId: string, workerId: string): LeaseClaim {
  const tx = db.transaction(() => {
    const row = rowOrNull(db, projectId, jobId);
    if (!row) {
      throw new UiIntelligenceError("NOT_FOUND", `job ${jobId} not found`, { httpStatus: 404 });
    }
    const status = row.status as string;
    const leaseValid = status === "running" && row.lease_expires_at !== null && (row.lease_expires_at as string) > nowIso();
    if (leaseValid) {
      throw new UiIntelligenceError("STALE_REVISION", "job is running under an active lease", { httpStatus: 409 });
    }
    if (status === "succeeded" || status === "failed" || status === "cancelled") {
      throw new UiIntelligenceError("STALE_REVISION", `job is already ${status}`, { httpStatus: 409 });
    }
    const leaseToken = newId("lease");
    const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
    const attempt = (row.attempt as number) + 1;
    db.prepare(
      "UPDATE jobs SET status = 'running', lease_token = ?, lease_expires_at = ?, attempt = ?, updated_at = ? WHERE id = ?"
    ).run(leaseToken, leaseExpiresAt, attempt, nowIso(), jobId);
    return { jobId, leaseToken, leaseExpiresAt, workerId } satisfies LeaseClaim & { workerId: string };
  });
  return tx() as LeaseClaim;
}

export function heartbeatJob(db: Db, projectId: string, jobId: string, leaseToken: string): LeaseClaim {
  const row = rowOrNull(db, projectId, jobId);
  if (!row) throw new UiIntelligenceError("NOT_FOUND", `job ${jobId} not found`, { httpStatus: 404 });
  if (row.status !== "running" || row.lease_token !== leaseToken) {
    throw new UiIntelligenceError("JOB_LEASE_LOST", "lease token does not match the current lease", { httpStatus: 409 });
  }
  // An expired lease may already have been reclaimed by another worker; a
  // stale worker cannot heartbeat its way back to a valid lease.
  if ((row.lease_expires_at as string) < nowIso()) {
    throw new UiIntelligenceError("JOB_LEASE_LOST", "lease expired; the job may have been reclaimed", { httpStatus: 409 });
  }
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
  db.prepare("UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ?").run(leaseExpiresAt, nowIso(), jobId);
  return { jobId, leaseToken, leaseExpiresAt };
}

export type CompleteInput = {
  succeeded: boolean;
  result?: unknown;
  error?: string;
  stage?: JobStage;
};

/** Terminal transition; idempotent for the same lease token. */
export function completeJob(db: Db, projectId: string, jobId: string, leaseToken: string, input: CompleteInput): void {
  const tx = db.transaction(() => {
    const row = rowOrNull(db, projectId, jobId);
    if (!row) throw new UiIntelligenceError("NOT_FOUND", `job ${jobId} not found`, { httpStatus: 404 });
    const status = row.status as string;
    const terminal = status === "succeeded" || status === "failed" || status === "cancelled";
    if (terminal) {
      // Idempotent replay with the same lease is a no-op.
      if (row.lease_token === leaseToken) return;
      throw new UiIntelligenceError("JOB_LEASE_LOST", "lease token does not match the current lease", { httpStatus: 409 });
    }
    if (row.status !== "running" || row.lease_token !== leaseToken) {
      throw new UiIntelligenceError("JOB_LEASE_LOST", "lease token does not match the current lease", { httpStatus: 409 });
    }
    if (input.succeeded) {
      // Keep the lease token on terminal rows so a replayed complete with the
      // same lease stays idempotent (claims reject terminal jobs by status).
      db.prepare("UPDATE jobs SET status = 'succeeded', stage = ?, lease_expires_at = NULL, updated_at = ?, finished_at = ? WHERE id = ?").run(
        input.stage ?? "done",
        nowIso(),
        nowIso(),
        jobId
      );
    } else {
      const attempt = row.attempt as number;
      const maxAttempts = row.max_attempts as number;
      if (attempt >= maxAttempts) {
        db.prepare("UPDATE jobs SET status = 'failed', last_error = ?, lease_expires_at = NULL, updated_at = ?, finished_at = ? WHERE id = ?").run(
          input.error ?? "unknown error",
          nowIso(),
          nowIso(),
          jobId
        );
      } else {
        // Retryable failure: return to the queue with bounded attempts.
        db.prepare("UPDATE jobs SET status = 'queued', stage = 'planning', last_error = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(
          input.error ?? "unknown error",
          nowIso(),
          jobId
        );
      }
    }
  });
  tx();
}

/** Record a failure from a worker that still holds the lease. */
export function failJob(db: Db, projectId: string, jobId: string, leaseToken: string, errorMessage: string): void {
  completeJob(db, projectId, jobId, leaseToken, { succeeded: false, error: errorMessage });
}

/** Backoff before the next retry attempt (protocol backoffMs). */
export function retryDelayMs(attempt: number): number {
  return backoffMs(attempt);
}

export function cancelJob(db: Db, projectId: string, jobId: string): JobRecord {
  const tx = db.transaction(() => {
    const row = rowOrNull(db, projectId, jobId);
    if (!row) throw new UiIntelligenceError("NOT_FOUND", `job ${jobId} not found`, { httpStatus: 404 });
    const status = row.status as string;
    if (status === "queued") {
      db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?").run(
        nowIso(),
        nowIso(),
        jobId
      );
    } else if (status === "running") {
      // Signal active work; the worker honors it at its next checkpoint.
      db.prepare("UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?").run(nowIso(), jobId);
    } else if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
      throw new UiIntelligenceError("STALE_REVISION", `cannot cancel job in status ${status}`, { httpStatus: 409 });
    }
  });
  tx();
  const row = rowOrNull(db, projectId, jobId)!;
  return jobRecordFromRow(row);
}

export function isCancelRequested(db: Db, jobId: string): boolean {
  const row = db.prepare("SELECT cancel_requested FROM jobs WHERE id = ?").get(jobId) as
    | { cancel_requested: number }
    | undefined;
  return row?.cancel_requested === 1;
}
