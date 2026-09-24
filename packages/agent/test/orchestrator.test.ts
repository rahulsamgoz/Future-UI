import { describe, expect, it } from "vitest";
import {
  DeterministicProvider,
  OpenAICompatProvider,
  ProposalOrchestrator,
  SpecValidator,
  parseCandidates,
  type ProviderInput,
} from "../src/index.js";

const baseInput: ProviderInput = {
  instruction: "make it a compact grid",
  targetContract: {
    entityKey: "catalog.productChooser",
    allowedRepresentations: ["carousel@1", "grid@1", "table@1"],
    dataBinding: "catalog.products@1",
    actions: ["product.open@1", "cart.add@1"],
  },
  rendererSchemas: [
    {
      id: "carousel@1",
      propertySchema: {
        density: { type: "enum", values: ["comfortable", "compact"], default: "comfortable" },
        visibleCount: { type: "number", min: 1, max: 5, default: 3 },
      },
    },
    {
      id: "grid@1",
      propertySchema: {
        columns: { type: "number", min: 1, max: 4, default: 3 },
        density: { type: "enum", values: ["comfortable", "compact"], default: "comfortable" },
      },
    },
    {
      id: "table@1",
      propertySchema: {
        columns: { type: "number", min: 2, max: 6, default: 4 },
        density: { type: "enum", values: ["comfortable", "compact"], default: "comfortable" },
      },
    },
  ],
  references: [{ kind: "history", summary: "history capture cap_1 of the old grid" }],
  requestedCandidateCount: 4,
  seed: 42,
};

describe("DeterministicProvider", () => {
  it("is reproducible for the same seed", async () => {
    const provider = new DeterministicProvider();
    const a = await provider.generate(baseInput);
    const b = await provider.generate(baseInput);
    expect(a).toEqual(b);
  });

  it("produces distinct output for different seeds", async () => {
    const provider = new DeterministicProvider();
    const a = await provider.generate(baseInput);
    const b = await provider.generate({ ...baseInput, seed: 43 });
    expect(a).not.toEqual(b);
  });

  it("returns diverse representations when several are allowed", async () => {
    const provider = new DeterministicProvider();
    const output = await provider.generate({ ...baseInput, seed: undefined });
    const types = new Set(output.candidates.map((c) => c.type));
    expect(types.size).toBeGreaterThanOrEqual(2);
    expect(output.candidates).toHaveLength(4);
  });

  it("labels history-matching representations as recorded_history and others as adapted", async () => {
    const provider = new DeterministicProvider();
    const output = await provider.generate(baseInput);
    const grid = output.candidates.find((c) => c.type === "grid@1");
    const carousel = output.candidates.find((c) => c.type === "carousel@1");
    expect(grid?.originKind).toBe("recorded_history");
    expect(carousel?.originKind).toBe("historical_adaptation");
  });

  it("varies properties meaningfully rather than emitting duplicates", async () => {
    const provider = new DeterministicProvider();
    const output = await provider.generate({ ...baseInput, requestedCandidateCount: 6, seed: 7 });
    const grids = output.candidates.filter((c) => c.type === "grid@1").map((c) => JSON.stringify(c.properties));
    expect(new Set(grids).size).toBeGreaterThan(1);
  });
});

describe("OpenAICompatProvider", () => {
  it("never throws on network errors and degrades with a note", async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: "http://127.0.0.1:9", // nothing listens here
      apiKey: "k",
      model: "test-model",
      timeoutMs: 1500,
    });
    const output = await provider.generate(baseInput);
    expect(output.candidates).toEqual([]);
    expect(output.degraded).toBeTruthy();
  });

  it("parses fenced JSON and keeps only schema-conformant candidates", async () => {
    const fenced = '```json\n{"candidates":[{"type":"grid@1","properties":{"columns":33,"density":"compact"},"summary":"too wide"},{"type":"grid@1","properties":{"columns":3,"density":"compact"},"summary":"ok"},{"type":"banner@9","properties":{},"summary":"unauthorized"}]}\n```';
    const parsed = parseCandidates(fenced);
    expect(parsed).toHaveLength(3);
    const provider = new OpenAICompatProvider({ baseUrl: "http://localhost:1", apiKey: "k", model: "m" });
    // isSchemaConformant is exercised through generate; simulate via a stubbed fetch.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: fenced } }] }), { status: 200 })) as typeof fetch;
    try {
      const output = await provider.generate(baseInput);
      expect(output.candidates).toHaveLength(1);
      expect(output.candidates[0]!.properties).toEqual({ columns: 3, density: "compact" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function makeValidator(allowed = ["carousel@1", "grid@1", "table@1"]) {
  return new SpecValidator({
    allowedRepresentations: allowed,
    propertySchemas: Object.fromEntries(baseInput.rendererSchemas.map((s) => [s.id, s.propertySchema])),
    dataBinding: "catalog.products@1",
    allowedActions: ["product.open@1", "cart.add@1"],
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
      preferenceRevision: 7,
      entityVersions: { ent_1: "entver_1" },
    },
    contract: {
      entityKey: "catalog.productChooser",
      allowedRepresentations: ["carousel@1", "grid@1", "table@1"],
      dataBinding: "catalog.products@1",
      actions: ["product.open@1", "cart.add@1"],
    },
    rendererSchemas: baseInput.rendererSchemas,
  };
}

function makeRequest(overrides: Partial<Parameters<ProposalOrchestrator["propose"]>[0]> = {}) {
  return {
    requestId: "req_1",
    operation: "propose_change" as const,
    target: { kind: "selection" as const, entityId: "ent_1", runtimeInstanceId: "rt_1" },
    references: [],
    instruction: "grid please",
    appBuildId: "build_dev",
    requestedCandidateCount: 4,
    ...overrides,
  };
}

describe("ProposalOrchestrator", () => {
  it("keeps only candidates whose type is in the allowed representations", async () => {
    const rogueProvider = {
      id: "rogue",
      generate: async () => ({
        candidates: [
          { type: "banner@9", properties: {}, originKind: "generated" as const, summary: "not allowed" },
          { type: "grid@1", properties: { columns: 3, density: "compact" }, originKind: "generated" as const, summary: "ok" },
        ],
      }),
    };
    const orchestrator = new ProposalOrchestrator({ provider: rogueProvider, validator: makeValidator() });
    const result = await orchestrator.propose(makeRequest(), makeTarget());
    expect(result.status).toBe("ready");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.presentation).toMatchObject({ type: "grid@1" });
  });

  it("repairs schema-invalid property values by clamping to schema ranges", async () => {
    const sloppyProvider = {
      id: "sloppy",
      generate: async () => ({
        candidates: [
          {
            type: "grid@1",
            properties: { columns: 99, density: "cozy" },
            originKind: "generated" as const,
            summary: "needs repair",
          },
        ],
      }),
    };
    const orchestrator = new ProposalOrchestrator({ provider: sloppyProvider, validator: makeValidator() });
    const result = await orchestrator.propose(makeRequest(), makeTarget());
    expect(result.status).toBe("ready");
    expect(result.candidates[0]!.presentation).toMatchObject({ properties: { columns: 4, density: "comfortable" } });
  });

  it("fails with a structured failure when the provider returns nothing", async () => {
    const emptyProvider = {
      id: "empty",
      generate: async () => ({ candidates: [], degraded: "model unavailable" }),
    };
    const orchestrator = new ProposalOrchestrator({ provider: emptyProvider, validator: makeValidator() });
    const result = await orchestrator.propose(makeRequest(), makeTarget());
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("NO_CANDIDATES");
    expect(result.failure?.message).toContain("model unavailable");
  });

  it("fails on timeout", async () => {
    const slowProvider = {
      id: "slow",
      generate: () => new Promise(() => undefined), // never resolves
    };
    const orchestrator = new ProposalOrchestrator({
      provider: slowProvider,
      validator: makeValidator(),
      policy: { timeoutMs: 50 },
    });
    const result = await orchestrator.propose(makeRequest(), makeTarget());
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("TIMEOUT");
  });

  it("caps candidates at policy.maxCandidates and carries validation digests", async () => {
    const provider = new DeterministicProvider();
    const orchestrator = new ProposalOrchestrator({
      provider,
      validator: makeValidator(),
      policy: { maxCandidates: 2 },
    });
    const result = await orchestrator.propose(makeRequest({ requestedCandidateCount: 8 }), makeTarget());
    expect(result.candidates).toHaveLength(2);
    for (const c of result.candidates) {
      expect(c.validation.passed).toBe(true);
      expect(c.validation.specificationDigest).toMatch(/^[0-9a-f]{32}$/);
      expect(c.validation.validatorVersion).toBe("spec-validator@1");
    }
  });

  it("does not retry non-repairable failures (unauthorized actions)", async () => {
    let validateCalls = 0;
    const validator = {
      validate: (spec: unknown, readSet: Parameters<SpecValidator["validate"]>[1], policyVersion: number) => {
        validateCalls += 1;
        return makeValidator().validate(spec, readSet, policyVersion);
      },
    };
    const provider = {
      id: "p",
      generate: async () => ({
        candidates: [
          { type: "not-a-renderer", properties: {}, originKind: "generated" as const, summary: "bad" },
        ],
      }),
    };
    const orchestrator = new ProposalOrchestrator({ provider, validator });
    const result = await orchestrator.propose(makeRequest(), makeTarget());
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("VALIDATION_FAILED");
    expect(validateCalls).toBe(0); // dropped before validation: non-repairable
  });
});
