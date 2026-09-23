/**
 * Typed fetch client for the UI Intelligence API (dev profile).
 * API base and bearer token come from Vite env vars; the token default is
 * only safe for the local dev profile — never embed a token in production.
 */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";
export const API_TOKEN: string = import.meta.env.VITE_API_TOKEN ?? "dev-token";

export type ProjectSummary = {
  id: string;
  name: string;
  repository: string;
  policyRevision: number;
  declaredScenarios: string[];
};

export type RuntimeManifest = {
  protocolVersion: number;
  rendererVersions: Record<string, number>;
  entities: Array<{
    entityKey: string;
    contractVersion: number;
    allowedRepresentations: string[];
    dataBinding: string;
    actions: string[];
  }>;
  pages: Array<{ pageKey: string; contractVersion: number; slots: string[] }>;
  buildId: string;
  contractDigest: string;
};

export type JobRecordDto = {
  jobId: string;
  projectId: string;
  kind: string;
  status: string;
  stage: string;
  attempt: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ObservationDto = {
  occurrenceId: string;
  captureId: string;
  commitSha: string;
  capturedAt: string;
  scenarioId: string;
  evidenceLabel: string;
  anchor: string | null;
  visibleText: string | null;
  completeness: string;
  screenshotArtifactId?: string;
  summary: string;
};

export type CoverageGapDto = {
  scenarioId: string;
  kind: "unbuildable" | "failed" | "not_captured" | "out_of_window";
  reason: string;
};

export type HistoryPageDto = {
  observations: ObservationDto[];
  gaps: CoverageGapDto[];
  nextCursor: string | null;
};

export type ProposalSummaryDto = { proposalId: string; status: string; candidateCount: number; createdAt: string };

export type ProposalDetailDto = {
  proposalId: string;
  status: string;
  candidates: Array<{
    candidateId: string;
    presentation: { type: string; properties: Record<string, unknown>; dataBinding: string; actions: string[] };
    origin: { kind: string; referenceIds: string[] };
    validation: { passed: boolean; specificationDigest: string; checkedInvariants: string[]; errors: Array<{ code: string; message: string }> };
    summary: string;
  }>;
  failure: { code: string; message: string } | null;
  acceptedCandidateId: string | null;
};

export type CaptureSummaryDto = {
  captureId: string;
  scenarioId: string;
  commitSha: string;
  evidenceLabel: string;
  createdAt: string;
  observationCount: number;
};

export class ApiClient {
  constructor(
    private readonly baseUrl: string = API_BASE,
    private readonly token: string = API_TOKEN
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init.headers as Record<string, string> | undefined),
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = (await res.json())?.error?.message ?? detail;
      } catch {
        // keep statusText
      }
      throw new Error(`API ${res.status}: ${detail}`);
    }
    return (await res.json()) as T;
  }

  listProjects(): Promise<{ projects: ProjectSummary[] }> {
    return this.request("/v1/projects");
  }

  listJobs(projectId: string): Promise<{ jobs: JobRecordDto[] }> {
    return this.request(`/v1/projects/${projectId}/jobs`);
  }

  getRuntimeManifest(projectId: string): Promise<RuntimeManifest> {
    return this.request(`/v1/projects/${projectId}/runtime-manifest`);
  }

  getEntityHistory(
    projectId: string,
    entityId: string,
    params: { scenario?: string; cursor?: string; limit?: number } = {}
  ): Promise<HistoryPageDto> {
    const search = new URLSearchParams();
    if (params.scenario) search.set("scenario", params.scenario);
    if (params.cursor) search.set("cursor", params.cursor);
    if (params.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return this.request(`/v1/projects/${projectId}/entities/${encodeURIComponent(entityId)}/history${qs ? `?${qs}` : ""}`);
  }

  listCaptures(projectId: string, params: { scenario?: string; commit?: string } = {}): Promise<{ captures: CaptureSummaryDto[] }> {
    const search = new URLSearchParams();
    if (params.scenario) search.set("scenario", params.scenario);
    if (params.commit) search.set("commit", params.commit);
    const qs = search.toString();
    return this.request(`/v1/projects/${projectId}/captures${qs ? `?${qs}` : ""}`);
  }

  listProposals(projectId: string): Promise<{ proposals: ProposalSummaryDto[] }> {
    return this.request(`/v1/projects/${projectId}/proposals`);
  }

  getProposal(projectId: string, proposalId: string): Promise<ProposalDetailDto> {
    return this.request(`/v1/projects/${projectId}/proposals/${encodeURIComponent(proposalId)}`);
  }

  /** Screenshots are fetched as blobs (with auth) and rendered via object URLs. */
  async fetchArtifactBlob(artifactId: string): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}/raw`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`artifact fetch failed: ${res.status}`);
    return res.blob();
  }
}

export function evidenceLabelClass(label: string): string {
  switch (label) {
    case "captured_at_build":
      return "chip chip-captured";
    case "reconstructed_from_commit":
      return "chip chip-reconstructed";
    case "replayed_artifact":
      return "chip chip-replayed";
    case "source_only":
      return "chip chip-source";
    default:
      return "chip chip-unavailable";
  }
}
