/**
 * Index worker (spec sections 10, 11). Reimplements the small claim/complete
 * SQL locally: cross-app imports from apps/api are not allowed, and the queue
 * protocol (lease token + expiry + attempt) is a documented contract, not a
 * shared table abstraction.
 */
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import {
  ProposalOrchestrator,
  SpecValidator,
  DeterministicProvider,
  providerFromEnv,
  type ModelProvider,
  type RendererSchema,
} from "@ui-intelligence/agent";
import { lineageCandidates } from "./lineage.js";
import { backoffMs, newId, type JobKind, type JobStage } from "@ui-intelligence/protocol";

export type WorkerDb = InstanceType<typeof Database>;

const LEASE_MS = 30_000;

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

/** Claim the oldest queued (or lease-expired) job in a short transaction. */
export function claimNextJob(db: WorkerDb, workerId: string): ClaimedJob | null {
  const tx = db.transaction(() => {
    const now = nowIso();
    const row = db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'queued'
            OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?))
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
  return (tx() as ClaimedJob | null) ?? null;
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

export type WorkerDeps = {
  workerId?: string;
  intervalMs?: number;
  leaseRenewMs?: number;
  provider?: ModelProvider;
  handlers?: WorkerHandlers;
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
      const custom = deps.handlers?.[job.kind];
      if (custom) {
        await custom(job);
        return;
      }
      switch (job.kind) {
        case "index_capture":
          await handleIndexCapture(db, job);
          return;
        case "embedding":
          // Embeddings are not configured in the dev profile: explicit no-op
          // success so lexical search remains the retrieval path (spec 14).
          return;
        case "proposal":
          await handleProposal(db, job, deps.provider);
          return;
        case "history_scan":
          await handleHistoryScan(db, job);
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
        completeClaimedJob(db, job, {
          succeeded: false,
          error: error instanceof Error ? error.message : String(error),
        });
        // Bounded retry with backoff before the next claim attempt.
        await sleep(backoffBeforeRetry(job.attempt));
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

  let loopPromise: Promise<void> | null = null;

  return {
    start() {
      stopped = false;
      loopPromise = loop();
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

type OccurrenceRow = {
  id: string;
  capture_id: string;
  anchor: string | null;
  visible_text: string | null;
  commit_sha: string;
  scenario_id: string;
  created_at: string;
};

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

/** proposal: run the orchestrator with the deterministic provider by default. */
export async function handleProposal(db: WorkerDb, job: ClaimedJob, provider?: ModelProvider): Promise<void> {
  const proposalId = job.payload.proposalId as string;
  const projectId = job.payload.projectId as string;

  const proposalRow = db.prepare("SELECT * FROM proposals WHERE project_id = ? AND id = ?").get(projectId, proposalId) as
    | Record<string, unknown>
    | undefined;
  if (!proposalRow) throw new Error(`proposal ${proposalId} not found`);

  const request = JSON.parse(proposalRow.request_json as string);
  const target = JSON.parse(proposalRow.target_json as string) as {
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
    provider: provider ?? providerFromEnv() ?? new DeterministicProvider(),
    validator,
    policy: { maxCandidates: 4, timeoutMs: 15_000 },
  });

  const result = await orchestrator.propose(request, target);
  db.prepare("UPDATE proposals SET status = ?, candidates_json = ?, failure_json = ?, updated_at = ? WHERE id = ?").run(
    result.status,
    result.candidates.length > 0 ? JSON.stringify(result.candidates) : null,
    result.failure ? JSON.stringify(result.failure) : null,
    nowIso(),
    proposalId
  );
}

/** history_scan: plan running → enqueue index_capture per capture → completed. */
export async function handleHistoryScan(db: WorkerDb, job: ClaimedJob): Promise<void> {
  const planId = job.payload.planId as string;
  const projectId = job.payload.projectId as string;

  const planRow = db
    .prepare("SELECT selected_commits_json FROM history_plans WHERE project_id = ? AND id = ?")
    .get(projectId, planId) as { selected_commits_json: string } | undefined;
  if (!planRow) throw new Error(`history plan ${planId} not found`);
  db.prepare("UPDATE history_plans SET status = 'running' WHERE id = ?").run(planId);

  const selectedCommits = JSON.parse(planRow.selected_commits_json) as Array<{ commitSha: string }>;
  const shas = selectedCommits.map((c) => c.commitSha);
  if (shas.length > 0) {
    const placeholders = shas.map(() => "?").join(",");
    const captures = db
      .prepare(`SELECT id, project_id FROM captures WHERE project_id = ? AND commit_sha IN (${placeholders})`)
      .all(projectId, ...shas) as Array<{ id: string; project_id: string }>;
    for (const capture of captures) {
      const existing = db
        .prepare("SELECT id FROM jobs WHERE project_id = ? AND dedup_key = ? AND status IN ('queued','running')")
        .get(capture.project_id, `index_capture:${capture.id}`);
      if (existing) continue;
      db.prepare(
        "INSERT INTO jobs (id, project_id, kind, status, stage, payload_json, dedup_key, attempt, max_attempts, created_at, updated_at) VALUES (?, ?, 'index_capture', 'queued', 'indexing', ?, ?, 0, 3, ?, ?)"
      ).run(
        newId("job"),
        capture.project_id,
        JSON.stringify({ captureId: capture.id, projectId: capture.project_id }),
        `index_capture:${capture.id}`,
        nowIso(),
        nowIso()
      );
    }
  }
  db.prepare("UPDATE history_plans SET status = 'completed' WHERE id = ?").run(planId);
}
