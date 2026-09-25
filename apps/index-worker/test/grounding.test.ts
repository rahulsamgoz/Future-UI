import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { openWorkerDb, migrateWorker } from "../src/db.js";
import { claimNextJob, createWorker, handleProposal, referenceLoader, type ClaimedJob } from "../src/worker.js";
import type { ProviderInput } from "@ui-intelligence/agent";
import type { DesignReference } from "@ui-intelligence/protocol";

const PROJECT = "proj_reference_app";

function nowIso(): string {
  return new Date().toISOString();
}

function enqueue(db: Db, kind: string, payload: unknown): string {
  const jobId = `job_${Math.random().toString(16).slice(2, 12)}`;
  db.prepare(
    "INSERT INTO jobs (id, project_id, kind, status, stage, payload_json, dedup_key, attempt, max_attempts, created_at, updated_at) VALUES (?, ?, ?, 'queued', 'planning', ?, NULL, 0, 3, ?, ?)"
  ).run(jobId, PROJECT, kind, JSON.stringify(payload), nowIso(), nowIso());
  return jobId;
}

/** Capture with a manifest that declares a screenshot artifact. */
function insertCaptureWithScreenshot(db: Db, captureId: string): void {
  const manifest = {
    artifacts: [{ artifactId: "art_shot_1", kind: "screenshot-png", digest: "d1", byteSize: 10, mimeType: "image/png" }],
  };
  db.prepare(
    "INSERT OR IGNORE INTO commits (sha, project_id, committed_at, parents_json) VALUES ('abc123', ?, ?, '[]')"
  ).run(PROJECT, nowIso());
  db.prepare(
    "INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES ('build_abc123', ?, 'abc123', 'ad', 'succeeded', ?)"
  ).run(PROJECT, nowIso());
  db.prepare(
    "INSERT INTO captures (id, project_id, build_id, scenario_id, commit_sha, evidence_label, manifest_json, manifest_digest, request_key, created_at) VALUES (?, ?, 'build_abc123', 'catalog-desktop', 'abc123', 'captured_at_build', ?, 'md', 'rk', ?)"
  ).run(captureId, PROJECT, JSON.stringify(manifest), nowIso());
  db.prepare(
    "INSERT INTO occurrences (id, project_id, capture_id, anchor, visible_text, bounds_json, completeness, created_at) VALUES ('occ_1', ?, ?, 'catalog.productChooser.grid', 'Sort by price, 24 products', '[]', 'complete-for-scenario', ?)"
  ).run(PROJECT, captureId, nowIso());
}

describe("index-worker grounding + embedding honesty", () => {
  let db: Db;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ui-intel-grounding-"));
    db = openWorkerDb(join(dir, "worker.sqlite"));
    migrateWorker(db);
    db.prepare(
      "INSERT OR IGNORE INTO projects (id, tenant_id, name, repository, policy_revision, created_at) VALUES (?, 'local', 'reference-app', 'repo', 1, ?)"
    ).run(PROJECT, nowIso());
    insertCaptureWithScreenshot(db, "cap_g1");
  });

  afterAll(() => {
    try {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("records an explicit skip note in the embedding job payload instead of a bare success", async () => {
    const jobId = enqueue(db, "embedding", { projectId: PROJECT });
    const worker = createWorker(db, { intervalMs: 1 });
    await worker.runOnce();

    const row = db.prepare("SELECT status, payload_json FROM jobs WHERE id = ?").get(jobId) as {
      status: string;
      payload_json: string;
    };
    expect(row.status).toBe("succeeded");
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(payload.embedding).toBe("skipped: no embedding model configured");
  });

  it("grounds a history reference into real observation content via referenceLoader", async () => {
    const load = referenceLoader(db, PROJECT);
    const grounded = await load({ kind: "history", captureId: "cap_g1" } as DesignReference);
    expect(grounded).not.toBeNull();
    expect(grounded!.summary).toContain("captured_at_build");
    expect(grounded!.summary).toContain("abc123");
    expect(grounded!.summary).toContain("catalog.productChooser.grid");
    expect(grounded!.summary).toContain("Sort by price, 24 products");
    expect(grounded!.text).toBe("Sort by price, 24 products");
    expect(grounded!.artifactId).toBe("art_shot_1");
  });

  it("returns null for unknown references instead of inventing content", async () => {
    const load = referenceLoader(db, PROJECT);
    expect(await load({ kind: "history", captureId: "cap_missing" } as DesignReference)).toBeNull();
    expect(await load({ kind: "image", artifactId: "art_missing" } as DesignReference)).toBeNull();
  });

  it("handleProposal passes grounded reference content to the provider", async () => {
    const target = {
      entityId: "ent_1",
      entityKey: "catalog.productChooser",
      entityVersionId: "entver_1",
      currentReadSet: {
        appBuildId: "build_dev",
        contractDigest: "contract_digest_worker",
        policyVersion: 1,
        preferenceRevision: 0,
        entityVersions: { ent_1: "entver_1" },
      },
      contract: {
        entityKey: "catalog.productChooser",
        allowedRepresentations: ["grid@1"],
        dataBinding: "catalog.products@1",
        actions: ["product.open@1"],
      },
      rendererSchemas: [
        { id: "grid@1", propertySchema: { columns: { type: "number", min: 1, max: 4, default: 3 }, density: { type: "enum", values: ["comfortable", "compact"], default: "comfortable" } } },
      ],
    };
    const request = {
      requestId: "req_g2",
      operation: "propose_change",
      target: { kind: "selection", entityId: "ent_1", runtimeInstanceId: "rt_1" },
      references: [{ kind: "history", captureId: "cap_g1" }],
      instruction: "match history",
      appBuildId: "build_dev",
      requestedCandidateCount: 1,
    };
    db.prepare(
      "INSERT OR REPLACE INTO proposals (id, project_id, request_json, target_json, status, created_at, updated_at) VALUES ('prop_g1', ?, ?, ?, 'queued', ?, ?)"
    ).run(PROJECT, JSON.stringify(request), JSON.stringify(target), nowIso(), nowIso());

    const seen: ProviderInput[] = [];
    const job: ClaimedJob = {
      jobId: "job_manual",
      projectId: PROJECT,
      kind: "proposal",
      stage: "planning",
      payload: { proposalId: "prop_g1", projectId: PROJECT },
      leaseToken: "lease_manual",
      attempt: 1,
      workerId: "w_test",
    };
    await handleProposal(db, job, {
      id: "recording",
      async generate(input: ProviderInput) {
        seen.push(input);
        return {
          candidates: [
            { type: "grid@1", properties: { columns: 2, density: "compact" }, originKind: "generated", summary: "grid" },
          ],
        };
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.references[0]!.kind).toBe("history");
    expect(seen[0]!.references[0]!.summary).toContain("Sort by price, 24 products");
    expect(seen[0]!.references[0]!.artifactId).toBe("art_shot_1");

    const row = db.prepare("SELECT status FROM proposals WHERE id = 'prop_g1'").get() as { status: string };
    expect(row.status).toBe("ready");
    expect(claimNextJob(db, "w_drain")).toBeNull();
  });
});
