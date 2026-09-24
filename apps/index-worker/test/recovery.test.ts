/**
 * Job recovery fault injection (architecture sections 11, 19):
 * worker loss, lease expiry, cancellation, and bounded retries preserve
 * deduplicated publication. Runs against a real temp SQLite DB using the
 * worker's own claim path (claim SQL duplicated from apps/api by design).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Db } from "../src/db.js";
import { openWorkerDb, migrateWorker } from "../src/db.js";
import {
  claimNextJob,
  completeClaimedJob,
  createWorker,
  renewLease,
  cancelRequested,
  backoffBeforeRetry,
  JobCancelledError,
  type ClaimedJob,
} from "../src/worker.js";

const PROJECT = "proj_reference_app";

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function insertCaptureFixture(
  db: Db,
  opts: { captureId: string; observations: Array<{ id: string; anchor: string; text: string }> }
): void {
  const capturedAt = nowIso();
  db.prepare(
    "INSERT OR IGNORE INTO commits (sha, project_id, committed_at, parents_json) VALUES (?, ?, ?, '[]')"
  ).run(opts.captureId, PROJECT, capturedAt);
  db.prepare(
    "INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES (?, ?, ?, ?, 'succeeded', ?)"
  ).run(`build_${opts.captureId}`, PROJECT, opts.captureId, `digest_${opts.captureId}`, capturedAt);
  db.prepare(
    "INSERT INTO captures (id, project_id, build_id, scenario_id, commit_sha, evidence_label, manifest_json, manifest_digest, request_key, created_at) VALUES (?, ?, ?, 'recovery-scenario', ?, 'captured_at_build', '{}', ?, ?, ?)"
  ).run(opts.captureId, PROJECT, `build_${opts.captureId}`, opts.captureId, `md_${opts.captureId}`, `rk_${opts.captureId}`, capturedAt);
  for (const obs of opts.observations) {
    db.prepare(
      "INSERT INTO occurrences (id, project_id, capture_id, anchor, visible_text, bounds_json, completeness, created_at) VALUES (?, ?, ?, ?, ?, '[]', 'complete-for-scenario', ?)"
    ).run(obs.id, PROJECT, opts.captureId, obs.anchor, obs.text, capturedAt);
  }
}

function enqueue(db: Db, kind: string, payload: unknown, dedupKey?: string): string {
  const jobId = `job_${Math.random().toString(16).slice(2, 12)}`;
  db.prepare(
    "INSERT INTO jobs (id, project_id, kind, status, stage, payload_json, dedup_key, attempt, max_attempts, created_at, updated_at) VALUES (?, ?, ?, 'queued', 'indexing', ?, ?, 0, 3, ?, ?)"
  ).run(jobId, PROJECT, kind, JSON.stringify(payload), dedupKey ?? null, nowIso(), nowIso());
  return jobId;
}

function jobRow(db: Db, jobId: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown>;
}

/** Simulate a lost worker: the lease simply expires (no completion, no publish). */
function expireLease(db: Db, jobId: string): void {
  db.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?").run(nowIso(-1000), jobId);
}

describe("index-worker job recovery (fault injection)", () => {
  let db: Db;
  let cleanup: () => void;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-recovery-"));
    cleanup = () => {
      try {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    };
    db = openWorkerDb(join(dir, "recovery.sqlite"));
    migrateWorker(db);
    db.prepare(
      "INSERT OR IGNORE INTO projects (id, tenant_id, name, repository, policy_revision, created_at) VALUES (?, 'local', 'reference-app', 'repo', 1, ?)"
    ).run(PROJECT, nowIso());
    insertCaptureFixture(db, {
      captureId: "cap_rec1",
      observations: [
        { id: "o1", anchor: "product.list", text: "product list with prices" },
        { id: "o2", anchor: "product.actions", text: "buttons for products" },
      ],
    });
    insertCaptureFixture(db, {
      captureId: "cap_rec2",
      observations: [{ id: "o3", anchor: "account.form", text: "profile form fields" }],
    });
  });

  afterAll(() => {
    cleanup?.();
  });

  it("reclaims a lost worker's job after lease expiry and publishes exactly once", async () => {
    const jobId = enqueue(db, "index_capture", { captureId: "cap_rec1", projectId: PROJECT }, `index_capture:cap_rec1`);

    // Worker A claims, then crashes mid-job: no completion, no publication.
    const claimedA = claimNextJob(db, "worker-a");
    expect(claimedA?.jobId).toBe(jobId);
    expect(claimedA?.attempt).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM search_index WHERE capture_id = 'cap_rec1'").get() as { n: number }).n
    ).toBe(0);

    // Worker B cannot steal the job while the lease is active.
    const workerB = createWorker(db, { intervalMs: 1 });
    expect(await workerB.runOnce()).toBe(false);

    // Lease expires; worker B re-claims (attempt 2), processes, and succeeds.
    expireLease(db, jobId);
    expect(await workerB.runOnce()).toBe(true);

    const row = jobRow(db, jobId);
    expect(row.status).toBe("succeeded");
    expect(row.attempt).toBe(2);
    // Deduplicated publication: 2 occurrences -> exactly 2 search_index rows,
    // regardless of the crashed first attempt.
    const indexed = db.prepare("SELECT anchor, text FROM search_index WHERE capture_id = 'cap_rec1'").all() as Array<
      Record<string, unknown>
    >;
    expect(indexed).toHaveLength(2);
    expect(new Set(indexed.map((r) => r.anchor)).size).toBe(2);
  });

  it("preserves deduplicated publication across repeated worker-loss cycles", async () => {
    const jobId = enqueue(db, "index_capture", { captureId: "cap_rec2", projectId: PROJECT }, `index_capture:cap_rec2`);

    // Two full crash cycles (attempts 1 and 2) before a successful attempt 3.
    expect(claimNextJob(db, "worker-a")?.attempt).toBe(1);
    expireLease(db, jobId);
    expect(claimNextJob(db, "worker-b")?.attempt).toBe(2);
    expireLease(db, jobId);

    const worker = createWorker(db, { intervalMs: 1 });
    expect(await worker.runOnce()).toBe(true);
    const row = jobRow(db, jobId);
    expect(row.status).toBe("succeeded");
    expect(row.attempt).toBe(3);
    const indexed = db.prepare("SELECT anchor FROM search_index WHERE capture_id = 'cap_rec2'").all();
    expect(indexed).toHaveLength(1); // single occurrence -> published exactly once
  });

  it("a stale worker's finalize is rejected: only the current lease token can complete", () => {
    const jobId = enqueue(db, "index_capture", { captureId: "cap_rec2", projectId: PROJECT });

    const stale = claimNextJob(db, "worker-a")!;
    expireLease(db, jobId);
    const current = claimNextJob(db, "worker-b")!;
    expect(current.leaseToken).not.toBe(stale.leaseToken);

    // Stale completion with the old token must not finalize the job.
    completeClaimedJob(db, stale, { succeeded: true });
    expect(jobRow(db, jobId).status).toBe("running");

    // Current token finalizes.
    completeClaimedJob(db, current, { succeeded: true });
    expect(jobRow(db, jobId).status).toBe("succeeded");
  });

  it("heartbeat renews the lease; a stale heartbeat (wrong token) is rejected", async () => {
    const jobId = enqueue(db, "index_capture", { captureId: "cap_rec1", projectId: PROJECT });
    const claimed = claimNextJob(db, "worker-a")!;
    const before = jobRow(db, jobId).lease_expires_at as string;

    // Correct token extends the lease.
    await new Promise((resolve) => setTimeout(resolve, 15));
    renewLease(db, jobId, claimed.leaseToken);
    const after = jobRow(db, jobId).lease_expires_at as string;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));

    // Wrong token is rejected: the lease is left untouched (worker-side
    // contract; the API surfaces the same case as 409 JOB_LEASE_LOST).
    renewLease(db, jobId, "lease_wrong_token");
    expect(jobRow(db, jobId).lease_expires_at).toBe(after);

    completeClaimedJob(db, claimed, { succeeded: true });
    expect(jobRow(db, jobId).status).toBe("succeeded");
  });

  it("cancels queued work before it runs: no publication side-effect", async () => {
    const jobId = enqueue(db, "index_capture", { captureId: "cap_rec1", projectId: PROJECT });
    db.prepare("UPDATE jobs SET cancel_requested = 1 WHERE id = ?").run(jobId);
    expect(cancelRequested(db, jobId)).toBe(true);

    const worker = createWorker(db, { intervalMs: 1 });
    expect(await worker.runOnce()).toBe(false); // nothing claimable

    const row = jobRow(db, jobId);
    expect(row.status).toBe("cancelled");
    expect(row.finished_at).not.toBeNull();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM search_index WHERE capture_id = 'cap_rec1'").get() as { n: number }).n
    ).toBe(2); // only the earlier test's publication; this job published nothing new
    const before = (db.prepare("SELECT COUNT(*) AS n FROM search_index").get() as { n: number }).n;
    expect(await worker.runOnce()).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM search_index").get() as { n: number }).n).toBe(before);
  });

  it("signals active work: a cancellation checkpoint aborts the running job", async () => {
    let publications = 0;
    const jobId = enqueue(db, "index_capture", { captureId: "cap_rec2", projectId: PROJECT });
    const worker = createWorker(db, {
      intervalMs: 1,
      handlers: {
        index_capture: async (job: ClaimedJob) => {
          // The API's cancel path sets cancel_requested while the job runs.
          db.prepare("UPDATE jobs SET cancel_requested = 1 WHERE id = ?").run(job.jobId);
          // Handler checkpoint (termination deadline): observe and abort.
          if (cancelRequested(db, job.jobId)) throw new JobCancelledError(job.jobId);
          publications += 1;
        },
      },
    });
    await worker.runOnce();
    const row = jobRow(db, jobId);
    expect(row.status).toBe("cancelled");
    expect(publications).toBe(0);
  });

  it("retries with bounded backoff and succeeds on attempt 3 with a single publication", async () => {
    let calls = 0;
    const jobId = enqueue(db, "embedding", {});
    const worker = createWorker(db, {
      intervalMs: 1,
      handlers: {
        embedding: async () => {
          calls += 1;
          if (calls < 3) throw new Error(`transient failure ${calls}`);
          // Publication side-effect, guarded so retries cannot duplicate it.
          const existing = db.prepare("SELECT anchor FROM search_index WHERE capture_id = 'cap_rec1' AND anchor = 'retry.marker'").get();
          if (!existing) {
            db.prepare("INSERT INTO search_index (capture_id, project_id, anchor, text) VALUES ('cap_rec1', ?, 'retry.marker', 'published once')").run(PROJECT);
          }
        },
      },
    });

    // Backoff schedule is bounded and grows per attempt (protocol backoffMs).
    expect(backoffBeforeRetry(1)).toBe(250);
    expect(backoffBeforeRetry(2)).toBe(500);
    expect(backoffBeforeRetry(8)).toBe(30_000);

    const t1 = Date.now();
    await worker.runOnce(); // attempt 1 fails -> queued after >= 250ms backoff
    expect(Date.now() - t1).toBeGreaterThanOrEqual(240);
    expect(jobRow(db, jobId).status).toBe("queued");
    expect(jobRow(db, jobId).attempt).toBe(1);

    const t2 = Date.now();
    await worker.runOnce(); // attempt 2 fails -> queued after >= 500ms backoff
    expect(Date.now() - t2).toBeGreaterThanOrEqual(490);
    expect(jobRow(db, jobId).status).toBe("queued");
    expect(jobRow(db, jobId).attempt).toBe(2);

    await worker.runOnce(); // attempt 3 succeeds
    const row = jobRow(db, jobId);
    expect(row.status).toBe("succeeded");
    expect(row.attempt).toBe(3);
    expect(calls).toBe(3);
    const markers = db.prepare("SELECT anchor FROM search_index WHERE capture_id = 'cap_rec1' AND anchor = 'retry.marker'").all();
    expect(markers).toHaveLength(1);
  });
});
