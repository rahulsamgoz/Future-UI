import { describe, expect, it } from "vitest";
import { ProposalOrchestrator, SpecValidator, type ProviderInput, type ProviderOutput } from "../src/index.js";

/**
 * Grounded-reference tests (audit fix): with a loadReference dep, history and
 * image references reach the provider as REAL content (observation text,
 * anchor, commit, screenshot artifact id) instead of placeholder id strings.
 * Without the dep, the historical placeholder summaries are preserved.
 */

const rendererSchemas = [
  {
    id: "grid@1",
    propertySchema: {
      columns: { type: "number", min: 1, max: 4, default: 3 },
      density: { type: "enum", values: ["comfortable", "compact"], default: "comfortable" },
    },
  },
  {
    id: "carousel@1",
    propertySchema: {
      density: { type: "enum", values: ["comfortable", "compact"], default: "comfortable" },
    },
  },
];

function makeValidator() {
  return new SpecValidator({
    allowedRepresentations: ["grid@1", "carousel@1"],
    propertySchemas: Object.fromEntries(rendererSchemas.map((s) => [s.id, s.propertySchema])),
    dataBinding: "catalog.products@1",
    allowedActions: ["product.open@1"],
  });
}

function makeTarget() {
  return {
    entityId: "ent_1",
    entityKey: "catalog.productChooser",
    entityVersionId: "entver_1",
    currentReadSet: {
      appBuildId: "build_dev",
      contractDigest: "contract_digest_current",
      policyVersion: 1,
      preferenceRevision: 0,
      entityVersions: { ent_1: "entver_1" },
    },
    contract: {
      entityKey: "catalog.productChooser",
      allowedRepresentations: ["grid@1", "carousel@1"],
      dataBinding: "catalog.products@1",
      actions: ["product.open@1"],
    },
    rendererSchemas,
  };
}

function recordingProvider(seen: ProviderInput[]): { generate(input: ProviderInput): Promise<ProviderOutput> } {
  return {
    async generate(input: ProviderInput) {
      seen.push(input);
      return {
        candidates: [
          { type: "grid@1", properties: { columns: 3, density: "compact" }, originKind: "generated", summary: "grid" },
          { type: "carousel@1", properties: { density: "compact" }, originKind: "generated", summary: "carousel" },
        ],
      };
    },
  };
}

const baseRequest = {
  requestId: "req_g1",
  operation: "propose_change" as const,
  target: { kind: "selection" as const, entityId: "ent_1", runtimeInstanceId: "rt_1" },
  references: [],
  instruction: "match the historical layout",
  appBuildId: "build_dev",
  requestedCandidateCount: 4,
};

describe("ProposalOrchestrator grounded references", () => {
  it("carries real observation content for history references when loadReference is injected", async () => {
    const seen: ProviderInput[] = [];
    const orchestrator = new ProposalOrchestrator({
      provider: recordingProvider(seen),
      validator: makeValidator(),
      loadReference: async (ref) => {
        if (ref.kind !== "history") return null;
        return {
          kind: "history",
          summary: "captured_at_build · 1a2b3c4d · catalog.productChooser.grid: Sort by price, 24 products",
          text: "Sort by price, 24 products",
          artifactId: "art_shot_1",
        };
      },
    });

    const result = await orchestrator.propose(
      { ...baseRequest, references: [{ kind: "history", captureId: "cap_1" }] },
      makeTarget()
    );
    expect(result.status).toBe("ready");
    expect(seen).toHaveLength(1);
    const ref = seen[0]!.references[0]!;
    expect(ref.kind).toBe("history");
    expect(ref.summary).toContain("Sort by price, 24 products");
    expect(ref.summary).toContain("catalog.productChooser.grid");
    expect(ref.summary).toContain("1a2b3c4d");
    expect(ref.text).toBe("Sort by price, 24 products");
    expect(ref.artifactId).toBe("art_shot_1");
  });

  it("keeps the placeholder summary when no loadReference is configured", async () => {
    const seen: ProviderInput[] = [];
    const orchestrator = new ProposalOrchestrator({
      provider: recordingProvider(seen),
      validator: makeValidator(),
    });
    await orchestrator.propose(
      {
        ...baseRequest,
        references: [
          { kind: "history", captureId: "cap_1" },
          { kind: "image", artifactId: "art_img_9" },
        ],
      },
      makeTarget()
    );
    expect(seen[0]!.references[0]!.summary).toBe("history capture cap_1");
    expect(seen[0]!.references[1]!.summary).toBe("image artifact art_img_9");
  });

  it("falls back to the placeholder when loadReference returns null or throws", async () => {
    const seen: ProviderInput[] = [];
    const orchestrator = new ProposalOrchestrator({
      provider: recordingProvider(seen),
      validator: makeValidator(),
      loadReference: async () => {
        throw new Error("db unavailable");
      },
    });
    await expect(
      orchestrator.propose({ ...baseRequest, references: [{ kind: "history", captureId: "cap_x" }] }, makeTarget())
    ).resolves.toMatchObject({ status: "ready" });
    expect(seen[0]!.references[0]!.summary).toBe("history capture cap_x");

    const seen2: ProviderInput[] = [];
    const nullLoader = new ProposalOrchestrator({
      provider: recordingProvider(seen2),
      validator: makeValidator(),
      loadReference: async () => null,
    });
    await nullLoader.propose(
      { ...baseRequest, references: [{ kind: "image", artifactId: "art_missing" }] },
      makeTarget()
    );
    expect(seen2[0]!.references[0]!.summary).toBe("image artifact art_missing");
  });

  it("passes text references through unchanged and grounds image refs with their artifact id", async () => {
    const seen: ProviderInput[] = [];
    const orchestrator = new ProposalOrchestrator({
      provider: recordingProvider(seen),
      validator: makeValidator(),
      loadReference: async (ref) =>
        ref.kind === "image" ? { kind: "image", summary: `design image artifact ${ref.artifactId}`, artifactId: ref.artifactId } : null,
    });
    await orchestrator.propose(
      {
        ...baseRequest,
        references: [
          { kind: "text", text: "prefer denser grids" },
          { kind: "image", artifactId: "art_img_1" },
        ],
      },
      makeTarget()
    );
    expect(seen[0]!.references[0]).toEqual({ kind: "text", summary: "prefer denser grids" });
    expect(seen[0]!.references[1]!.artifactId).toBe("art_img_1");
  });
});
