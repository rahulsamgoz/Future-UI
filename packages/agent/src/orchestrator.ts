/**
 * Proposal orchestration (spec section 8, request-to-application flow):
 * generate → envelope → validate → bounded repair rounds → ready/failed.
 * The provider cannot expand the authorized target or capabilities.
 */
import {
  newId,
  type DesignReference,
  type EntityContract,
  type LayoutNode,
  type PageContract,
  type Proposal,
  type ProposalCandidate,
  type ProposalStatus,
  type TargetReadSet,
  type UiRequest,
  type ValidationReport,
} from "@ui-intelligence/protocol";
import type { ModelProvider, ProviderInput, ProviderReference, RendererPropertySchema, RendererSchema } from "./provider.js";
import { referenceHasImageContent } from "./provider.js";

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
  /**
   * Honest degradation note (audit finding 4): set when image references
   * could not reach the provider (no declared vision capability, or the
   * grounded reference carried no usable image content). Image references
   * are never silently dropped.
   */
  degraded?: string;
};

export type ProposePageTarget = {
  pageKey: string;
  pageContract: PageContract;
  currentReadSet: TargetReadSet;
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
  /**
   * Page-scope layout validator (audit finding 4). Typically runtime-core's
   * ProposalValidator.validatePageLayout. When absent, page-scope generation
   * fails closed (candidates are rejected with a clear message) — provider
   * output is never trusted without validation.
   */
  validatePageLayout?: (
    root: LayoutNode,
    pageContract: PageContract,
    entityContracts: Map<string, EntityContract>,
    readSet: TargetReadSet,
    policyVersion: number
  ) => Promise<ValidationReport>;
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

/**
 * Property schemas of the three approved page layouts (spec section 7),
 * matching packages/renderers pageLayouts.tsx. Page candidates are prompted
 * and schema-checked against these.
 */
export const PAGE_LAYOUT_RENDERER_SCHEMAS: RendererSchema[] = [
  {
    id: "stack@1",
    propertySchema: {
      gap: { type: "enum", values: ["none", "sm", "md", "lg"], default: "md" },
    },
  },
  {
    id: "grid@1",
    propertySchema: {
      columns: { type: "number", min: 1, max: 4, default: 2 },
    },
  },
  {
    id: "split@1",
    propertySchema: {
      ratio: { type: "enum", values: ["50-50", "33-67", "67-33"], default: "50-50" },
      orientation: { type: "enum", values: ["horizontal", "vertical"], default: "horizontal" },
    },
  },
];

/**
 * Degradation note for image references (audit finding 4): when the provider
 * does not declare vision, image references cannot reach the model and that
 * MUST surface in the output — never a silent drop. When vision IS declared
 * but no grounded reference carries usable image content, say so too.
 */
export function imageReferenceNote(
  references: ProviderReference[],
  visionCapable: boolean
): { degraded: string } | undefined {
  // Count every reference the vision path treats as an image input: image
  // refs always (an image reference without grounded content is still a lost
  // image), and history refs when they carry a grounded screenshot — the
  // provider attaches both kinds (closure review: history references with
  // screenshot bytes were previously dropped from this count).
  const imageRefs = references.filter(
    (r) => r.kind === "image" || (r.kind === "history" && referenceHasImageContent(r))
  );
  if (imageRefs.length === 0) return undefined;
  if (!visionCapable) {
    return {
      degraded: `${imageRefs.length} image reference(s) ignored: provider not vision-capable`,
    };
  }
  const usable = imageRefs.some(referenceHasImageContent);
  if (!usable) {
    return {
      degraded: `${imageRefs.length} image reference(s) carried no usable image content (no bytes or fetchable url)`,
    };
  }
  return undefined;
}

/**
 * Minimal entity contracts for page-layout validation: regions reference
 * entityKeys declared by the page contract's slots; validatePageLayout only
 * checks membership.
 */
export function entityContractsForPage(page: PageContract): Map<string, EntityContract> {
  return new Map(
    page.slots.map((slot) => [
      slot.entityKey,
      {
        entityKey: slot.entityKey,
        contractVersion: page.contractVersion,
        dataBinding: `page:${page.pageKey}:${slot.slotId}`,
        allowedRepresentations:
          slot.compatibleRenderers.length > 0 ? [...slot.compatibleRenderers] : ["any"],
        actions: [],
        requiredFields: [],
        stateFields: [],
        constraints: { preserveActions: true, preservePriceVisibility: false },
      },
    ])
  );
}

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
    const degraded = imageReferenceNote(references, this.deps.provider.capabilities?.vision === true);

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
        ...degraded,
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
        ...degraded,
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
        ...degraded,
      };
    }

    return { proposalId, status: "ready", candidates, ...degraded };
  }

  /**
   * Page-scope generation (audit finding 4): the provider proposes page
   * LAYOUT candidates (root layout type + properties within the page
   * contract's allowedLayouts); the orchestrator composes the root with one
   * region per declared slot and validates the whole tree against the page
   * contract (allowedLayouts, slots, maxDepth/maxNodes) with the injected
   * page-layout validator (runtime-core's ProposalValidator.validatePageLayout).
   * The provider cannot expand the authorized target: layouts outside
   * allowedLayouts and candidates failing validation are rejected.
   */
  async proposePage(request: UiRequest, target: ProposePageTarget): Promise<ProposeResult> {
    const proposalId = newId("proposal");
    const requested = Math.min(
      Math.max(1, request.requestedCandidateCount),
      this.policy.maxCandidates
    );
    const page = target.pageContract;

    const references: ProviderReference[] = [];
    for (const ref of request.references) {
      references.push(await this.groundReference(ref));
    }
    const degraded = imageReferenceNote(references, this.deps.provider.capabilities?.vision === true);

    const providerInput: ProviderInput = {
      instruction: request.instruction,
      targetContract: {
        entityKey: page.pageKey,
        allowedRepresentations: [...page.allowedLayouts],
        dataBinding: `page:${page.pageKey}`,
        actions: [],
      },
      rendererSchemas: PAGE_LAYOUT_RENDERER_SCHEMAS.filter((s) =>
        (page.allowedLayouts as string[]).includes(s.id)
      ),
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
        ...degraded,
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
        ...degraded,
      };
    }

    const candidates: ProposalCandidate[] = [];
    const rejected: string[] = [];

    for (const raw of output.candidates) {
      if (candidates.length >= this.policy.maxCandidates) break;

      if (!(page.allowedLayouts as string[]).includes(raw.type)) {
        rejected.push(`layout type "${raw.type}" is not allowed by page "${page.pageKey}"`);
        continue;
      }
      if (!this.deps.validatePageLayout) {
        rejected.push(`"${raw.type}": no page layout validator configured — candidate rejected (fail closed)`);
        continue;
      }
      const root = this.layoutRootFor(raw, page);
      const report = await this.deps.validatePageLayout(
        root,
        page,
        entityContractsForPage(page),
        target.currentReadSet,
        target.currentReadSet.policyVersion
      );
      if (!report.passed) {
        rejected.push(...report.errors.map((e) => `${raw.type}: ${e.message}`));
        continue;
      }
      candidates.push({
        candidateId: newId("candidate"),
        presentation: root,
        origin: { kind: raw.originKind, referenceIds: [] },
        validation: report,
        summary: `${raw.type} page layout candidate (${raw.originKind})`,
      });
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
        ...degraded,
      };
    }

    return { proposalId, status: "ready", candidates, ...degraded };
  }

  /** Compose the provider's root layout type + properties with one region per declared slot. */
  private layoutRootFor(raw: ProviderCandidateLike, page: PageContract): LayoutNode {
    return {
      kind: "layout",
      nodeId: "root",
      type: raw.type as "stack@1" | "grid@1" | "split@1",
      properties: raw.properties as Record<string, import("@ui-intelligence/protocol").JsonValue>,
      children: page.slots.map((slot) => ({
        kind: "region" as const,
        nodeId: `region_${slot.slotId}`,
        slotId: slot.slotId,
        entityId: slot.entityKey,
      })),
    };
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
