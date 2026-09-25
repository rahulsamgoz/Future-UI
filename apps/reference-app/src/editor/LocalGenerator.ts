import type {
  EntityContract,
  JsonValue,
  LayoutNode,
  PageContract,
  Presentation,
  TargetReadSet,
  ValidationReport,
} from "@ui-intelligence/protocol";
import type { RendererDescriptor, RuntimeKernel } from "@ui-intelligence/runtime-core";
import { ProposalValidator } from "@ui-intelligence/runtime-core";
import { DeterministicProvider } from "@ui-intelligence/agent";
import type { RuntimeInstanceInfo } from "@ui-intelligence/runtime-core";

/**
 * Build ONE validated, content-digested candidate for a specific
 * representation (used by the batch path so it goes through the same
 * validation as generated candidates — never bypass the validator).
 * `preferenceRevision` is the revision the live view displayed at GENERATION
 * time (audit finding 5): the candidate carries it as its read set and the
 * acceptance path revalidates against it instead of a fresh read.
 */
export async function validatedCandidate(
  kernel: RuntimeKernel,
  instance: RuntimeInstanceInfo,
  representation: string,
  properties: Record<string, JsonValue>,
  originKind: LocalCandidate["originKind"] = "generated",
  summary = `${representation} variant`,
  preferenceRevision = 0
): Promise<LocalCandidate | null> {
  const contract = instance.contract;
  if (!contract.allowedRepresentations.includes(representation)) return null;
  const descriptor = kernel.renderers.get(representation);
  if (!descriptor) return null;
  const validator = new ProposalValidator(kernel.renderers);
  const readSet = await kernel.currentReadSet(contract.entityKey, 1, preferenceRevision);
  const presentation: Presentation = {
    type: representation,
    properties,
    dataBinding: contract.dataBinding,
    actions: contract.actions,
  };
  const report = await validator.validatePresentation(presentation, contract, readSet, 1);
  if (!report.passed) return null;
  return {
    candidateId: `cand_${representation}`,
    representation,
    properties,
    originKind,
    summary,
    validation: report,
    digest: report.specificationDigest,
    requiredRendererVersions: { [descriptor.id]: descriptor.version },
    contractVersion: contract.contractVersion,
    dataBindingId: contract.dataBinding,
    actionIds: contract.actions,
    readSet,
  };
}

export type LocalCandidate = {
  candidateId: string;
  representation: string;
  properties: Record<string, JsonValue>;
  originKind: "generated" | "historical_adaptation" | "recorded_history";
  summary: string;
  validation: ValidationReport;
  digest: string;
  requiredRendererVersions: Record<string, number>;
  contractVersion: number;
  dataBindingId: string;
  actionIds: string[];
  /**
   * The read set the candidate was GENERATED against (audit finding 5):
   * acceptance revalidates against THIS revision, so an old candidate whose
   * target moved returns a conflict instead of overwriting a newer write.
   */
  readSet: TargetReadSet;
  /** True when the candidate came from the offline local fallback, not the API. */
  offline?: boolean;
};

/**
 * Local candidate generation. Applying an already-cached, compatible variant
 * (and generating deterministic alternatives) works without the AI service;
 * fresh remote generation and uncached historical retrieval need the API.
 */
export class LocalGenerator {
  private provider = new DeterministicProvider();

  constructor(private kernel: RuntimeKernel) {}

  private rendererSchemas(contract: EntityContract): Array<{ id: string; propertySchema: RendererDescriptor["propertySchema"] }> {
    return contract.allowedRepresentations
      .map((id) => this.kernel.renderers.get(id))
      .filter((d): d is RendererDescriptor => Boolean(d))
      .map((d) => ({ id: d.id, propertySchema: d.propertySchema }));
  }

  /**
   * Generate up to `count` diverse, validated candidates for an entity target.
   * `preferenceRevision` is what the live view displayed at generation time
   * (audit finding 5) and is carried on every candidate as its read set.
   */
  async candidatesFor(
    instance: RuntimeInstanceInfo,
    instruction: string,
    references: Array<{ kind: "history" | "image" | "text"; summary: string }> = [],
    count = 4,
    preferenceRevision = 0
  ): Promise<LocalCandidate[]> {
    const contract = instance.contract;
    const output = await this.provider.generate({
      instruction: instruction || `Alternatives for ${contract.entityKey}`,
      targetContract: {
        entityKey: contract.entityKey,
        allowedRepresentations: contract.allowedRepresentations,
        dataBinding: contract.dataBinding,
        actions: contract.actions,
      },
      rendererSchemas: this.rendererSchemas(contract),
      references,
      requestedCandidateCount: count,
      seed: 42,
    });

    const validator = new ProposalValidator(this.kernel.renderers);
    const readSet = await this.kernel.currentReadSet(contract.entityKey, 1, preferenceRevision);
    const candidates: LocalCandidate[] = [];
    for (const c of output.candidates) {
      const presentation: Presentation = {
        type: c.type,
        properties: c.properties,
        dataBinding: contract.dataBinding,
        actions: contract.actions,
      };
      const report = await validator.validatePresentation(presentation, contract, readSet, 1);
      if (!report.passed) continue;
      const descriptor = this.kernel.renderers.get(c.type);
      candidates.push({
        candidateId: `cand_${candidates.length + 1}`,
        representation: c.type,
        properties: c.properties as Record<string, JsonValue>,
        originKind: c.originKind,
        summary: c.summary,
        validation: report,
        digest: report.specificationDigest,
        requiredRendererVersions: descriptor ? { [descriptor.id]: descriptor.version } : {},
        contractVersion: contract.contractVersion,
        dataBindingId: contract.dataBinding,
        actionIds: contract.actions,
        readSet,
      });
    }
    return candidates;
  }

  /**
   * Generate validated page layout candidates respecting locked/required
   * slots. `preferenceRevision` is what the live view displayed at generation
   * time (audit finding 5); each result carries its generation read set.
   */
  async layoutCandidatesFor(
    pageContract: PageContract,
    entityContracts: Map<string, EntityContract>,
    currentLayout: LayoutNode,
    count = 3,
    preferenceRevision = 0
  ): Promise<Array<{ layout: LayoutNode; validation: ValidationReport; readSet: TargetReadSet }>> {
    const layouts: LayoutNode[] = [];
    const regions = (n: LayoutNode): Array<Extract<LayoutNode, { kind: "region" }>> =>
      n.kind === "region" ? [n] : n.children.flatMap(regions);
    const existing = regions(currentLayout);

    // Deterministic layout variants from the allowed set.
    for (const type of pageContract.allowedLayouts.slice(0, count)) {
      layouts.push({
        kind: "layout",
        nodeId: "root",
        type,
        properties: type === "grid@1" ? { columns: 2 } : type === "split@1" ? { ratio: "50-50", orientation: "horizontal" } : { gap: "md", direction: "vertical" },
        children: existing,
      });
    }
    // A grid variant with different column count.
    if (pageContract.allowedLayouts.includes("grid@1")) {
      layouts.push({
        kind: "layout",
        nodeId: "root",
        type: "grid@1",
        properties: { columns: 3 },
        children: existing,
      });
    }

    const validator = new ProposalValidator(this.kernel.renderers);
    const readSet = await this.kernel.currentReadSet(pageContract.pageKey, 1, preferenceRevision);
    const out: Array<{ layout: LayoutNode; validation: ValidationReport; readSet: TargetReadSet }> = [];
    for (const layout of layouts) {
      const validation = await validator.validatePageLayout(layout, pageContract, entityContracts, readSet, 1);
      out.push({ layout, validation, readSet });
    }
    return out;
  }
}
