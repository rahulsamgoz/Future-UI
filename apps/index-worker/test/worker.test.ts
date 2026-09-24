import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Db } from "../src/db.js";
import { openWorkerDb, migrateWorker } from "../src/db.js";
import { claimNextJob, completeClaimedJob, createWorker, type ClaimedJob } from "../src/worker.js";

const PROJECT = "proj_reference_app";

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function insertCaptureFixture(db: Db, opts: { captureId: string; commitSha: string; scenarioId: string; capturedAt: string; observations: Array<{ id: string; anchor: string; text: string }> }): void {
  db.prepare(
    "INSERT OR IGNORE INTO commits (sha, project_id, committed_at, parents_json) VALUES (?, ?, ?, '[]')"
  ).run(opts.commitSha, PROJECT, opts.capturedAt);
  db.prepare(
    "INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES (?, ?, ?, ?, 'succeeded', ?)"
  ).run(`build_${opts.commitSha}`, PROJECT, opts.commitSha, `digest_${opts.commitSha}`, opts.capturedAt);
  db.prepare(
    "INSERT INTO captures (id, project_id, build_id, scenario_id, commit_sha, evidence_label, manifest_json, manifest_digest, request_key, created_at) VALUES (?, ?, ?, ?, ?, 'captured_at_build', '{}', ?, ?, ?)"
  ).run(opts.captureId, PROJECT, `build_${opts.commitSha}`, opts.scenarioId, opts.commitSha, `md_${opts.captureId}`, `rk_${opts.captureId}`, opts.capturedAt);
  for (const obs of opts.observations) {
    db.prepare(
      "INSERT INTO occurrences (id, project_id, capture_id, anchor, visible_text, bounds_json, completeness, created_at) VALUES (?, ?, ?, ?, ?, '[]', 'complete-for-scenario', ?)"
    ).run(obs.id, PROJECT, opts.captureId, obs.anchor, obs.text, opts.capturedAt);
  }
}

function enqueue(db: Db, kind: string, payload: unknown, dedupKey?: string): string {
  const jobId = `job_${Math.random().toString(16).slice(2, 12)}`;
  db.prepare(
    "INSERT INTO jobs (id, project_id, kind, status, stage, payload_json, dedup_key, attempt, max_attempts, created_at, updated_at) VALUES (?, ?, ?, 'queued', 'planning', ?, ?, 0, 3, ?, ?)"
  ).run(jobId, PROJECT, kind, JSON.stringify(payload), dedupKey ?? null, nowIso(), nowIso());
  return jobId;
}

function insertProposalFixture(db: Db): string {
  const proposalId = "prop_worker_test";
  const target = {
    entityId: "ent_catalog_product_chooser",
    entityKey: "catalog.productChooser",
    entityVersionId: "entver_current_ent_catalog_product_chooser",
    currentReadSet: {
      appBuildId: "build_dev_1",
      contractDigest: "contract_digest_worker",
      policyVersion: 1,
      preferenceRevision: 0,
      entityVersions: { ent_catalog_product_chooser: "entver_current_ent_catalog_product_chooser" },
    },
    contract: {
      entityKey: "catalog.productChooser",
      allowedRepresentations: ["carousel@1", "grid@1", "table@1"],
      dataBinding: "catalog.products@1",
      actions: ["product.open@1", "cart.add@1"],
    },
    rendererSchemas: [
      { id: "grid@1", propertySchema: { columns: { type: "number", min: 1, max: 4, default: 3 }, density: { type: "enum", values: ["comfortable", "compact"], default: "comfortable" } } },
      { id: "carousel@1", propertySchema: { density: { type: "enum", values: ["comfortable", "compact"], default: "comfortable" } } },
      { id: "table@1", propertySchema: { columns: { type: "number", min: 2, max: 6, default: 4 }, density: { type: "enum", values: ["comfortable", "compact"], default: "comfortable" } } },
    ],
  };
  const request = {
    requestId: "req_w1",
    operation: "propose_change",
    target: { kind: "selection", entityId: "ent_catalog_product_chooser", runtimeInstanceId: "rt1" },
    references: [],
    instruction: "compact grid",
    appBuildId: "build_dev_1",
    requestedCandidateCount: 3,
  };
  db.prepare(
    "INSERT OR IGNORE INTO ui_entities (id, project_id, entity_key, created_at) VALUES ('ent_catalog_product_chooser', ?, 'catalog.productChooser', ?)"
  ).run(PROJECT, nowIso());
  db.prepare(
    "INSERT OR REPLACE INTO entity_versions (id, project_id, entity_id, build_id, contract_digest, representation_fingerprint, created_at) VALUES ('entver_current_ent_catalog_product_chooser', ?, 'ent_catalog_product_chooser', NULL, 'contract_digest_worker', 'fp', ?)"
  ).run(PROJECT, nowIso());
  db.prepare(
    "INSERT OR REPLACE INTO proposals (id, project_id, request_json, target_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)"
  ).run(proposalId, PROJECT, JSON.stringify(request), JSON.stringify(target), nowIso(), nowIso());
  return proposalId;
}

describe("index-worker", () => {
  let db: Db;
  let cleanup: () => void;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-worker-"));
    cleanup = () => {
      try {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    };
    db = openWorkerDb(join(dir, "worker.sqlite"));
    migrateWorker(db);
    db.prepare(
      "INSERT OR IGNORE INTO projects (id, tenant_id, name, repository, policy_revision, created_at) VALUES (?, 'local', 'reference-app', 'repo', 1, ?)"
    ).run(PROJECT, nowIso());
    db.prepare("INSERT OR IGNORE INTO runtime_manifests (project_id, manifest_json) VALUES (?, ?)").run(
      PROJECT,
      JSON.stringify({ protocolVersion: 1, entities: [], rendererVersions: {}, adapterCapabilities: {}, pages: [], buildId: "b", contractDigest: "c" })
    );

    // Two adjacent commits for the same scenario with a split-shaped change.
    insertCaptureFixture(db, {
      captureId: "cap_w1",
      commitSha: "c1",
      scenarioId: "catalog-desktop-signed-in",
      capturedAt: "2026-01-01T00:00:00.000Z",
      observations: [{ id: "o1", anchor: "product.list", text: "product list with prices and buttons" }],
    });
    insertCaptureFixture(db, {
      captureId: "cap_w2",
      commitSha: "c2",
      scenarioId: "catalog-desktop-signed-in",
      capturedAt: "2026-01-02T00:00:00.000Z",
      observations: [
        { id: "o2", anchor: "product.grid", text: "product list with prices" },
        { id: "o3", anchor: "product.actions", text: "buttons for products" },
      ],
    });
  });

  afterAll(() => {
    cleanup?.();
  });

  it("claims the oldest queued job with a lease", () => {
    const jobId = enqueue(db, "index_capture", { captureId: "cap_w1", projectId: PROJECT });
    const claimed = claimNextJob(db, "w1");
    expect(claimed).not.toBeNull();
    expect(claimed!.jobId).toBe(jobId);
    expect(claimed!.leaseToken).toBeTruthy();
    expect(claimed!.attempt).toBe(1);
  });

  it("processes index_capture into search_index + lineage_edges", async () => {
    const jobId = enqueue(db, "index_capture", { captureId: "cap_w2", projectId: PROJECT });
    const worker = createWorker(db, { intervalMs: 10 });
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false); // nothing left (cap_w1 claimed earlier)

    const searchRows = db.prepare("SELECT * FROM search_index WHERE capture_id = 'cap_w2'").all() as Array<Record<string, unknown>>;
    expect(searchRows.length).toBe(2);
    expect(searchRows.every((r) => r.project_id === PROJECT)).toBe(true);

    const edges = db
      .prepare("SELECT * FROM lineage_edges WHERE project_id = ?")
      .all(PROJECT) as Array<Record<string, unknown>>;
    const relations = edges.map((e) => e.relation);
    expect(relations).toContain("split_into");
    expect(edges.every((e) => e.review_state === "candidate")).toBe(true);
    expect(edges.every((e) => e.matcher_version === "indexing@1")).toBe(true);

    const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string };
    expect(job.status).toBe("succeeded");
  });

  it("retries a failed job with attempt+1 and backoff, then fails terminally", async () => {
    let calls = 0;
    const jobId = enqueue(db, "embedding", {});
    const worker = createWorker(db, {
      intervalMs: 1,
      handlers: {
        embedding: async (job: ClaimedJob) => {
          calls += 1;
          throw new Error(`boom ${calls}`);
        },
      },
    });
    await worker.runOnce(); // attempt 1 fails -> queued
    let row = db.prepare("SELECT status, attempt, last_error FROM jobs WHERE id = ?").get(jobId) as { status: string; attempt: number; last_error: string };
    expect(row.status).toBe("queued");
    expect(row.attempt).toBe(1);
    expect(row.last_error).toContain("boom");

    await worker.runOnce(); // attempt 2 fails -> queued
    await worker.runOnce(); // attempt 3 fails -> terminal failed
    row = db.prepare("SELECT status, attempt FROM jobs WHERE id = ?").get(jobId) as { status: string; attempt: number };
    expect(row.status).toBe("failed");
    expect(row.attempt).toBe(3);
  });

  it("reclaims a job whose lease expired", () => {
    const jobId = enqueue(db, "embedding", {});
    const first = claimNextJob(db, "w1")!;
    expect(first.jobId).toBe(jobId);
    // No other job can be claimed while the lease is active and nothing queued.
    expect(claimNextJob(db, "w2")).toBeNull();
    // Expire the lease.
    db.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", jobId);
    const second = claimNextJob(db, "w2")!;
    expect(second.jobId).toBe(jobId);
    expect(second.attempt).toBe(2);
    // Clean up so later tests see an empty queue.
    completeClaimedJob(db, second, { succeeded: true });
  });

  it("processes a proposal job into a ready proposal with candidates", async () => {
    const proposalId = insertProposalFixture(db);
    const jobId = enqueue(db, "proposal", { proposalId, projectId: PROJECT });
    const worker = createWorker(db, { intervalMs: 1 });
    await worker.runOnce();

    const row = db.prepare("SELECT status, candidates_json, failure_json FROM proposals WHERE id = ?").get(proposalId) as {
      status: string;
      candidates_json: string | null;
      failure_json: string | null;
    };
    expect(row.status).toBe("ready");
    expect(row.failure_json).toBeNull();
    const candidates = JSON.parse(row.candidates_json!) as Array<{ candidateId: string; validation: { passed: boolean; specificationDigest: string }; presentation: { type: string } }>;
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.every((c) => c.validation.passed)).toBe(true);
    expect(candidates.every((c) => ["carousel@1", "grid@1", "table@1"].includes(c.presentation.type))).toBe(true);
    expect(jobId).toBeTruthy();
  });
});
