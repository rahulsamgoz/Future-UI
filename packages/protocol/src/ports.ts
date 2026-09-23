/**
 * Module interface ports (protocol section 18). These are conceptual ports;
 * concrete request/result schemas live here, implementations translate at
 * the boundary.
 */
import type { CaptureManifest } from "./capture.js";
import type { Proposal, ProposalCandidate, TargetReadSet, ValidationReport } from "./proposal.js";
import type { ResolveResponse, TargetQuery, UiRequest } from "./request.js";
import type { JobRecord } from "./jobs.js";

export type ResolvedTarget = {
  entityId: string;
  entityKey: string;
  entityVersionId: string;
  currentReadSet: TargetReadSet;
};

/** TargetResolver.resolve: no unauthorized result; ambiguity remains representable. */
export interface TargetResolver {
  resolve(query: TargetQuery, context: { projectId: string; buildId?: string }): Promise<ResolveResponse>;
}

export type HistoryObservationSummary = {
  captureId: string;
  commitSha: string;
  capturedAt: string;
  scenarioId: string;
  evidenceLabel: string;
  screenshotArtifactId?: string;
  summary: string;
};

export type CoverageGap = {
  scenarioId: string;
  reason: string;
  kind: "unbuildable" | "failed" | "not_captured" | "out_of_window";
};

export type HistoryPage = {
  observations: HistoryObservationSummary[];
  gaps: CoverageGap[];
  nextCursor: string | null;
};

/** HistoryReader.list: every visual has provenance; gaps survive filtering. */
export interface HistoryReader {
  list(
    scope: { entityId?: string; entityKey?: string; pageKey?: string },
    filter: { scenarioId?: string; branch?: string; cursor?: string; limit?: number }
  ): Promise<HistoryPage>;
}

export type HistoryPlanInput = {
  repository: string;
  branches: string[];
  windowStart: string; // resolved explicit date
  windowEnd: string;
  scenarioIds: string[];
  maxBuilds: number;
  renderBudgetMs: number;
  timezone: string;
};

export type HistoryPlanRecord = {
  planId: string;
  input: HistoryPlanInput;
  resolvedTips: Array<{ branch: string; commitSha: string }>;
  selectedCommits: Array<{ commitSha: string; reason: string; kind: "release" | "candidate" | "artifact_available" }>;
  estimatedCaptures: number;
  uncertaintyRange: [number, number];
  status: "draft" | "approved" | "running" | "completed" | "failed";
  createdAt: string;
};

/** HistoryPlanner.plan: concrete tips and limits are recorded before execution. */
export interface HistoryPlanner {
  plan(input: HistoryPlanInput): Promise<HistoryPlanRecord>;
}

/** CaptureIngestor.finalize: publish only verified complete metadata. */
export interface CaptureIngestor {
  finalize(manifest: CaptureManifest, idempotencyKey: string): Promise<{ captureId: string; jobId?: string }>;
}

/** VariantPlanner.propose: the provider cannot expand the authorized target or capabilities. */
export interface VariantPlanner {
  propose(request: UiRequest, target: ResolvedTarget): Promise<{ proposalId: string; status: string }>;
}

/** VariantValidator.validate: a report applies only to that exact specification and contract context. */
export interface VariantValidator {
  validate(specification: unknown, readSet: TargetReadSet, policyVersion: number): Promise<ValidationReport>;
}

export type PreviewHandle = {
  previewId: string;
  proposal: Proposal;
  usesStubActions: boolean;
};

/** RuntimeHost.preview: no live mutation bindings are available. */
export interface RuntimeHost {
  preview(specification: unknown, target: ResolvedTarget): Promise<PreviewHandle>;
  apply(acceptedDigest: string, target: ResolvedTarget): Promise<{ applicationId: string }>;
  undo(applicationId: string): Promise<{ restored: string[]; conflicts?: string[] }>;
}

/** SpecificationExporter.export: export does not itself modify or deploy the host application. */
export interface SpecificationExporter {
  export(candidate: ProposalCandidate, target: ResolvedTarget): Promise<{ format: string; contents: string }>;
}

export type { JobRecord };
