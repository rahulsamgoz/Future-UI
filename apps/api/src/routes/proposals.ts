/**
 * Proposal routes: create (queued + job), inspect, accept, export.
 */
import { newId, uiRequestSchema, UiIntelligenceError } from "@ui-intelligence/protocol";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { nowIso } from "../db.js";
import { enqueueJob, insertOutbox } from "../jobs.js";
import { resolveTarget, type LexicalIndexCache } from "../resolve.js";
import { getProject, getProposal, getRuntimeManifest, listProposals } from "../store.js";
import type { StoredProposalTarget } from "../processor.js";

export type ProposalDeps = { db: Db; indexCache: LexicalIndexCache };

export async function proposalRoutes(app: FastifyInstance, deps: ProposalDeps): Promise<void> {
  const { db, indexCache } = deps;

  app.post("/v1/projects/:p/proposals", async (request, reply) => {
    const projectId = (request.params as { p: string }).p;
    const project = getProject(db, projectId);
    if (!project) {
      throw new UiIntelligenceError("NOT_FOUND", `project ${projectId} not found`, { httpStatus: 404 });
    }
    const parsed = uiRequestSchema.safeParse((request.body as { request?: unknown })?.request ?? request.body);
    if (!parsed.success) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "invalid UiRequest", {
        httpStatus: 422,
        details: parsed.error.issues,
      });
    }
    const uiRequest = parsed.data;

    const resolved = resolveTarget(db, projectId, indexCache, uiRequest.target);
    if (resolved.status === "ambiguous") {
      throw new UiIntelligenceError("AMBIGUOUS_TARGET", "target is ambiguous; choose a candidate", {
        httpStatus: 422,
        details: { candidates: resolved.candidates },
      });
    }
    if (resolved.status === "no_match") {
      throw new UiIntelligenceError("UNRESOLVED_TARGET", resolved.reason, { httpStatus: 422 });
    }

    const manifest = getRuntimeManifest(db, projectId);
    if (!manifest) {
      throw new UiIntelligenceError("NOT_FOUND", `no runtime manifest for project ${projectId}`, { httpStatus: 404 });
    }
    const manifestEntity = manifest.entities.find((e) => e.entityKey === resolved.entityKey);
    const extendedManifest = manifest as typeof manifest & {
      rendererSchemas?: Record<string, Record<string, { type: string; values?: (string | number)[]; min?: number; max?: number; default?: unknown }>>;
    };
    if (!manifestEntity) {
      throw new UiIntelligenceError("NOT_FOUND", `entity key ${resolved.entityKey} not in runtime manifest`, {
        httpStatus: 404,
      });
    }

    const entityId = resolved.entityId;
    const entityVersionRow = db
      .prepare("SELECT id, contract_digest FROM entity_versions WHERE project_id = ? AND entity_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(projectId, entityId) as { id: string; contract_digest: string } | undefined;
    const entityVersionId = entityVersionRow?.id ?? `entver_current_${entityId}`;
    if (!entityVersionRow) {
      db.prepare(
        "INSERT OR IGNORE INTO entity_versions (id, project_id, entity_id, build_id, contract_digest, representation_fingerprint, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)"
      ).run(entityVersionId, projectId, entityId, manifest.contractDigest, `fp:${manifest.contractDigest}`, nowIso());
    }

    const target: StoredProposalTarget = {
      entityId,
      entityKey: resolved.entityKey,
      entityVersionId,
      currentReadSet: {
        appBuildId: uiRequest.appBuildId,
        contractDigest: manifest.contractDigest,
        policyVersion: project.policyRevision,
        preferenceRevision: 0,
        entityVersions: { [entityId]: entityVersionId },
      },
      contract: {
        entityKey: manifestEntity.entityKey,
        allowedRepresentations: manifestEntity.allowedRepresentations,
        dataBinding: manifestEntity.dataBinding,
        actions: manifestEntity.actions,
      },
      rendererSchemas: Object.entries(extendedManifest.rendererSchemas ?? {}).map(([id, propertySchema]) => ({
        id,
        propertySchema,
      })),
    };

    const proposalId = newId("proposal");
    const now = nowIso();
    db.prepare(
      "INSERT INTO proposals (id, project_id, request_json, target_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)"
    ).run(proposalId, projectId, JSON.stringify(uiRequest), JSON.stringify(target), now, now);

    const jobId = enqueueJob(db, {
      projectId,
      kind: "proposal",
      payload: { proposalId, projectId },
      dedupKey: `proposal:${proposalId}`,
      stage: "planning",
    });
    insertOutbox(db, projectId, jobId);

    return reply.code(202).send({ proposalId, jobId });
  });

  app.get("/v1/projects/:p/proposals", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const proposals = listProposals(db, projectId);
    return {
      proposals: proposals.map((p) => ({
        proposalId: p.id,
        status: p.status,
        candidateCount: p.candidates?.length ?? 0,
        createdAt: p.createdAt,
      })),
    };
  });

  app.get("/v1/projects/:p/proposals/:id", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const proposalId = (request.params as { id: string }).id;
    const proposal = getProposal(db, projectId, proposalId);
    if (!proposal) {
      throw new UiIntelligenceError("NOT_FOUND", `proposal ${proposalId} not found`, { httpStatus: 404 });
    }
    return {
      proposalId: proposal.id,
      status: proposal.status,
      candidates: proposal.candidates ?? [],
      failure: proposal.failure,
      acceptedCandidateId: proposal.acceptedCandidate?.candidateId ?? null,
    };
  });

  app.post("/v1/projects/:p/proposals/:id/accept", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const proposalId = (request.params as { id: string }).id;
    const candidateId = (request.body as { candidateId?: string })?.candidateId;
    const proposal = getProposal(db, projectId, proposalId);
    if (!proposal) {
      throw new UiIntelligenceError("NOT_FOUND", `proposal ${proposalId} not found`, { httpStatus: 404 });
    }
    if (proposal.status !== "ready" || !proposal.candidates) {
      throw new UiIntelligenceError("STALE_REVISION", `proposal is ${proposal.status}; only ready proposals can be accepted`, {
        httpStatus: 409,
      });
    }
    const candidate = proposal.candidates.find((c) => (c as { candidateId?: string }).candidateId === candidateId);
    if (!candidate) {
      throw new UiIntelligenceError("SCHEMA_INVALID", `candidate ${candidateId} not part of this proposal`, { httpStatus: 422 });
    }
    // Records the acceptance only — no business action is executed.
    db.prepare("UPDATE proposals SET accepted_candidate_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ candidateId, acceptedAt: nowIso(), candidate }),
      nowIso(),
      proposalId
    );
    const validated = candidate as { validation?: { specificationDigest?: string } };
    return {
      proposalId,
      accepted: true,
      candidateId,
      specificationDigest: validated.validation?.specificationDigest ?? null,
    };
  });

  app.post("/v1/projects/:p/proposals/:id/export", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const proposalId = (request.params as { id: string }).id;
    const proposal = getProposal(db, projectId, proposalId);
    if (!proposal) {
      throw new UiIntelligenceError("NOT_FOUND", `proposal ${proposalId} not found`, { httpStatus: 404 });
    }
    if (!proposal.acceptedCandidate) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "proposal has no accepted candidate to export", { httpStatus: 409 });
    }
    const manifest = getRuntimeManifest(db, projectId);
    const candidate = proposal.acceptedCandidate.candidate as {
      presentation?: { type?: string; dataBinding?: string; actions?: string[] };
      origin?: { kind?: string };
      validation?: { specificationDigest?: string };
    };
    const rendererType = candidate.presentation?.type ?? "";
    const contents = JSON.stringify(
      {
        format: "ui-intelligence/specification@1",
        proposalId: proposal.id,
        candidate: proposal.acceptedCandidate.candidate,
        candidateId: proposal.acceptedCandidate.candidateId,
        acceptedAt: proposal.acceptedCandidate.acceptedAt,
        requiredRendererVersions: {
          ...(manifest?.rendererVersions ?? {}),
          ...(rendererType ? { [rendererType]: manifest?.rendererVersions?.[rendererType] ?? 1 } : {}),
        },
        requiredBindings: {
          dataBinding: candidate.presentation?.dataBinding ?? null,
          actions: candidate.presentation?.actions ?? [],
        },
        provenance: {
          origin: candidate.origin ?? null,
          validationDigest: candidate.validation?.specificationDigest ?? null,
          appBuildId: proposal.request.appBuildId,
          exportedAt: nowIso(),
        },
      },
      null,
      2
    );
    return { format: "ui-intelligence/specification@1", contents };
  });
}
