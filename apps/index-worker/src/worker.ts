/**
 * Index worker (spec sections 10, 11). Reimplements the small claim/complete
 * SQL locally: cross-app imports from apps/api are not allowed, and the queue
 * protocol (lease token + expiry + attempt) is a documented contract, not a
 * shared table abstraction.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { ObjectStore, createStorageDriver } from "@ui-intelligence/storage";
import type { StorageDriver, S3LikeClient } from "@ui-intelligence/storage";
import {
  ProposalOrchestrator,
  SpecValidator,
  DeterministicProvider,
  providerFromEnv,
  type ModelProvider,
  type RendererSchema,
} from "@ui-intelligence/agent";
import { ProposalValidator, RendererRegistry } from "@ui-intelligence/runtime-core";
import { lineageCandidates } from "./lineage.js";
import {
  backoffMs,
  newId,
  type DesignReference,
  type JobKind,
  type JobStage,
  type PageContract,
  type UiRequest,
} from "@ui-intelligence/protocol";
import type { ProviderReference } from "@ui-intelligence/agent";
import { historyApiFromEnv, reconstructCommit, standardScenarios } from "@ui-intelligence/capture";
import type { CommitReconstruction, UploadApi } from "@ui-intelligence/capture";

export type WorkerDb = InstanceType<typeof Database>;

const LEASE_MS = 30_000;

/** Build an ObjectStore from the same environment variables the API uses. */
function workerStoreFromEnv(): ObjectStore {
  const fsRoot = process.env.UI_INTEL_STORE ?? "./data/artifacts";
  const selection = createStorageDriver({
    driver: process.env.UI_INTEL_STORAGE_DRIVER,
    s3Bucket: process.env.UI_INTEL_S3_BUCKET,
    s3Prefix: process.env.UI_INTEL_S3_PREFIX,
    fsRoot,
  });
  return new ObjectStore(fsRoot, selection.driver);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Apply the shared SQLite schema (infra/dev/schema.sql is the source of truth). */
export function migrateWorker(db: WorkerDb): void {
  const candidates = [
    process.env.UI_INTEL_SCHEMA,
    new URL("../../infra/dev/schema.sql", import.meta.url).pathname,
    new URL("../../../infra/dev/schema.sql", import.meta.url).pathname,
  ].filter((p): p is string => typeof p === "string");
  for (const path of candidates) {
    try {
      const sql = readFileSync(path, "utf8");
      db.exec(sql);
      // Graceful migration: add degraded_json to proposals if the table was created
      // before this column existed (closure-2 GAP B).
      const hasDegraded = db.prepare("SELECT name FROM pragma_table_info('proposals') WHERE name = 'degraded_json'").get() as { name: string } | undefined;
      if (!hasDegraded) {
        try {
          db.exec("ALTER TABLE proposals ADD COLUMN degraded_json TEXT");
        } catch {
          // best effort
        }
      }
      return;
    } catch {
      // try next candidate
    }
  }
  throw new Error("could not locate infra/dev/schema.sql; set UI_INTEL_SCHEMA to its path");
}

export type ClaimedJob = {
  jobId: string;
  projectId: string;
  kind: JobKind;
  stage: JobStage;
  payload: Record<string, unknown>;
  leaseToken: string;
  attempt: number;
};

/**
 * Cancellation (spec section 11): queued jobs with a cancel request are
 * terminal immediately; active work observes the flag at its next checkpoint
 * (before handler dispatch, or from inside the handler via cancelRequested).
 */
export class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`job ${jobId} cancelled`);
    this.name = "JobCancelledError";
  }
}

export function cancelRequested(db: WorkerDb, jobId: string): boolean {
  const row = db.prepare("SELECT cancel_requested FROM jobs WHERE id = ?").get(jobId) as
    | { cancel_requested: number }
    | undefined;
  return row?.cancel_requested === 1;
}

/** Claim the oldest queued (or lease-expired) job in a short transaction. */
export function claimNextJob(db: WorkerDb, workerId: string): ClaimedJob | null {
  const tx = db.transaction(() => {
    const now = nowIso();
    // Stop scheduling cancelled work: queued jobs become terminal, running
    // jobs lose their lease so the owner can no longer finalize results.
    db.prepare(
      "UPDATE jobs SET status = 'cancelled', finished_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE cancel_requested = 1 AND status IN ('queued', 'running')"
    ).run(now, now);
    const row = db
      .prepare(
        `SELECT * FROM jobs
         WHERE (status = 'queued' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)))
           AND cancel_requested = 0
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(now) as Record<string, unknown> | undefined;
    if (!row) return null;

    const leaseToken = newId("lease");
    const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
    db.prepare(
      "UPDATE jobs SET status = 'running', lease_token = ?, lease_expires_at = ?, attempt = attempt + 1, updated_at = ? WHERE id = ?"
    ).run(leaseToken, leaseExpiresAt, now, row.id as string);

    return {
      jobId: row.id as string,
      projectId: row.project_id as string,
      kind: row.kind as JobKind,
      stage: row.stage as JobStage,
      payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
      leaseToken,
      attempt: (row.attempt as number) + 1,
      workerId,
    };
  });
  return tx() as ClaimedJob | null;
}

export function renewLease(db: WorkerDb, jobId: string, leaseToken: string): void {
  db.prepare("UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?").run(
    new Date(Date.now() + LEASE_MS).toISOString(),
    nowIso(),
    jobId,
    leaseToken
  );
}

export function completeClaimedJob(
  db: WorkerDb,
  job: ClaimedJob,
  outcome: { succeeded: boolean; error?: string; stage?: JobStage }
): void {
  if (outcome.succeeded) {
    db.prepare(
      "UPDATE jobs SET status = 'succeeded', stage = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?, finished_at = ? WHERE id = ? AND lease_token = ?"
    ).run(outcome.stage ?? "done", nowIso(), nowIso(), job.jobId, job.leaseToken);
    return;
  }
  if (job.attempt >= 3) {
    db.prepare(
      "UPDATE jobs SET status = 'failed', last_error = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?, finished_at = ? WHERE id = ? AND lease_token = ?"
    ).run(outcome.error ?? "unknown error", nowIso(), nowIso(), job.jobId, job.leaseToken);
    return;
  }
  db.prepare(
    "UPDATE jobs SET status = 'queued', last_error = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ?"
  ).run(outcome.error ?? "unknown error", nowIso(), job.jobId, job.leaseToken);
}

export function backoffBeforeRetry(attempt: number): number {
  return backoffMs(attempt);
}

export type WorkerHandlers = Partial<Record<JobKind, (job: ClaimedJob) => Promise<void>>>;

/**
 * history_scan reconstruction deps. Cross-app imports are not allowed, so the
 * reconstruction executor lives in packages/capture and is imported directly;
 * tests inject a fake via `reconstruct`.
 */
export type HistoryScanDeps = {
  /** Local path to the reconstructable source repository (e.g. the fixture corpus). */
  fixtureRepo?: string;
  /** History API for reconstruction publication; defaults to env HISTORY_API_URL/TOKEN/PROJECT. */
  api?: UploadApi;
  /** Injection seam for tests; defaults to the real reconstruction executor. */
  reconstruct?: (args: {
    repoDir: string;
    commitSha: string;
    scenarios: string[];
    api: UploadApi;
  }) => Promise<CommitReconstruction>;
};

export type WorkerDeps = {
  workerId?: string;
  intervalMs?: number;
  leaseRenewMs?: number;
  provider?: ModelProvider;
  handlers?: WorkerHandlers;
  historyScan?: HistoryScanDeps;
  /** Injected object store for tests; otherwise resolved from env. */
  store?: ObjectStore;
};

export type Worker = {
  start(): void;
  stop(): void;
  /** Process at most one job; returns true when a job was processed. */
  runOnce(): Promise<boolean>;
};

export function createWorker(db: WorkerDb, deps: WorkerDeps = {}): Worker {
  const workerId = deps.workerId ?? `worker-${newId("w")}`;
  const intervalMs = deps.intervalMs ?? 2000;
  const leaseRenewMs = deps.leaseRenewMs ?? 10_000;
  let renewalTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let stopped = false;

  async function processJob(job: ClaimedJob): Promise<void> {
    // Lease renewal thread while the job runs.
    renewalTimer = setInterval(() => renewLease(db, job.jobId, job.leaseToken), leaseRenewMs);
    try {
      if (cancelRequested(db, job.jobId)) throw new JobCancelledError(job.jobId);
      const custom = deps.handlers?.[job.kind];
      if (custom) {
        await custom(job);
        return;
      }
      switch (job.kind) {
        case "index_capture":
          await handleIndexCapture(db, job);
          return;
        case "embedding": {
          // Embeddings are not configured in the dev profile: no vectors are
          // produced. Record the skip VISIBLY in the job payload so the record
          // never reads as a bare success (lexical search remains the
          // retrieval path, spec 14).
          const noted = { ...job.payload, embedding: "skipped: no embedding model configured" };
          db.prepare("UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ?").run(
            JSON.stringify(noted),
            nowIso(),
            job.jobId
          );
          return;
        }
        case "proposal":
          await handleProposal(db, job, deps.provider, deps.store);
          return;
        case "history_scan":
          await handleHistoryScan(db, job, deps.historyScan);
          return;
        case "capture":
          return;
        default:
          throw new Error(`unknown job kind ${job.kind}`);
      }
    } finally {
      if (renewalTimer) clearInterval(renewalTimer);
      renewalTimer = null;
    }
  }

  async function runOnce(): Promise<boolean> {
    if (running) return false;
    running = true;
    try {
      const job = claimNextJob(db, workerId);
      if (!job) return false;
      try {
        await processJob(job);
        completeClaimedJob(db, job, { succeeded: true });
      } catch (error) {
        if (error instanceof JobCancelledError || cancelRequested(db, job.jobId)) {
          // Termination deadline honored: the lease owner marks the job
          // cancelled; no further publication happens for it.
          db.prepare(
            "UPDATE jobs SET status = 'cancelled', finished_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ?"
          ).run(nowIso(), nowIso(), job.jobId, job.leaseToken);
        } else {
          completeClaimedJob(db, job, {
            succeeded: false,
            error: error instanceof Error ? error.message : String(error),
          });
          // Bounded retry with backoff before the next claim attempt.
          await sleep(backoffBeforeRetry(job.attempt));
        }
      }
      return true;
    } finally {
      running = false;
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      const processed = await runOnce();
      if (!processed) await sleep(intervalMs);
    }
  }

  return {
    start() {
      stopped = false;
      void loop();
    },
    stop() {
      stopped = true;
      if (renewalTimer) {
        clearInterval(renewalTimer);
        renewalTimer = null;
      }
    },
    runOnce,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Job kind handlers
// ---------------------------------------------------------------------------

/** index_capture: search_index rows + lineage candidates for adjacent commits. */
export async function handleIndexCapture(db: WorkerDb, job: ClaimedJob): Promise<void> {
  const captureId = job.payload.captureId as string;
  const projectId = job.payload.projectId as string;

  const capture = db
    .prepare("SELECT id, scenario_id, commit_sha, created_at FROM captures WHERE project_id = ? AND id = ?")
    .get(projectId, captureId) as { id: string; scenario_id: string; commit_sha: string; created_at: string } | undefined;
  if (!capture) throw new Error(`capture ${captureId} not found`);

  const write = db.transaction(() => {
    // Lexical rows for the capture.
    db.prepare("DELETE FROM search_index WHERE capture_id = ?").run(captureId);
    const occurrences = db
      .prepare("SELECT id, anchor, visible_text FROM occurrences WHERE capture_id = ?")
      .all(captureId) as Array<{ id: string; anchor: string | null; visible_text: string | null }>;
    const insertRow = db.prepare(
      "INSERT INTO search_index (capture_id, project_id, anchor, text) VALUES (?, ?, ?, ?)"
    );
    for (const occ of occurrences) {
      if (occ.anchor === null && occ.visible_text === null) continue;
      insertRow.run(captureId, projectId, occ.anchor, occ.visible_text);
    }

    // Lineage candidates for adjacent commits of the same scenario.
    const siblingCommits = db
      .prepare(
        `SELECT DISTINCT c.commit_sha, c.created_at FROM captures c
         WHERE c.project_id = ? AND c.scenario_id = ?
         ORDER BY c.created_at ASC`
      )
      .all(projectId, capture.scenario_id) as Array<{ commit_sha: string; created_at: string }>;
    const index = siblingCommits.findIndex((c) => c.commit_sha === capture.commit_sha);

    const sideFor = (sha: string): { commitSha: string; anchors: string[]; texts: string[] } => {
      const rows = db
        .prepare(
          `SELECT o.anchor, o.visible_text FROM occurrences o JOIN captures c ON c.id = o.capture_id
           WHERE c.project_id = ? AND c.scenario_id = ? AND c.commit_sha = ?
           ORDER BY o.id ASC`
        )
        .all(projectId, capture.scenario_id, sha) as Array<{ anchor: string | null; visible_text: string | null }>;
      const usable = rows.filter((r) => r.anchor !== null);
      return {
        commitSha: sha,
        anchors: usable.map((r) => r.anchor!),
        texts: usable.map((r) => r.visible_text ?? ""),
      };
    };

    const insertEdge = db.prepare(
      `INSERT INTO lineage_edges (id, project_id, relation, from_entity, to_entity, evidence, score, review_state, matcher_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', 'indexing@1', ?)`
    );
    const pairsToConsider: Array<[string | undefined, string | undefined]> = [
      [siblingCommits[index - 1]?.commit_sha, capture.commit_sha],
      [capture.commit_sha, siblingCommits[index + 1]?.commit_sha],
    ];
    for (const [fromSha, toSha] of pairsToConsider) {
      if (!fromSha || !toSha || fromSha === toSha) continue;
      const from = sideFor(fromSha);
      const to = sideFor(toSha);
      for (const candidate of lineageCandidates(from, to)) {
        // Competing-match guard: skip exact duplicates already stored.
        const existing = db
          .prepare(
            "SELECT 1 FROM lineage_edges WHERE project_id = ? AND relation = ? AND from_entity = ? AND to_entity = ?"
          )
          .get(projectId, candidate.relation, candidate.fromAnchor, candidate.toAnchor);
        if (existing) continue;
        insertEdge.run(
          newId("edge"),
          projectId,
          candidate.relation,
          candidate.fromAnchor,
          candidate.toAnchor,
          JSON.stringify({ kind: "inferred", rationale: candidate.rationale, fromCommit: fromSha, toCommit: toSha }),
          candidate.score,
          nowIso()
        );
      }
    }
  });
  write();
}

/**
 * Ground design references into real stored content (project-scoped, small
 * SQL duplicated locally — cross-app imports are not allowed). History
 * references resolve to the capture's observation text/anchor/commit and its
 * screenshot artifact; image references verify the artifact belongs to the
 * project. Unresolvable references return null → orchestrator placeholder.
 */
/**
 * Ground artifact image content through the configured storage driver.
 * Bytes-first: reads from the shared ObjectStore (fs or S3) so vision
 * providers receive base64 data URLs without a network fetch.
 *
 * Closure-2 GAP A fix: we NO LONGER emit the auth-gated `/v1/artifacts/:id/raw`
 * URL as `imageUrl`. External model providers fetch without credentials and
 * receive 401, so the URL is unusable. The field remains in the type for a
 * future short-lived signed-URL fallback, but for now bytes-first is the
 * only supported delivery mechanism.
 */
async function groundArtifactContent(
  db: WorkerDb,
  store: ObjectStore,
  projectId: string,
  artifactId: string
): Promise<Pick<ProviderReference, "imageBytes" | "imageUrl" | "imageMediaType">> {
  const artifact = db
    .prepare("SELECT id, digest, mime_type FROM artifacts WHERE project_id = ? AND id = ?")
    .get(projectId, artifactId) as { id: string; digest: string; mime_type: string } | undefined;
  if (!artifact) return {};
  let imageBytes: Uint8Array | undefined;
  try {
    const bytes = await store.get(artifact.digest);
    if (bytes && bytes.length > 0) imageBytes = new Uint8Array(bytes);
  } catch {
    // bytes unavailable from the configured driver
  }
  return {
    ...(imageBytes ? { imageBytes } : {}),
    imageMediaType: artifact.mime_type || "image/png",
  };
}

export function referenceLoader(
  db: WorkerDb,
  projectId: string,
  store?: ObjectStore
): (ref: DesignReference) => Promise<ProviderReference | null> {
  return async (ref: DesignReference): Promise<ProviderReference | null> => {
    if (ref.kind === "history") {
      const capture = db
        .prepare("SELECT commit_sha, evidence_label, manifest_json FROM captures WHERE project_id = ? AND id = ?")
        .get(projectId, ref.captureId) as
        | { commit_sha: string; evidence_label: string; manifest_json: string }
        | undefined;
      if (!capture) return null;
      const occurrence = (ref.occurrenceId
        ? db
            .prepare("SELECT anchor, visible_text FROM occurrences WHERE project_id = ? AND id = ? AND capture_id = ?")
            .get(projectId, ref.occurrenceId, ref.captureId)
        : db
            .prepare(
              `SELECT anchor, visible_text FROM occurrences
               WHERE project_id = ? AND capture_id = ? AND (anchor IS NOT NULL OR visible_text IS NOT NULL)
               ORDER BY id ASC LIMIT 1`
            )
            .get(projectId, ref.captureId)) as
        | { anchor: string | null; visible_text: string | null }
        | undefined;
      let artifactId: string | undefined;
      try {
        const manifest = JSON.parse(capture.manifest_json) as { artifacts?: Array<{ artifactId: string; kind: string }> };
        artifactId = (manifest.artifacts ?? []).find((a) => a.kind === "screenshot-png")?.artifactId;
      } catch {
        // malformed manifest: proceed without the artifact id
      }
      const head = `${capture.evidence_label} · ${capture.commit_sha.slice(0, 8)}`;
      // Vision providers get screenshot bytes through the configured store.
      const screenshot = artifactId && store ? await groundArtifactContent(db, store, projectId, artifactId) : {};
      return {
        kind: "history",
        summary: occurrence
          ? `${head} · ${occurrence.anchor ?? "(unanchored)"}: ${occurrence.visible_text ?? "(no text)"}`
          : head,
        text: occurrence?.visible_text ?? undefined,
        ...(artifactId ? { artifactId } : {}),
        ...screenshot,
      };
    }
    if (ref.kind === "image") {
      const artifact = db.prepare("SELECT id FROM artifacts WHERE project_id = ? AND id = ?").get(projectId, ref.artifactId);
      if (!artifact) return null;
      const grounded = store ? await groundArtifactContent(db, store, projectId, ref.artifactId) : {};
      return {
        kind: "image",
        summary: `design image artifact ${ref.artifactId}`,
        artifactId: ref.artifactId,
        ...grounded,
      };
    }
    return null;
  };
}

/** proposal: run the orchestrator with the deterministic provider by default. */
export async function handleProposal(
  db: WorkerDb,
  job: ClaimedJob,
  provider?: ModelProvider,
  store?: ObjectStore
): Promise<void> {
  const proposalId = job.payload.proposalId as string;
  const projectId = job.payload.projectId as string;
  const objectStore = store ?? workerStoreFromEnv();

  const proposalRow = db.prepare("SELECT * FROM proposals WHERE project_id = ? AND id = ?").get(projectId, proposalId) as
    | Record<string, unknown>
    | undefined;
  if (!proposalRow) throw new Error(`proposal ${proposalId} not found`);

  const request = JSON.parse(proposalRow.request_json as string) as UiRequest;
  const targetJson = JSON.parse(proposalRow.target_json as string) as Record<string, unknown>;

  // Page scope (audit finding 4): layout candidates validated against the
  // page contract with runtime-core's ProposalValidator.validatePageLayout.
  if (request.target.kind === "page") {
    const pageContract = targetJson.pageContract as PageContract;
    const pageValidator = new ProposalValidator(new RendererRegistry());
    const orchestrator = new ProposalOrchestrator({
      ...workerOrchestratorBase(db, projectId, provider, objectStore),
      validator: new SpecValidator({
        allowedRepresentations: [...pageContract.allowedLayouts],
        propertySchemas: {},
        dataBinding: `page:${pageContract.pageKey}`,
        allowedActions: [],
      }),
      validatePageLayout: (root, contract, entityContracts, readSet, policyVersion) =>
        pageValidator.validatePageLayout(root, contract, entityContracts, readSet, policyVersion),
    });
    const pageResult = await orchestrator.proposePage(request, {
      pageKey: targetJson.pageKey as string,
      pageContract,
      currentReadSet: targetJson.currentReadSet as Parameters<ProposalOrchestrator["proposePage"]>[1]["currentReadSet"],
    });
    persistProposalOutcome(db, proposalId, pageResult);
    return;
  }

  const target = targetJson as unknown as {
    entityId: string;
    entityKey: string;
    entityVersionId: string;
    currentReadSet: {
      appBuildId: string;
      contractDigest: string;
      policyVersion: number;
      preferenceRevision: number;
      entityVersions: Record<string, string>;
    };
    contract: { entityKey: string; allowedRepresentations: string[]; dataBinding: string; actions: string[] };
    rendererSchemas: RendererSchema[];
  };

  const validator = new SpecValidator({
    allowedRepresentations: target.contract.allowedRepresentations,
    propertySchemas: Object.fromEntries(target.rendererSchemas.map((s) => [s.id, s.propertySchema])),
    dataBinding: target.contract.dataBinding,
    allowedActions: target.contract.actions,
  });
  const orchestrator = new ProposalOrchestrator({
    ...workerOrchestratorBase(db, projectId, provider, objectStore),
    validator,
  });

  const result = await orchestrator.propose(request, target);
  persistProposalOutcome(db, proposalId, result);
}

/** Shared orchestrator deps: provider, grounded reference loader, and policy. */
function workerOrchestratorBase(
  db: WorkerDb,
  projectId: string,
  provider?: ModelProvider,
  store?: ObjectStore
): Pick<ConstructorParameters<typeof ProposalOrchestrator>[0], "provider" | "loadReference" | "policy"> {
  return {
    provider: provider ?? providerFromEnv() ?? new DeterministicProvider(),
    // Ground history/image references into real stored content before the
    // provider sees them (this worker reads through the configured storage
    // driver — fs or S3 — via the shared ObjectStore, closure-2 GAP A).
    loadReference: referenceLoader(db, projectId, store),
    policy: { maxCandidates: 4, timeoutMs: 15_000 },
  };
}

/** Persist the orchestrator outcome (shared by both scopes). */
function persistProposalOutcome(
  db: WorkerDb,
  proposalId: string,
  settled: Awaited<ReturnType<ProposalOrchestrator["propose"]>>
): void {
  db.prepare(
    "UPDATE proposals SET status = ?, candidates_json = ?, failure_json = ?, degraded_json = ?, updated_at = ? WHERE id = ?"
  ).run(
    settled.status,
    settled.candidates.length > 0 ? JSON.stringify(settled.candidates) : null,
    settled.failure ? JSON.stringify(settled.failure) : null,
    settled.degraded ? JSON.stringify(settled.degraded) : null,
    nowIso(),
    proposalId
  );
}

/** history_scan: plan running → reconstruct selected commits → index captures. */

/**
 * Written into the job's result summary when the scan carries NO fixtureRepo
 * (nothing reconstructable): only already-existing captures can be indexed,
 * so selected commits without captures remain explicit gap records.
 */
export const HISTORY_SCAN_RECONSTRUCTION_NOTE =
  "historical reconstruction not run — no fixtureRepo in the scan input; only already-existing captures were indexed";

/** Per-commit result recorded into the job payload when reconstruction runs. */
export type HistoryCommitOutcome = {
  commitSha: string;
  outcome: "captured" | "expected_failure" | "failed";
  captures: string[];
  expectedFailures?: string[];
  error?: string;
};

/**
 * Idempotently record a published (reconstructed) capture in the worker
 * database. In the dev profile the index-worker shares the API's SQLite file,
 * so the published row usually already exists; INSERT OR IGNORE keeps this
 * recording safe for split deployments too and gives the scan a local dedup
 * index for re-runs (extend-without-duplicating).
 */
function recordReconstructedCapture(
  db: WorkerDb,
  projectId: string,
  commitSha: string,
  scenario: { captureId?: string; artifactId?: string; sha256?: string; occurrenceCount?: number; scenarioId: string },
  buildArtifactDigest: string,
): void {
  if (!scenario.captureId) return;
  const createdAt = nowIso();
  const buildId = `build_recon_${commitSha}`;
  db.prepare(
    "INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES (?, ?, ?, ?, 'succeeded', ?)"
  ).run(buildId, projectId, commitSha, buildArtifactDigest, createdAt);
  db.prepare(
    "INSERT OR IGNORE INTO captures (id, project_id, build_id, scenario_id, commit_sha, evidence_label, manifest_json, manifest_digest, request_key, created_at) VALUES (?, ?, ?, ?, ?, 'captured_at_build', ?, ?, ?, ?)"
  ).run(
    scenario.captureId,
    projectId,
    buildId,
    scenario.scenarioId,
    commitSha,
    JSON.stringify({
      captureId: scenario.captureId,
      source: "reconstruction",
      spec: { projectId, commitSha, buildArtifactDigest, scenario: { id: scenario.scenarioId } },
      artifacts: scenario.artifactId ? [{ artifactId: scenario.artifactId, sha256: scenario.sha256 }] : [],
      observationCount: scenario.occurrenceCount,
    }),
    scenario.sha256 ?? scenario.captureId,
    `reconstruct:${projectId}:${commitSha}:${scenario.scenarioId}:${scenario.captureId}`,
    createdAt
  );
}

/** Enqueue an index_capture job for a capture (deduplicated). */
function enqueueIndexCaptureJob(db: WorkerDb, projectId: string, captureId: string): void {
  const existing = db
    .prepare("SELECT id FROM jobs WHERE project_id = ? AND dedup_key = ? AND status IN ('queued','running')")
    .get(projectId, `index_capture:${captureId}`);
  if (existing) return;
  db.prepare(
    "INSERT INTO jobs (id, project_id, kind, status, stage, payload_json, dedup_key, attempt, max_attempts, created_at, updated_at) VALUES (?, ?, 'index_capture', 'queued', 'indexing', ?, ?, 0, 3, ?, ?)"
  ).run(
    newId("job"),
    projectId,
    JSON.stringify({ captureId, projectId }),
    `index_capture:${captureId}`,
    nowIso(),
    nowIso()
  );
}

/**
 * No-reconstructable-source path: index only already-existing captures and
 * finalize with "completed_with_gaps" when selected commits have none.
 */
function finalizeIndexOnlyScan(db: WorkerDb, job: ClaimedJob, planId: string, shas: string[]): void {
  const projectId = job.payload.projectId as string;
  const captures: Array<{ id: string; project_id: string; commit_sha: string }> = [];
  if (shas.length > 0) {
    const placeholders = shas.map(() => "?").join(",");
    captures.push(
      ...(db
        .prepare(`SELECT id, project_id, commit_sha FROM captures WHERE project_id = ? AND commit_sha IN (${placeholders})`)
        .all(projectId, ...shas) as Array<{ id: string; project_id: string; commit_sha: string }>)
    );
    for (const capture of captures) {
      enqueueIndexCaptureJob(db, capture.project_id, capture.id);
    }
  }

  const shasWithCaptures = new Set(captures.map((c) => c.commit_sha));
  const gap = shas.some((sha) => !shasWithCaptures.has(sha));
  const summary: Record<string, unknown> = {
    planId,
    selectedCommits: shas.length,
    reconstructed: 0,
    indexedCaptures: captures.length,
    ...(gap ? { note: HISTORY_SCAN_RECONSTRUCTION_NOTE } : {}),
  };
  db.prepare("UPDATE history_plans SET status = 'completed' WHERE id = ?").run(planId);

  // Honest terminal transition (see below): lease token is cleared so the
  // caller's generic completion cannot overwrite status or payload.
  db.prepare(
    "UPDATE jobs SET status = ?, stage = 'done', payload_json = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?, finished_at = ? WHERE id = ? AND lease_token = ?"
  ).run(
    gap ? "completed_with_gaps" : "succeeded",
    JSON.stringify({ ...job.payload, result: summary }),
    nowIso(),
    nowIso(),
    job.jobId,
    job.leaseToken
  );
}

/**
 * history_scan processing honesty (audit defect 3): the job record must state
 * what actually happened. Two modes:
 *
 * - With a reconstructable source repository (fixtureRepo from the job payload
 *   or the plan input), every selected commit that still misses scenario
 *   captures is RECONSTRUCTED: the commit is materialized as a git worktree,
 *   served, and captured scenario-by-scenario through the real capture path,
 *   with every capture durably published to the history API and VERIFIED
 *   before it counts (packages/capture reconstructCommit). Published captures
 *   are recorded locally and handed to index_capture jobs; re-runs skip
 *   (commit, scenario) pairs that already have captures
 *   (extend-without-duplicating). An intentionally unbuildable commit
 *   (declares INTENTIONALLY_UNBUILDABLE) yields per-scenario EXPECTED
 *   failures — never synthetic successes. The job finalizes as succeeded when
 *   there are no UNexpected failures; unexpected failures throw so the
 *   generic bounded-retry path takes over (retries reuse published captures).
 * - Without fixtureRepo, finalizeIndexOnlyScan keeps the honest-gap behavior.
 *
 * The history plan keeps status "completed" (the plan ran to completion); the
 * history_plans table has no summary column, so per-commit outcomes live in
 * the job payload only.
 */
export async function handleHistoryScan(db: WorkerDb, job: ClaimedJob, deps?: HistoryScanDeps): Promise<void> {
  const planId = job.payload.planId as string;
  const projectId = job.payload.projectId as string;

  const planRow = db
    .prepare("SELECT selected_commits_json, input_json FROM history_plans WHERE project_id = ? AND id = ?")
    .get(projectId, planId) as { selected_commits_json: string; input_json: string } | undefined;
  if (!planRow) throw new Error(`history plan ${planId} not found`);
  db.prepare("UPDATE history_plans SET status = 'running' WHERE id = ?").run(planId);

  const selectedCommits = JSON.parse(planRow.selected_commits_json) as Array<{ commitSha: string }>;
  const shas = selectedCommits.map((c) => c.commitSha);
  const planInput = (() => {
    try {
      return JSON.parse(planRow.input_json ?? "{}") as { fixtureRepo?: string; scenarioIds?: string[] };
    } catch {
      return {};
    }
  })();
  const fixtureRepo = deps?.fixtureRepo ?? (job.payload.fixtureRepo as string | undefined) ?? planInput.fixtureRepo;

  if (!fixtureRepo) {
    finalizeIndexOnlyScan(db, job, planId, shas);
    return;
  }

  const api = deps?.api ?? historyApiFromEnv();
  if (!api) {
    throw new Error(
      "history scan with fixtureRepo requires a history API for durable publication; set HISTORY_API_URL (and HISTORY_API_TOKEN / HISTORY_API_PROJECT)"
    );
  }

  const allScenarioIds = standardScenarios().map((r) => r.id);
  const payloadScenarioIds = job.payload.scenarioIds as string[] | undefined;
  const planScenarioIds = planInput.scenarioIds;
  const scenarioIds =
    payloadScenarioIds && payloadScenarioIds.length > 0
      ? payloadScenarioIds
      : planScenarioIds && planScenarioIds.length > 0
        ? planScenarioIds
        : allScenarioIds;
  const commitOutcomes: HistoryCommitOutcome[] = [];
  let unexpectedFailure: string | undefined;

  for (const commitSha of shas) {
    const existing = db
      .prepare("SELECT id, scenario_id FROM captures WHERE project_id = ? AND commit_sha = ?")
      .all(projectId, commitSha) as Array<{ id: string; scenario_id: string }>;
    const existingScenarioIds = new Set(existing.map((c) => c.scenario_id));
    // Plan-scoped accounting (closure-2 review): only captures whose scenario
    // belongs to THIS plan's selected set count toward the outcome — a subset
    // plan must not report pre-existing captures of unrelated scenarios.
    const selectedSet = new Set(scenarioIds);
    const captureIds = existing.filter((c) => selectedSet.has(c.scenario_id)).map((c) => c.id);
    const expectedFailures: string[] = [];
    const newScenarioOutcomes: Array<{ scenarioId: string; outcome: string }> = [];
    let error: string | undefined;

    try {
      const missing = scenarioIds.filter((id) => !existingScenarioIds.has(id));
      if (missing.length > 0) {
        const reconstruction = await (deps?.reconstruct ?? reconstructCommit)({
          repoDir: fixtureRepo,
          commitSha,
          scenarios: missing,
          api,
        });
        for (const scenario of reconstruction.scenarios) {
          newScenarioOutcomes.push({ scenarioId: scenario.scenarioId, outcome: scenario.outcome });
          if (scenario.outcome === "captured" && scenario.captureId) {
            recordReconstructedCapture(db, projectId, commitSha, scenario, reconstruction.buildArtifactDigest);
            enqueueIndexCaptureJob(db, projectId, scenario.captureId);
            captureIds.push(scenario.captureId);
          } else if (scenario.outcome === "expected_failure") {
            expectedFailures.push(scenario.scenarioId);
          } else if (scenario.outcome === "failed") {
            error ??= `scenario ${scenario.scenarioId} failed: ${scenario.error ?? "unknown error"}`;
          }
        }
      }
    } catch (reconstructError) {
      error = (reconstructError as Error).message;
    }

    const capturedCount =
      scenarioIds.filter((id) => existingScenarioIds.has(id)).length +
      newScenarioOutcomes.filter((s) => s.outcome === "captured").length;
    const outcome: HistoryCommitOutcome["outcome"] = error
      ? "failed"
      : expectedFailures.length > 0
        ? "expected_failure"
        : capturedCount === scenarioIds.length
          ? "captured"
          : "failed";
    if (outcome === "failed" && !error) {
      error = `incomplete reconstruction: ${capturedCount}/${scenarioIds.length} scenarios captured`;
    }
    commitOutcomes.push({
      commitSha,
      outcome,
      captures: captureIds,
      ...(expectedFailures.length > 0 ? { expectedFailures } : {}),
      ...(error ? { error } : {}),
    });
    if (outcome === "failed") unexpectedFailure ??= `commit ${commitSha}: ${error}`;
  }

  const summary = {
    planId,
    selectedCommits: shas.length,
    reconstructed: commitOutcomes.length,
    captured: commitOutcomes.filter((c) => c.outcome === "captured").length,
    expectedFailures: commitOutcomes.filter((c) => c.outcome === "expected_failure").length,
    indexedCaptures: commitOutcomes.reduce((n, c) => n + c.captures.length, 0),
    commits: commitOutcomes,
  };
  db.prepare("UPDATE history_plans SET status = 'completed' WHERE id = ?").run(planId);

  if (unexpectedFailure) {
    // Record the per-commit outcomes, then let the generic bounded-retry path
    // fail the job; retries reuse already-published captures (dedup).
    db.prepare("UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ? AND lease_token = ?").run(
      JSON.stringify({ ...job.payload, result: summary }),
      nowIso(),
      job.jobId,
      job.leaseToken
    );
    throw new Error(`history scan reconstruction failed: ${unexpectedFailure}`);
  }

  // Honest terminal transition: succeeded — expected failures (unbuildable
  // commits) are recorded as such in the payload, never faked into captures.
  // The lease token is cleared so the caller's generic completion is a no-op.
  db.prepare(
    "UPDATE jobs SET status = 'succeeded', stage = 'done', payload_json = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?, finished_at = ? WHERE id = ? AND lease_token = ?"
  ).run(
    JSON.stringify({ ...job.payload, result: summary }),
    nowIso(),
    nowIso(),
    job.jobId,
    job.leaseToken
  );
}
