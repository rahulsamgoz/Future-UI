/**
 * history_scan reconstruction (audit P1: "historical reconstruction remains
 * unimplemented in the scan path"). When the scan carries a fixtureRepo, the
 * selected commits are RECONSTRUCTED through the real capture path: captures
 * are durably published and recorded, re-runs deduplicate
 * (extend-without-duplicating), an intentionally unbuildable commit yields
 * per-scenario EXPECTED failures, and the job payload carries per-commit
 * outcomes. The reconstruction executor itself is injected here (the real
 * executor is exercised by the gated E2E and the coverage regeneration).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { openWorkerDb, migrateWorker } from "../src/db.js";
import { createWorker } from "../src/worker.js";

const PROJECT = "proj_history_reconstruction";

function nowIso(): string {
  return new Date().toISOString();
}

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "ui-intel-history-recon-"));
  const db = openWorkerDb(join(dir, "worker.sqlite"));
  migrateWorker(db);
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, tenant_id, name, repository, policy_revision, created_at) VALUES (?, 'local', 'history-reconstruction', 'repo', 1, ?)"
  ).run(PROJECT, nowIso());
  return db;
}

function insertPlan(db: Db, planId: string, selectedCommits: string[], inputJson = "{}"): void {
  db.prepare(
    "INSERT INTO history_plans (id, project_id, input_json, resolved_tips_json, selected_commits_json, status, created_at) VALUES (?, ?, ?, '[]', ?, 'planned', ?)"
  ).run(planId, PROJECT, inputJson, JSON.stringify(selectedCommits.map((commitSha) => ({ commitSha }))), nowIso());
}

function enqueueHistoryScan(db: Db, planId: string): string {
  const jobId = `job_${Math.random().toString(16).slice(2, 12)}`;
  db.prepare(
    "INSERT INTO jobs (id, project_id, kind, status, stage, payload_json, dedup_key, attempt, max_attempts, created_at, updated_at) VALUES (?, ?, 'history_scan', 'queued', 'planning', ?, NULL, 0, 3, ?, ?)"
  ).run(jobId, PROJECT, JSON.stringify({ planId, projectId: PROJECT }), nowIso(), nowIso());
  return jobId;
}

const SCENARIO_IDS = [
  "catalog-default-desktop",
  "catalog-empty-desktop",
  "catalog-loading-desktop",
  "catalog-default-mobile",
  "account-default-desktop",
  "account-error-desktop",
];

describe("history_scan with fixtureRepo performs reconstruction", () => {
  afterAll(() => {
    // Databases are temp-file backed; vitest cleans the tmpdir eventually.
  });

  it("reconstructs 2 commits, records captures + per-commit outcomes, and deduplicates on re-run", async () => {
    const db = freshDb();
    insertPlan(db, "plan_recon", ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
    const reconstruct = vi.fn(async (args: { commitSha: string; scenarios: string[] }) => ({
      commitSha: args.commitSha,
      buildArtifactDigest: `digest_${args.commitSha.slice(0, 4)}`,
      intentionallyUnbuildable: false,
      scenarios: args.scenarios.map((scenarioId, i) => ({
        scenarioId,
        outcome: "captured" as const,
        captureId: `capture_${args.commitSha.slice(0, 4)}_${i}`,
        artifactId: `artifact_${args.commitSha.slice(0, 4)}_${i}`,
        sha256: `sha_${args.commitSha.slice(0, 4)}_${i}`,
        occurrenceCount: 5,
      })),
    }));

    const worker = createWorker(db, {
      workerId: "w-recon",
      historyScan: {
        fixtureRepo: "/tmp/fixture-corpus",
        api: { baseUrl: "http://history-api.local", token: "test-token", projectId: PROJECT },
        reconstruct: reconstruct as unknown as (args: {
          repoDir: string;
          commitSha: string;
          scenarios: string[];
          api: { baseUrl: string; token: string; projectId: string };
        }) => Promise<unknown>,
      },
    });

    // First run: reconstructs both commits.
    const jobId = enqueueHistoryScan(db, "plan_recon");
    expect(await worker.runOnce()).toBe(true);

    expect(reconstruct).toHaveBeenCalledTimes(2);
    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown>;
    expect(row.status).toBe("succeeded");
    const payload = JSON.parse(row.payload_json as string) as {
      result?: { captured?: number; commits?: Array<Record<string, unknown>> };
    };
    expect(payload.result?.captured).toBe(2);
    expect(payload.result?.commits).toHaveLength(2);
    for (const commit of payload.result?.commits ?? []) {
      expect(commit.outcome).toBe("captured");
      expect((commit.captures as string[]).length).toBeGreaterThanOrEqual(0);
    }

    // Captures recorded for both commits, one per scenario, plus index_capture jobs.
    const captureRows = db
      .prepare("SELECT id, commit_sha, scenario_id FROM captures WHERE project_id = ? ORDER BY id")
      .all(PROJECT) as Array<{ id: string; commit_sha: string; scenario_id: string }>;
    // 2 commits x 12 standard scenario recipes (6 named scenarios x 2 viewports).
    expect(captureRows).toHaveLength(24);
    expect(new Set(captureRows.map((c) => c.commit_sha)).size).toBe(2);
    const indexJobs = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'index_capture'")
      .get() as { n: number };
    expect(indexJobs.n).toBe(24);

    // Second run: everything already captured — no new reconstruction, no duplicates.
    const reconstructCallsAfterFirstRun = reconstruct.mock.calls.length;
    const jobId2 = enqueueHistoryScan(db, "plan_recon");
    // The queue holds the index_capture jobs from the first run; drain until
    // the second history_scan job reaches a terminal state.
    for (let processed = 0; processed < 40; processed += 1) {
      if ((db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId2) as { status: string }).status !== "queued") break;
      await worker.runOnce();
    }
    expect(reconstruct.mock.calls.length).toBe(reconstructCallsAfterFirstRun);
    const row2 = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId2) as Record<string, unknown>;
    expect(row2.status).toBe("succeeded");
    const payload2 = JSON.parse(row2.payload_json as string) as {
      result?: { captured?: number; commits?: Array<Record<string, unknown>> };
    };
    expect(payload2.result?.captured).toBe(2); // extended without duplicating
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM captures WHERE project_id = ?").get(PROJECT) as { n: number }).n
    ).toBe(24);
    db.close();
  });

  it("records an intentionally unbuildable commit as expected_failure and still succeeds", async () => {
    const db = freshDb();
    insertPlan(db, "plan_unbuildable", ["cccccccccccccccccccccccccccccccccccccccc"]);
    const worker = createWorker(db, {
      workerId: "w-recon-unbuildable",
      historyScan: {
        fixtureRepo: "/tmp/fixture-corpus",
        api: { baseUrl: "http://history-api.local", token: "test-token", projectId: PROJECT },
        reconstruct: async (args: { commitSha: string; scenarios: string[] }) => ({
          commitSha: args.commitSha,
          buildArtifactDigest: "digest_unbuildable",
          intentionallyUnbuildable: true,
          scenarios: args.scenarios.map((scenarioId) => ({
            scenarioId,
            outcome: "expected_failure" as const,
            error: "app.js throws on load (INTENTIONALLY_UNBUILDABLE): readiness never satisfied",
          })),
        }),
      },
    });

    const jobId = enqueueHistoryScan(db, "plan_unbuildable");
    expect(await worker.runOnce()).toBe(true);

    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown>;
    // Expected failures are recorded as such — the job is NOT failed.
    expect(row.status).toBe("succeeded");
    const payload = JSON.parse(row.payload_json as string) as {
      result?: { expectedFailures?: number; commits?: Array<Record<string, unknown>> };
    };
    expect(payload.result?.expectedFailures).toBe(1);
    expect(payload.result?.commits?.[0]?.outcome).toBe("expected_failure");
    // No captures were faked for the unbuildable commit.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM captures WHERE project_id = ?").get(PROJECT) as { n: number }).n
    ).toBe(0);
    db.close();
  });

  it("fails the job (with per-commit outcomes recorded) when a scenario unexpectedly fails", async () => {
    const db = freshDb();
    insertPlan(db, "plan_failure", ["dddddddddddddddddddddddddddddddddddddddd"]);
    const worker = createWorker(db, {
      workerId: "w-recon-failure",
      historyScan: {
        fixtureRepo: "/tmp/fixture-corpus",
        api: { baseUrl: "http://history-api.local", token: "test-token", projectId: PROJECT },
        reconstruct: async (args: { commitSha: string; scenarios: string[] }) => ({
          commitSha: args.commitSha,
          buildArtifactDigest: "digest_failure",
          intentionallyUnbuildable: false,
          scenarios: args.scenarios.map((scenarioId) => ({
            scenarioId,
            outcome: "failed" as const,
            error: "git worktree add failed: commit not found",
          })),
        }),
      },
    });

    const jobId = enqueueHistoryScan(db, "plan_failure");
    expect(await worker.runOnce()).toBe(true);

    // Unexpected failures are NOT successes: the job goes back to the queue
    // (bounded retry) with the error recorded and per-commit outcomes kept.
    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown>;
    expect(row.status).toBe("queued");
    expect(row.last_error).toContain("history scan reconstruction failed");
    const payload = JSON.parse(row.payload_json as string) as {
      result?: { commits?: Array<Record<string, unknown>> };
    };
    expect(payload.result?.commits?.[0]?.outcome).toBe("failed");
    expect(payload.result?.commits?.[0]?.error).toContain("git worktree add failed");
    // No captures were faked for the failed commit.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM captures WHERE project_id = ?").get(PROJECT) as { n: number }).n
    ).toBe(0);
    db.close();
  });

  it("accepts fixtureRepo from the plan input when the payload does not carry it", async () => {
    const db = freshDb();
    insertPlan(db, "plan_input", ["eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"], JSON.stringify({ fixtureRepo: "/tmp/fixture-corpus" }));
    const reconstruct = vi.fn(async (args: { commitSha: string; scenarios: string[] }) => ({
      commitSha: args.commitSha,
      buildArtifactDigest: "digest_input",
      intentionallyUnbuildable: false,
      scenarios: args.scenarios.map((scenarioId) => ({
        scenarioId,
        outcome: "captured" as const,
        captureId: `capture_input_${scenarioId}`,
        artifactId: `artifact_${scenarioId}`,
        occurrenceCount: 3,
      })),
    }));
    const worker = createWorker(db, {
      workerId: "w-recon-input",
      historyScan: {
        api: { baseUrl: "http://history-api.local", token: "test-token", projectId: PROJECT },
        reconstruct: reconstruct as unknown as (args: {
          repoDir: string;
          commitSha: string;
          scenarios: string[];
          api: { baseUrl: string; token: string; projectId: string };
        }) => Promise<unknown>,
      },
    });

    const jobId = enqueueHistoryScan(db, "plan_input");
    expect(await worker.runOnce()).toBe(true);
    expect(reconstruct).toHaveBeenCalledTimes(1);
    expect(reconstruct.mock.calls[0]?.[0]).toMatchObject({ repoDir: "/tmp/fixture-corpus" });
    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown>;
    expect(row.status).toBe("succeeded");
    db.close();
  });

  it("REPRO GAP A: respects the plan's selected scenarioIds and passes only those to reconstruct", async () => {
    const db = freshDb();
    // Plan selects ONLY catalog-default-desktop
    insertPlan(
      db,
      "plan_one_scenario",
      ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      JSON.stringify({ fixtureRepo: "/tmp/fixture-corpus", scenarioIds: ["catalog-default-desktop"] }),
    );
    const reconstruct = vi.fn(async (args: { commitSha: string; scenarios: string[] }) => ({
      commitSha: args.commitSha,
      buildArtifactDigest: "digest_one",
      intentionallyUnbuildable: false,
      scenarios: args.scenarios.map((scenarioId) => ({
        scenarioId,
        outcome: "captured" as const,
        captureId: `capture_one_${scenarioId}`,
        artifactId: `artifact_one_${scenarioId}`,
        occurrenceCount: 3,
      })),
    }));
    const worker = createWorker(db, {
      workerId: "w-recon-one",
      historyScan: {
        fixtureRepo: "/tmp/fixture-corpus",
        api: { baseUrl: "http://history-api.local", token: "test-token", projectId: PROJECT },
        reconstruct: reconstruct as unknown as (args: {
          repoDir: string;
          commitSha: string;
          scenarios: string[];
          api: { baseUrl: string; token: string; projectId: string };
        }) => Promise<unknown>,
      },
    });

    const jobId = enqueueHistoryScan(db, "plan_one_scenario");
    expect(await worker.runOnce()).toBe(true);

    expect(reconstruct).toHaveBeenCalledTimes(1);
    const callArgs = reconstruct.mock.calls[0]?.[0] as { scenarios: string[] };
    // GAP A REPRO: the worker currently sends ALL 12 scenarios regardless of the plan selection.
    // After the fix this should be exactly ["catalog-default-desktop"].
    expect(callArgs.scenarios).toEqual(["catalog-default-desktop"]);

    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown>;
    expect(row.status).toBe("succeeded");
    const payload = JSON.parse(row.payload_json as string) as {
      result?: { captured?: number; commits?: Array<Record<string, unknown>> };
    };
    expect(payload.result?.captured).toBe(1);
    db.close();
  });

  it("plan-scoped accounting: existing captures outside the selected scenario set are not reported (closure-2 review)", async () => {
    const db = freshDb();
    const COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    // The commit already has captures for TWO scenarios; the plan selects ONE.
    db.prepare(
      "INSERT INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES ('b', ?, ?, 'd', 'succeeded', ?)"
    ).run(PROJECT, COMMIT, nowIso());
    const insertCapture = db.prepare(
      "INSERT INTO captures (id, project_id, build_id, scenario_id, commit_sha, evidence_label, manifest_json, manifest_digest, request_key, created_at) VALUES (?, ?, 'b', ?, ?, 'captured_at_build', '{}', 'd', ?, ?)"
    );
    insertCapture.run("cap_selected", PROJECT, "catalog-default-desktop", COMMIT, "k1", nowIso());
    insertCapture.run("cap_unrelated", PROJECT, "catalog-empty-desktop", COMMIT, "k2", nowIso());
    insertPlan(
      db,
      "plan_subset_accounting",
      [COMMIT],
      JSON.stringify({ fixtureRepo: "/tmp/fixture-corpus", scenarioIds: ["catalog-default-desktop"] }),
    );
    const reconstruct = vi.fn();
    const worker = createWorker(db, {
      workerId: "w-recon-accounting",
      historyScan: {
        fixtureRepo: "/tmp/fixture-corpus",
        api: { baseUrl: "http://history-api.local", token: "test-token", projectId: PROJECT },
        reconstruct: reconstruct as unknown as (args: { repoDir: string; commitSha: string; scenarios: string[] }) => Promise<unknown>,
      },
    });

    const jobId = enqueueHistoryScan(db, "plan_subset_accounting");
    expect(await worker.runOnce()).toBe(true);

    // Nothing to reconstruct (the selected scenario is already captured)…
    expect(reconstruct).not.toHaveBeenCalled();
    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown>;
    expect(row.status).toBe("succeeded");
    const payload = JSON.parse(row.payload_json as string) as {
      result?: { captured?: number; commits?: Array<{ captures?: string[]; outcome?: string }> };
    };
    // …and the outcome reports ONLY the selected scenario's capture — the
    // unrelated pre-existing capture must not inflate the plan's accounting.
    expect(payload.result?.commits?.[0]?.captures).toEqual(["cap_selected"]);
    expect(payload.result?.commits?.[0]?.outcome).toBe("captured");
    db.close();
  });
});
