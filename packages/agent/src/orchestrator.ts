/**
 * Proposal orchestration (spec section 8, request-to-application flow):
 * generate → envelope → validate → bounded repair rounds → ready/failed.
 * The provider cannot expand the authorized target or capabilities.
 */
import {
  newId,
  type DesignReference,
  type Proposal,
  type ProposalCandidate,
  type ProposalStatus,
  type TargetReadSet,
  type UiRequest,
  type ValidationReport,
} from "@ui-intelligence/protocol";
import type { ModelProvider, ProviderInput, ProviderReference, RendererPropertySchema } from "./provider.js";

export type OrchestratorPolicy = {
  maxCandidates: number;
  maxRepairRounds: number;
  timeoutMs: number;
};

export type ProposeTarget = {
  entityId: string;
  entityKey: string;
  entityVersionId: string;
  currentReadSet: TargetReadSet;
  contract: {
    entityKey: string;
    allowedRepresentations: string[];
    dataBinding: string;
    actions: string[];
  };
  rendererSchemas: ProviderInput["rendererSchemas"];
};

export type ProposeResult = {
  proposalId: string;
  status: ProposalStatus;
  candidates: ProposalCandidate[];
  failure?: { code: string; message: string };
};

export type OrchestratorDeps = {
  provider: ModelProvider;
  validator: {
    validate(spec: unknown, readSet: TargetReadSet, policyVersion: number): ValidationReport;
  };
  /**
   * Optional async loader that grounds design references into real content
   * before they reach the provider. For a history reference it should return
   * the capture's observation (visibleText, anchor, commit, evidence label)
   * and screenshot artifact id; for an image reference the artifact id (and
   * url when one can be produced). When absent, or when it returns null or
   * throws, the orchestrator falls back to the neutral placeholder summary so
   * generation degrades gracefully instead of failing.
   */
  loadReference?: (ref: DesignReference) => Promise<ProviderReference | null>;
  policy?: Partial<OrchestratorPolicy>;
};

const DEFAULT_POLICY: OrchestratorPolicy = {
  maxCandidates: 4,
  maxRepairRounds: 2,
  timeoutMs: 20_000,
};

type ProviderCandidateLike = {
  type: string;
  properties: Record<string, unknown>;
  originKind: "generated" | "historical_adaptation" | "recorded_history";
  summary: string;
};

export class ProposalOrchestrator {
  private readonly policy: OrchestratorPolicy;

  constructor(private readonly deps: OrchestratorDeps) {
    this.policy = { ...DEFAULT_POLICY, ...deps.policy };
  }

  async propose(request: UiRequest, target: ProposeTarget): Promise<ProposeResult> {
    const proposalId = newId("proposal");
    const requested = Math.min(
      Math.max(1, request.requestedCandidateCount),
      this.policy.maxCandidates
    );

    const references: ProviderReference[] = [];
    for (const ref of request.references) {
      references.push(await this.groundReference(ref));
    }

    const providerInput: ProviderInput = {
      instruction: request.instruction,
      targetContract: { ...target.contract },
      rendererSchemas: target.rendererSchemas,
      references,
      requestedCandidateCount: requested,
    };

    const deadline = Date.now() + this.policy.timeoutMs;
    let output;
    try {
      output = await this.withTimeout(providerInput, deadline);
    } catch {
      return {
        proposalId,
        status: "failed",
        candidates: [],
        failure: { code: "TIMEOUT", message: `provider exceeded the ${this.policy.timeoutMs}ms budget` },
      };
    }

    if (output.candidates.length === 0) {
      return {
        proposalId,
        status: "failed",
        candidates: [],
        failure: {
          code: "NO_CANDIDATES",
          message: output.degraded ?? "provider returned no candidates",
        },
      };
    }

    const candidates: ProposalCandidate[] = [];
    const rejected: string[] = [];

    for (const raw of output.candidates) {
      if (candidates.length >= this.policy.maxCandidates) break;

      // The provider cannot expand the authorized target: drop unauthorized
      // types outright (non-repairable, no retry).
      if (!target.contract.allowedRepresentations.includes(raw.type)) {
        rejected.push(`type "${raw.type}" is not an allowed representation`);
        continue;
      }

      const outcome = this.validateAndRepair(raw, target, proposalId, request, deadline);
      if (outcome.candidate) candidates.push(outcome.candidate);
      else rejected.push(...outcome.errors);
    }

    if (candidates.length === 0) {
      return {
        proposalId,
        status: "failed",
        candidates: [],
        failure: {
          code: "VALIDATION_FAILED",
          message: rejected.length > 0 ? rejected.join("; ") : "no candidate passed validation",
        },
      };
    }

    return { proposalId, status: "ready", candidates };
  }

  /**
   * Ground one design reference. With a loadReference dep the provider sees
   * the REAL observation content (text, anchor, commit, screenshot artifact)
   * instead of a placeholder id string; without one the historical
   * placeholder summaries are kept so existing behavior and tests hold.
   */
  private async groundReference(ref: DesignReference): Promise<ProviderReference> {
    if (ref.kind === "text") return { kind: "text", summary: ref.text };
    if (this.deps.loadReference) {
      try {
        const grounded = await this.deps.loadReference(ref);
        if (grounded) return grounded;
      } catch {
        // fall through to the placeholder below — grounding must never break
        // proposal generation.
      }
    }
    if (ref.kind === "history") return { kind: "history", summary: `history capture ${ref.captureId}` };
    return { kind: "image", summary: `image artifact ${ref.artifactId}` };
  }

  private async withTimeout(
    input: ProviderInput,
    deadline: number
  ): Promise<Awaited<ReturnType<ModelProvider["generate"]>>> {
    const remaining = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), Math.max(0, remaining));
    });
    try {
      return await Promise.race([this.deps.provider.generate(input), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private validateAndRepair(
    raw: ProviderCandidateLike,
    target: ProposeTarget,
    proposalId: string,
    request: UiRequest,
    deadline: number
  ): { candidate?: ProposalCandidate; errors: string[] } {
    const schemaFor = (type: string): Record<string, RendererPropertySchema> =>
      target.rendererSchemas.find((s) => s.id === type)?.propertySchema ?? {};

    let properties = { ...raw.properties };
    let report = this.runValidation(raw.type, properties, target, proposalId, request);
    let rounds = 0;

    const repairableCodes = new Set(["property_range", "schema_invalid", "presentation_invalid"]);
    while (!report.passed && rounds < this.policy.maxRepairRounds) {
      if (Date.now() > deadline) break;
      const repairable = report.errors.every((e) => repairableCodes.has(e.code));
      if (!repairable) break;
      properties = repairProperties(properties, schemaFor(raw.type));
      report = this.runValidation(raw.type, properties, target, proposalId, request);
      rounds += 1;
    }

    if (!report.passed) {
      return { errors: report.errors.map((e) => `${raw.type}: ${e.message}`) };
    }

    return {
      candidate: {
        candidateId: newId("candidate"),
        presentation: {
          type: raw.type,
          properties,
          dataBinding: target.contract.dataBinding,
          actions: [...target.contract.actions],
        },
        origin: { kind: raw.originKind, referenceIds: [] },
        validation: report,
        // Summary is synthesized from validated fields only. Provider
        // summaries (and instruction/reference echoes inside them) are an
        // untrusted prompt-injection surface (spec section 19: "instructions
        // embedded in references cannot bypass validation") and are never
        // propagated into accepted candidates.
        summary: `${raw.type} candidate (${raw.originKind})`,
      },
      errors: [],
    };
  }

  private runValidation(
    type: string,
    properties: Record<string, unknown>,
    target: ProposeTarget,
    proposalId: string,
    request: UiRequest
  ): ValidationReport {
    const envelope: Proposal = {
      schemaVersion: 1,
      proposalId,
      target: {
        entityId: target.entityId,
        entityVersionId: target.entityVersionId,
        scope: "entity",
        lockedEntityIds: [],
        batchTargets: [],
      },
      preconditions: {
        appBuildId: target.currentReadSet.appBuildId,
        contractDigest: target.currentReadSet.contractDigest,
        policyVersion: target.currentReadSet.policyVersion,
        preferenceRevision: target.currentReadSet.preferenceRevision,
      },
      presentation: {
        type,
        properties,
        dataBinding: target.contract.dataBinding,
        actions: [...target.contract.actions],
      },
      origin: { kind: "generated", referenceIds: [] },
    };
    return this.deps.validator.validate(envelope, target.currentReadSet, target.currentReadSet.policyVersion);
  }
}

/**
 * Repair round: nudge properties into schema ranges (clamp numbers to
 * min/max, coerce enums to a valid value). Non-repairable failures are not
 * retried by the caller.
 */
export function repairProperties(
  properties: Record<string, unknown>,
  schema: Record<string, RendererPropertySchema>
): Record<string, unknown> {
  const repaired: Record<string, unknown> = { ...properties };
  for (const [key, prop] of Object.entries(schema)) {
    const value = repaired[key];
    if (prop.type === "number" || prop.type === "integer") {
      let num = typeof value === "number" && !Number.isNaN(value) ? value : Number(value);
      if (Number.isNaN(num)) num = (prop.default as number | undefined) ?? prop.min ?? 0;
      if (prop.min !== undefined) num = Math.max(prop.min, num);
      if (prop.max !== undefined) num = Math.min(prop.max, num);
      repaired[key] = prop.type === "integer" ? Math.round(num) : num;
    } else if (prop.type === "enum" || prop.values) {
      const values = prop.values ?? [];
      if (values.length > 0 && !values.includes(value as string | number)) {
        repaired[key] =
          (prop.default as string | number | undefined) !== undefined &&
          values.includes(prop.default as string | number)
            ? prop.default
            : values[0];
      }
    } else if (prop.type === "boolean" && typeof value !== "boolean") {
      repaired[key] = (prop.default as boolean | undefined) ?? false;
    }
  }
  return repaired;
}
