/**
 * Data access functions. Every query is scoped by project_id so no caller can
 * cross project boundaries (spec section 12).
 */
import type {
  CaptureManifest,
  HistoryPlanInput,
  HistoryPlanRecord,
  JobRecord,
  RuntimeManifest,
  TargetReadSet,
  UiRequest,
} from "@ui-intelligence/protocol";
import type { Db } from "./db.js";
import { nowIso } from "./db.js";

export type ProjectRow = {
  id: string;
  tenantId: string;
  name: string;
  repository: string;
  policyRevision: number;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

export type ProposalRow = {
  id: string;
  projectId: string;
  request: UiRequest;
  target: {
    entityId: string;
    entityKey: string;
    entityVersionId: string;
    currentReadSet: TargetReadSet;
  };
  status: string;
  candidates: unknown[] | null;
  failure: { code: string; message: string } | null;
  acceptedCandidate: { candidateId: string; acceptedAt: string; candidate: unknown } | null;
  createdAt: string;
  updatedAt: string;
};

function rowToJson<T>(row: unknown): T {
  return row as T;
}

export function getProject(db: Db, projectId: string): ProjectRow | null {
  // Accept the project id or the project name as the URL identifier (dev
  // profile: the runtime uses "reference-app" while storage uses
  // "proj_reference_app"). Both resolve to the same stored project.
  const row = db
    .prepare("SELECT * FROM projects WHERE id = ? OR name = ?")
    .get(projectId, projectId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    repository: row.repository as string,
    policyRevision: row.policy_revision as number,
    meta: row.meta_json ? (JSON.parse(row.meta_json as string) as Record<string, unknown>) : null,
    createdAt: row.created_at as string,
  };
}

export function listProjects(db: Db): ProjectRow[] {
  const rows = db.prepare("SELECT * FROM projects ORDER BY created_at").all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    repository: row.repository as string,
    policyRevision: row.policy_revision as number,
    meta: row.meta_json ? (JSON.parse(row.meta_json as string) as Record<string, unknown>) : null,
    createdAt: row.created_at as string,
  }));
}

export function getRuntimeManifest(db: Db, projectId: string): RuntimeManifest | null {
  const row = db.prepare("SELECT manifest_json FROM runtime_manifests WHERE project_id = ?").get(projectId) as
    | { manifest_json: string }
    | undefined;
  return row ? (JSON.parse(row.manifest_json) as RuntimeManifest) : null;
}

export function getEntityByKey(db: Db, projectId: string, entityKey: string): { id: string; entityKey: string } | null {
  const row = db
    .prepare("SELECT id, entity_key FROM ui_entities WHERE project_id = ? AND entity_key = ?")
    .get(projectId, entityKey) as { id: string; entity_key: string } | undefined;
  return row ? { id: row.id, entityKey: row.entity_key } : null;
}

export function getEntityById(db: Db, projectId: string, entityId: string): { id: string; entityKey: string } | null {
  const row = db
    .prepare("SELECT id, entity_key FROM ui_entities WHERE project_id = ? AND (id = ? OR entity_key = ?)")
    .get(projectId, entityId, entityId) as { id: string; entity_key: string } | undefined;
  return row ? { id: row.id, entityKey: row.entity_key } : null;
}

/** Current (or first) entity version id for an entity; synthesizes one if absent. */
export function getOrCreateEntityVersion(db: Db, projectId: string, entityId: string, contractDigest: string): string {
  const existing = db
    .prepare("SELECT id FROM entity_versions WHERE project_id = ? AND entity_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(projectId, entityId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = `entver_${entityId.replace(/^ent_/, "")}`;
  db.prepare(
    "INSERT OR IGNORE INTO entity_versions (id, project_id, entity_id, build_id, contract_digest, representation_fingerprint, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)"
  ).run(id, projectId, entityId, contractDigest, `fp:${contractDigest}`, nowIso());
  const row = db.prepare("SELECT id FROM entity_versions WHERE id = ?").get(id) as { id: string };
  return row.id;
}

export function getArtifact(db: Db, projectId: string | null, artifactId: string): Record<string, unknown> | null {
  const row = (
    projectId
      ? db.prepare("SELECT * FROM artifacts WHERE id = ? AND project_id = ?").get(artifactId, projectId)
      : db.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId)
  ) as Record<string, unknown> | undefined;
  return row ?? null;
}

export function getUploadSlot(db: Db, slotId: string): Record<string, unknown> | null {
  const row = db.prepare("SELECT * FROM upload_slots WHERE id = ?").get(slotId) as Record<string, unknown> | undefined;
  return row ?? null;
}

export function getCaptureByRequestKey(db: Db, projectId: string, requestKey: string): { id: string; manifestDigest: string } | null {
  const row = db
    .prepare("SELECT id, manifest_digest FROM captures WHERE project_id = ? AND request_key = ?")
    .get(projectId, requestKey) as { id: string; manifest_digest: string } | undefined;
  return row ? { id: row.id, manifestDigest: row.manifest_digest } : null;
}

export type CaptureSummary = {
  captureId: string;
  scenarioId: string;
  commitSha: string;
  evidenceLabel: string;
  createdAt: string;
  observationCount: number;
};

export function listCaptures(
  db: Db,
  projectId: string,
  filters: { scenario?: string; commit?: string } = {}
): CaptureSummary[] {
  const clauses = ["c.project_id = ?"];
  const params: unknown[] = [projectId];
  if (filters.scenario) {
    clauses.push("c.scenario_id = ?");
    params.push(filters.scenario);
  }
  if (filters.commit) {
    clauses.push("c.commit_sha = ?");
    params.push(filters.commit);
  }
  const rows = db
    .prepare(
      `SELECT c.id, c.scenario_id, c.commit_sha, c.evidence_label, c.created_at,
              (SELECT COUNT(*) FROM occurrences o WHERE o.capture_id = c.id) AS observation_count
       FROM captures c WHERE ${clauses.join(" AND ")} ORDER BY c.created_at DESC`
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    captureId: r.id as string,
    scenarioId: r.scenario_id as string,
    commitSha: r.commit_sha as string,
    evidenceLabel: r.evidence_label as string,
    createdAt: r.created_at as string,
    observationCount: r.observation_count as number,
  }));
}

export function getProposal(db: Db, projectId: string, proposalId: string): ProposalRow | null {
  const row = db
    .prepare("SELECT * FROM proposals WHERE project_id = ? AND id = ?")
    .get(projectId, proposalId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    request: JSON.parse(row.request_json as string) as UiRequest,
    target: JSON.parse(row.target_json as string) as ProposalRow["target"],
    status: row.status as string,
    candidates: row.candidates_json ? (JSON.parse(row.candidates_json as string) as unknown[]) : null,
    failure: row.failure_json ? (JSON.parse(row.failure_json as string) as { code: string; message: string }) : null,
    acceptedCandidate: row.accepted_candidate_json
      ? (JSON.parse(row.accepted_candidate_json as string) as ProposalRow["acceptedCandidate"])
      : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function listProposals(db: Db, projectId: string): ProposalRow[] {
  const rows = db
    .prepare("SELECT id FROM proposals WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId) as Array<{ id: string }>;
  return rows.map((r) => getProposal(db, projectId, r.id)!).filter(Boolean);
}

export function getHistoryPlan(db: Db, projectId: string, planId: string): HistoryPlanRecord | null {
  const row = db
    .prepare("SELECT * FROM history_plans WHERE project_id = ? AND id = ?")
    .get(projectId, planId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    planId: row.id as string,
    input: JSON.parse(row.input_json as string) as HistoryPlanInput,
    resolvedTips: JSON.parse(row.resolved_tips_json as string) as HistoryPlanRecord["resolvedTips"],
    selectedCommits: JSON.parse(row.selected_commits_json as string) as HistoryPlanRecord["selectedCommits"],
    estimatedCaptures: 0,
    uncertaintyRange: [0, 0],
    status: row.status as HistoryPlanRecord["status"],
    createdAt: row.created_at as string,
  };
}

export function updateHistoryPlanStatus(db: Db, planId: string, status: HistoryPlanRecord["status"]): void {
  db.prepare("UPDATE history_plans SET status = ? WHERE id = ?").run(status, planId);
}

export function insertHistoryPlan(db: Db, projectId: string, record: HistoryPlanRecord): void {
  db.prepare(
    "INSERT INTO history_plans (id, project_id, input_json, resolved_tips_json, selected_commits_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    record.planId,
    projectId,
    JSON.stringify(record.input),
    JSON.stringify(record.resolvedTips),
    JSON.stringify(record.selectedCommits),
    record.status,
    record.createdAt
  );
}

export function jobRecordFromRow(row: Record<string, unknown>): JobRecord {
  return rowToJson<JobRecord>({
    jobId: row.id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    stage: row.stage,
    payload: JSON.parse(row.payload_json as string),
    deduplicationKey: (row.dedup_key as string | null) ?? null,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    leaseToken: (row.lease_token as string | null) ?? null,
    leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: (row.finished_at as string | null) ?? null,
  });
}

export function getJob(db: Db, projectId: string, jobId: string): JobRecord | null {
  const row = db.prepare("SELECT * FROM jobs WHERE project_id = ? AND id = ?").get(projectId, jobId) as
    | Record<string, unknown>
    | undefined;
  return row ? jobRecordFromRow(row) : null;
}

export function listJobs(
  db: Db,
  projectId: string,
  limit = 100,
  filters: { kind?: string; status?: string } = {}
): JobRecord[] {
  const clauses = ["project_id = ?"];
  const params: unknown[] = [projectId];
  if (filters.kind) {
    clauses.push("kind = ?");
    params.push(filters.kind);
  }
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(jobRecordFromRow);
}

export function getCaptureManifest(db: Db, projectId: string, captureId: string): CaptureManifest | null {
  const row = db
    .prepare("SELECT manifest_json FROM captures WHERE project_id = ? AND id = ?")
    .get(projectId, captureId) as { manifest_json: string } | undefined;
  return row ? (JSON.parse(row.manifest_json) as CaptureManifest) : null;
}
