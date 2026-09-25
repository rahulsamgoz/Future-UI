/**
 * Worker honesty for history_scan jobs (audit defect 3): a scan whose selected
 * commits have no captures (dev profile: no historical reconstruction) must
 * NOT report a plain success. The job is finalized "completed_with_gaps" with
 * a result summary in its payload; scans with existing captures record the
 * indexed count and succeed normally.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { openWorkerDb, migrateWorker } from "../src/db.js";
import { createWorker, HISTORY_SCAN_RECONSTRUCTION_NOTE, type ClaimedJob } from "../src/worker.js";

const PROJECT = "proj_history_honesty";

function nowIso(): string {
  return new Date().toISOString();
}

function insertCaptureFixture(
  db: Db,
  opts: { captureId: string; commitSha: string; scenarioId: string; capturedAt: string }
): void {
  db.prepare(
    "INSERT OR IGNORE INTO commits (sha, project_id, committed_at, parents_json) VALUES (?, ?, ?, '[]')"
  ).run(opts.commitSha, PROJECT, opts.capturedAt);
  db.prepare(
    "INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES (?, ?, ?, ?, 'succeeded', ?)"
  ).run(`build_${opts.commitSha}`, PROJECT, opts.commitSha, `digest_${opts.commitSha}`, opts.capturedAt);
  db.prepare(
    "INSERT INTO captures (id, project_id, build_id, scenario_id, commit_sha, evidence_label, manifest_json, manifest_digest, request_key, created_at) VALUES (?, ?, ?, ?, ?, 'captured_at_build', '{}', ?, ?, ?)"
  ).run(opts.captureId, PROJECT, `build_${opts.commitSha}`, opts.scenarioId, opts.commitSha, `md_${opts.captureId}`, `rk_${opts.captureId}`, opts.capturedAt);
}

function insertPlan(db: Db, planId: string, selectedCommits: string[]): void {
  db.prepare(
    "INSERT INTO history_plans (id, project_id, input_json, resolved_tips_json, selected_commits_json, status, created_at) VALUES (?, ?, '{}', '[]', ?, 'planned', ?)"
  ).run(planId, PROJECT, JSON.stringify(selectedCommits.map((commitSha) => ({ commitSha }))), nowIso());
}

function enqueueHistoryScan(db: Db, planId: string): string {
  const jobId = `job_${Math.random().toString(16).slice(2, 12)}`;
  db.prepare(
    "INSERT INTO jobs (id, project_id, kind, status, stage, payload_json, dedup_key, attempt, max_attempts, created_at, updated_at) VALUES (?, ?, 'history_scan', 'queued', 'planning', ?, NULL, 0, 3, ?, ?)"
  ).run(jobId, PROJECT, JSON.stringify({ planId, projectId: PROJECT }), nowIso(), nowIso());
  return jobId;
}

function jobRow(db: Db, jobId: string): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown> | undefined;
  expect(row, `job ${jobId} not found`).toBeDefined();
  return row!;
}

function planStatus(db: Db, planId: string): string {
  return (db.prepare("SELECT status FROM history_plans WHERE id = ?").get(planId) as { status: string }).status;
}

describe("history_scan worker honesty", () => {
  const dirs: string[] = [];
  const dbs: Db[] = [];
  afterAll(() => {
    for (const db of dbs) {
      try {
        db.close();
      } catch {
        // best effort
      }
    }
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  function freshDb(): Db {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-history-"));
    dirs.push(dir);
    const db = openWorkerDb(join(dir, "worker.sqlite"));
    migrateWorker(db);
    dbs.push(db);
    db.prepare(
      "INSERT OR IGNORE INTO projects (id, tenant_id, name, repository, policy_revision, created_at) VALUES (?, 'local', 'history-honesty', 'repo', 1, ?)"
    ).run(PROJECT, nowIso());
    return db;
  }

  it("marks an empty-history scan completed_with_gaps with an honest note", async () => {
    const db = freshDb();
    insertPlan(db, "plan_empty", ["0000000000000000000000000000000000000001"]);
    const jobId = enqueueHistoryScan(db, "plan_empty");

    const processed = await createWorker(db, { workerId: "w-empty" }).runOnce();
    expect(processed).toBe(true);

    const row = jobRow(db, jobId);
    expect(row.status).toBe("completed_with_gaps");
    expect(row.finished_at).not.toBeNull();
    const payload = JSON.parse(row.payload_json as string) as {
      planId?: string;
      result?: Record<string, unknown>;
    };
    expect(payload.planId).toBe("plan_empty");
    expect(payload.result).toMatchObject({
      planId: "plan_empty",
      selectedCommits: 1,
      reconstructed: 0,
      indexedCaptures: 0,
      note: HISTORY_SCAN_RECONSTRUCTION_NOTE,
    });
    // The plan itself completed; the gap lives in the job record.
    expect(planStatus(db, "plan_empty")).toBe("completed");
    // Nothing was published for the gapped commit.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'index_capture'").get() as { n: number }).n
    ).toBe(0);
  });

  it("records the indexed count when captures already exist", async () => {
    const db = freshDb();
    insertCaptureFixture(db, {
      captureId: "cap_hist_1",
      commitSha: "c1",
      scenarioId: "catalog-desktop",
      capturedAt: "2026-01-01T00:00:00.000Z",
    });
    insertPlan(db, "plan_with_captures", ["c1"]);
    const jobId = enqueueHistoryScan(db, "plan_with_captures");

    const processed = await createWorker(db, { workerId: "w-captures" }).runOnce();
    expect(processed).toBe(true);

    const row = jobRow(db, jobId);
    expect(row.status).toBe("succeeded");
    const payload = JSON.parse(row.payload_json as string) as { result?: Record<string, unknown> };
    expect(payload.result).toEqual({
      planId: "plan_with_captures",
      selectedCommits: 1,
      reconstructed: 0,
      indexedCaptures: 1,
    });
    expect(planStatus(db, "plan_with_captures")).toBe("completed");
    // An index_capture job was enqueued for the existing capture.
    const indexJob = db
      .prepare("SELECT payload_json, status FROM jobs WHERE kind = 'index_capture' AND project_id = ?")
      .get(PROJECT) as { payload_json: string; status: string };
    expect(JSON.parse(indexJob.payload_json)).toMatchObject({ captureId: "cap_hist_1", projectId: PROJECT });
    expect(indexJob.status).toBe("queued");
  });

  it("treats completed_with_gaps as terminal: the job is processed exactly once", async () => {
    const db = freshDb();
    insertPlan(db, "plan_gap_terminal", ["0000000000000000000000000000000000000002"]);
    const jobId = enqueueHistoryScan(db, "plan_gap_terminal");
    const worker = createWorker(db, { workerId: "w-terminal" });

    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);

    const row = jobRow(db, jobId);
    expect(row.status).toBe("completed_with_gaps");
    expect(row.attempt).toBe(1);
  });
});

// Type-level guard: ClaimedJob stays importable for handler tests.
export type { ClaimedJob };
