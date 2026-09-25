/**
 * Inline job processing for the API service (used by tests and small
 * deployments). The index-worker has its own processing loop with duplicated
 * claim SQL — cross-app imports are not allowed.
 */
import { ProposalOrchestrator, SpecValidator, DeterministicProvider, type ModelProvider, type RendererSchema } from "@ui-intelligence/agent";
import type { JobKind } from "@ui-intelligence/protocol";
import type { Db } from "./db.js";
import { nowIso } from "./db.js";
import { claimJob, completeJob, enqueueJob, insertOutbox } from "./jobs.js";
import { getHistoryPlan, getProposal, updateHistoryPlanStatus } from "./store.js";
import { dbReferenceLoader, type ReferenceLoader } from "./references.js";

export type StoredProposalTarget = {
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

export type ProposalProcessingOptions = {
  provider?: ModelProvider;
  maxCandidates?: number;
  timeoutMs?: number;
  /** Overrides the default DB-backed reference loader (tests). */
  loadReference?: ReferenceLoader;
};

/** Run the proposal through the orchestrator and persist the outcome. */
export async function processProposal(db: Db, projectId: string, proposalId: string, options: ProposalProcessingOptions = {}): Promise<void> {
  const proposal = getProposal(db, projectId, proposalId);
  if (!proposal) throw new Error(`proposal ${proposalId} not found`);

  const target = proposal.target as StoredProposalTarget;
  const validator = new SpecValidator({
    allowedRepresentations: target.contract.allowedRepresentations,
    propertySchemas: Object.fromEntries(target.rendererSchemas.map((s) => [s.id, s.propertySchema])),
    dataBinding: target.contract.dataBinding,
    allowedActions: target.contract.actions,
  });
  const orchestrator = new ProposalOrchestrator({
    provider: options.provider ?? new DeterministicProvider(),
    validator,
    // Ground history/image references into real stored content before the
    // provider sees them (captures/occurrences/artifacts live in this DB).
    loadReference: options.loadReference ?? dbReferenceLoader(db, projectId),
    policy: { maxCandidates: options.maxCandidates ?? 4, timeoutMs: options.timeoutMs ?? 15_000 },
  });

  const settled = await orchestrator.propose(proposal.request, target);
  db.prepare("UPDATE proposals SET status = ?, candidates_json = ?, failure_json = ?, updated_at = ? WHERE id = ?").run(
    settled.status,
    settled.candidates.length > 0 ? JSON.stringify(settled.candidates) : null,
    settled.failure ? JSON.stringify(settled.failure) : null,
    nowIso(),
    proposalId
  );
}

/** history_scan: mark the plan running, enqueue index_capture for its window, complete. */
export function processHistoryScan(db: Db, projectId: string, planId: string): void {
  const plan = getHistoryPlan(db, projectId, planId);
  if (!plan) throw new Error(`history plan ${planId} not found`);
  updateHistoryPlanStatus(db, planId, "running");

  const commits = plan.selectedCommits.map((c) => c.commitSha);
  if (commits.length > 0) {
    const placeholders = commits.map(() => "?").join(",");
    const captures = db
      .prepare(`SELECT id, project_id FROM captures WHERE project_id = ? AND commit_sha IN (${placeholders})`)
      .all(projectId, ...commits) as Array<{ id: string; project_id: string }>;
    for (const capture of captures) {
      enqueueJob(db, {
        projectId: capture.project_id,
        kind: "index_capture",
        payload: { captureId: capture.id, projectId: capture.project_id },
        dedupKey: `index_capture:${capture.id}`,
        stage: "indexing",
      });
    }
  }
  updateHistoryPlanStatus(db, planId, "completed");
}

/** Claim a job and process it inline. Returns the resulting status. */
export async function processJobInline(
  db: Db,
  projectId: string,
  jobId: string,
  options: { provider?: ModelProvider } = {}
): Promise<string> {
  const claim = claimJob(db, projectId, jobId, "api-inline");
  const row = db.prepare("SELECT kind, payload_json FROM jobs WHERE id = ?").get(jobId) as {
    kind: JobKind;
    payload_json: string;
  };
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  try {
    switch (row.kind) {
      case "proposal":
        await processProposal(db, projectId, payload.proposalId as string, options);
        break;
      case "history_scan":
        processHistoryScan(db, projectId, payload.planId as string);
        break;
      case "embedding": {
        // Embeddings are not configured in the dev profile: no vectors are
        // produced. Record the skip VISIBLY in the job payload so the record
        // never reads as a bare success (lexical search stays the retrieval
        // path, spec 14).
        const noted = { ...payload, embedding: "skipped: no embedding model configured" };
        db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(JSON.stringify(noted), jobId);
        break;
      }
      case "index_capture":
        // Full indexing runs in the index-worker; inline processing succeeds
        // without side effects so at-least-once delivery stays correct.
        break;
      case "capture":
        break;
      default:
        throw new Error(`unknown job kind ${row.kind}`);
    }
    completeJob(db, projectId, jobId, claim.leaseToken, { succeeded: true, stage: "done" });
  } catch (error) {
    completeJob(db, projectId, jobId, claim.leaseToken, {
      succeeded: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const final = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string };
  return final.status;
}

/** Create a proposal record + job; shared by the API route and tests. */
export function enqueueProposalJob(db: Db, projectId: string, proposalId: string): string {
  const jobId = enqueueJob(db, {
    projectId,
    kind: "proposal",
    payload: { proposalId, projectId },
    dedupKey: `proposal:${proposalId}`,
    stage: "planning",
  });
  insertOutbox(db, projectId, jobId);
  return jobId;
}
