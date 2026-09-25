/**
 * Audit finding 4 regressions: image references must reach vision providers
 * (bytes-first data URLs, imageUrl fallback), degraded honesty when the
 * provider cannot see images, and page-scope layout generation validated
 * against the page contract with ProposalValidator.validatePageLayout.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  OpenAICompatProvider,
  ProposalOrchestrator,
  SpecValidator,
  type ProviderInput,
} from "../src/index.js";
import { imageReferenceNote } from "../src/orchestrator.js";
import { ProposalValidator, RendererRegistry } from "@ui-intelligence/runtime-core";
import type { PageContract, TargetReadSet, UiRequest, ValidationReport } from "@ui-intelligence/protocol";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const entityInput: ProviderInput = {
  instruction: "match this design",
  targetContract: {
    entityKey: "catalog.productChooser",
    allowedRepresentations: ["grid@1"],
    dataBinding: "catalog.products@1",
    actions: ["product.open@1"],
  },
  rendererSchemas: [{ id: "grid@1", propertySchema: { columns: { type: "number", min: 1, max: 4, default: 3 } } }],
  references: [
    { kind: "image", summary: "design image artifact art_1", artifactId: "art_1", imageBytes: PNG_BYTES, imageMediaType: "image/png" },
  ],
  requestedCandidateCount: 2,
};

const MODEL_REPLY = {
  choices: [
    { message: { content: JSON.stringify({ candidates: [{ type: "grid@1", properties: { columns: 3 }, summary: "grid" }] }) } },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAICompatProvider vision input (audit finding 4)", () => {
  it("attaches grounded imageBytes as a base64 data URL image part", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string));
        return jsonResponse(200, MODEL_REPLY);
      })
    );
    const provider = new OpenAICompatProvider({
      baseUrl: "https://model.example/v1",
      apiKey: "k",
      model: "vision-model",
      capabilities: { vision: true },
    });
    expect(provider.capabilities?.vision).toBe(true);

    const output = await provider.generate(entityInput);
    expect(output.candidates).toHaveLength(1);

    const content = (bodies[0] as { messages: Array<{ content: unknown }> }).messages[1]!.content as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    const imagePart = content.find((part) => part.type === "image_url");
    expect(imagePart).toBeTruthy();
    // Bytes-first: a data URL, so the provider never fetches anything.
    expect(imagePart!.image_url!.url).toMatch(/^data:image\/png;base64,/);
    expect(atob(imagePart!.image_url!.url.split(",")[1]!)).toBe(String.fromCharCode(...PNG_BYTES));
    // The grounded text summary is still present alongside the image.
    const textPart = content.find((part) => part.type === "text");
    expect((textPart as { text: string }).text).toContain("design image artifact art_1");
  });

  it("falls back to imageUrl only when bytes are absent", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string));
        return jsonResponse(200, MODEL_REPLY);
      })
    );
    const provider = new OpenAICompatProvider({
      baseUrl: "https://model.example/v1",
      apiKey: "k",
      model: "vision-model",
      capabilities: { vision: true },
    });
    await provider.generate({
      ...entityInput,
      references: [{ kind: "image", summary: "img", artifactId: "art_1", imageUrl: "https://api.example/v1/artifacts/art_1/raw?projectId=p1" }],
    });
    const content = (bodies[0] as { messages: Array<{ content: unknown }> }).messages[1]!.content as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    expect(content.find((p) => p.type === "image_url")!.image_url!.url).toBe(
      "https://api.example/v1/artifacts/art_1/raw?projectId=p1"
    );
  });

  it("keeps a text-only request when vision is not declared", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string));
        return jsonResponse(200, MODEL_REPLY);
      })
    );
    const provider = new OpenAICompatProvider({ baseUrl: "https://model.example/v1", apiKey: "k", model: "text-only" });
    expect(provider.capabilities?.vision).toBeUndefined();
    await provider.generate(entityInput);
    const content = (bodies[0] as { messages: Array<{ content: unknown }> }).messages[1]!.content;
    expect(typeof content).toBe("string");
  });
});

describe("orchestrator image-reference honesty (audit finding 4)", () => {
  const passingValidator = {
    validate: (spec: unknown, readSet: TargetReadSet, policyVersion: number): ValidationReport => ({
      schemaVersion: 1,
      validatorVersion: "stub@1",
      policyRevision: policyVersion,
      targetReadSet: readSet,
      checkedInvariants: [],
      unsupportedChecks: [],
      passed: true,
      errors: [],
      specificationDigest: "sha256:stub",
    }),
  };

  const provider: ProviderInput = {
    instruction: "",
    targetContract: { entityKey: "e", allowedRepresentations: ["grid@1"], dataBinding: "b", actions: [] },
    rendererSchemas: [{ id: "grid@1", propertySchema: {} }],
    references: [],
    requestedCandidateCount: 1,
  };

  const request: UiRequest = {
    requestId: "req_1",
    operation: "propose_change",
    target: { kind: "selection", entityId: "e", runtimeInstanceId: "rt_1" },
    references: [{ kind: "image", artifactId: "art_1" }],
    instruction: "use this picture",
    appBuildId: "build_1",
    requestedCandidateCount: 1,
  };

  const target = {
    entityId: "e",
    entityKey: "e",
    entityVersionId: "ev_1",
    currentReadSet: {
      appBuildId: "build_1",
      contractDigest: "sha256:contract",
      policyVersion: 1,
      preferenceRevision: 0,
      entityVersions: {},
    },
    contract: { entityKey: "e", allowedRepresentations: ["grid@1"], dataBinding: "b", actions: [] },
    rendererSchemas: provider.rendererSchemas,
  };

  it("surfaces a degraded note when the provider is not vision-capable (no crash)", async () => {
    const textProvider = {
      id: "text-only",
      generate: async () => ({ candidates: [{ type: "grid@1", properties: { columns: 2 }, originKind: "generated" as const, summary: "s" }] }),
    };
    const orchestrator = new ProposalOrchestrator({ provider: textProvider, validator: passingValidator });
    const result = await orchestrator.propose(request, target);
    expect(result.status).toBe("ready");
    expect(result.degraded).toContain("1 image reference(s) ignored: provider not vision-capable");
  });

  it("reports missing image content when vision is declared but no bytes/url were grounded", async () => {
    const visionProvider = new OpenAICompatProvider({
      baseUrl: "https://model.example/v1",
      apiKey: "k",
      model: "vision",
      capabilities: { vision: true },
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, MODEL_REPLY)));
    const orchestrator = new ProposalOrchestrator({ provider: visionProvider, validator: passingValidator });
    const result = await orchestrator.propose(request, target);
    expect(result.status).toBe("ready");
    expect(result.degraded).toContain("1 image reference(s) carried no usable image content");
  });

  it("emits no note when there are no image references", () => {
    expect(imageReferenceNote([{ kind: "text", summary: "s" }], false)).toBeUndefined();
    expect(imageReferenceNote([{ kind: "image", summary: "s", imageBytes: PNG_BYTES }], true)).toBeUndefined();
  });

  it("attaches grounded screenshot bytes for history references when vision is on", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string));
        return jsonResponse(200, MODEL_REPLY);
      })
    );
    const visionProvider = new OpenAICompatProvider({
      baseUrl: "https://model.example/v1",
      apiKey: "k",
      model: "vision",
      capabilities: { vision: true },
    });
    await visionProvider.generate({
      ...entityInput,
      references: [
        { kind: "history", summary: "capture cap_1", artifactId: "art_shot", imageBytes: PNG_BYTES, imageMediaType: "image/png" },
      ],
    });
    const content = (bodies[0] as { messages: Array<{ content: unknown }> }).messages[1]!.content as Array<{ type: string }>;
    expect(content.some((p) => p.type === "image_url")).toBe(true);
  });
});

describe("orchestrator page-scope generation (audit finding 4)", () => {
  const pageContract: PageContract = {
    pageKey: "catalog",
    contractVersion: 1,
    slots: [
      { slotId: "sort", entityKey: "catalog.sortControl", required: true, locked: false, repeatable: false, compatibleRenderers: ["sort.select@1"] },
      { slotId: "chooser", entityKey: "catalog.productChooser", required: true, locked: false, repeatable: false, compatibleRenderers: [] },
      { slotId: "related", entityKey: "catalog.relatedProducts", required: false, locked: false, repeatable: false, compatibleRenderers: [] },
    ],
    allowedLayouts: ["stack@1", "split@1"],
    maxDepth: 4,
    maxNodes: 16,
  };

  const readSet: TargetReadSet = {
    appBuildId: "build_1",
    contractDigest: "sha256:contract",
    policyVersion: 1,
    preferenceRevision: 0,
    entityVersions: {},
  };

  const pageRequest: UiRequest = {
    requestId: "req_page_1",
    operation: "propose_change",
    target: { kind: "page", pageKey: "catalog", pageContract },
    references: [],
    instruction: "split the page",
    appBuildId: "build_1",
    requestedCandidateCount: 3,
  };

  const pageValidator = new ProposalValidator(new RendererRegistry());

  function makePageOrchestrator(candidateTypes: Array<{ type: string; properties: Record<string, unknown> }>) {
    const stub = {
      id: "page-stub",
      generate: async () => ({
        candidates: candidateTypes.map((c) => ({ ...c, originKind: "generated" as const, summary: "layout" })),
      }),
    };
    return new ProposalOrchestrator({
      provider: stub,
      validator: new SpecValidator({
        allowedRepresentations: [...pageContract.allowedLayouts],
        propertySchemas: {},
        dataBinding: "page:catalog",
        allowedActions: [],
      }),
      validatePageLayout: (root, contract, entityContracts, rs, policyVersion) =>
        pageValidator.validatePageLayout(root, contract, entityContracts, rs, policyVersion),
    });
  }

  it("produces validated layout candidates constrained by the page contract", async () => {
    const orchestrator = makePageOrchestrator([
      { type: "split@1", properties: { ratio: "50-50", orientation: "horizontal" } },
      { type: "stack@1", properties: { gap: "md" } },
    ]);
    const result = await orchestrator.proposePage(pageRequest, {
      pageKey: "catalog",
      pageContract,
      currentReadSet: readSet,
    });
    expect(result.status).toBe("ready");
    expect(result.candidates).toHaveLength(2);

    for (const candidate of result.candidates) {
      const layout = candidate.presentation as { kind: string; type: string; children: Array<{ kind: string; slotId: string; entityId: string }> };
      expect(layout.kind).toBe("layout");
      expect(candidate.validation.passed).toBe(true);
      expect(candidate.validation.targetReadSet).toEqual(readSet);
      // Every declared slot is present as a region with its entity.
      const slotIds = layout.children.filter((c) => c.kind === "region").map((c) => c.slotId);
      expect(slotIds).toEqual(["sort", "chooser", "related"]);
      expect(layout.children.every((c) => c.entityId.length > 0)).toBe(true);
    }
    expect(result.candidates.map((c) => (c.presentation as { type: string }).type)).toEqual(["split@1", "stack@1"]);
  });

  it("rejects layout types outside allowedLayouts (provider cannot expand the target)", async () => {
    const orchestrator = makePageOrchestrator([{ type: "grid@1", properties: { columns: 2 } }]);
    const result = await orchestrator.proposePage(pageRequest, {
      pageKey: "catalog",
      pageContract,
      currentReadSet: readSet,
    });
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("VALIDATION_FAILED");
    expect(result.failure?.message).toContain('layout type "grid@1" is not allowed by page "catalog"');
  });

  it("fails closed when no page layout validator is configured", async () => {
    const stub = {
      id: "page-stub",
      generate: async () => ({
        candidates: [{ type: "stack@1", properties: {}, originKind: "generated" as const, summary: "layout" }],
      }),
    };
    const orchestrator = new ProposalOrchestrator({
      provider: stub,
      validator: { validate: () => ({}) as ValidationReport },
    });
    const result = await orchestrator.proposePage(pageRequest, {
      pageKey: "catalog",
      pageContract,
      currentReadSet: readSet,
    });
    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("no page layout validator configured");
  });

  it("rejects layouts that exceed the page contract's node budget", async () => {
    const tiny = { ...pageContract, maxNodes: 3 }; // 1 root + 3 regions > 3
    const orchestrator = makePageOrchestrator([{ type: "stack@1", properties: {} }]);
    const result = await orchestrator.proposePage(pageRequest, {
      pageKey: "catalog",
      pageContract: tiny,
      currentReadSet: readSet,
    });
    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("exceeding page maximum 3");
  });

  it("surfaces image-reference degradation notes on the page path too", async () => {
    const stub = {
      id: "page-stub",
      capabilities: undefined,
      generate: async () => ({
        candidates: [{ type: "stack@1", properties: {}, originKind: "generated" as const, summary: "layout" }],
      }),
    };
    const orchestrator = new ProposalOrchestrator({
      provider: stub,
      validator: { validate: () => ({}) as ValidationReport },
      validatePageLayout: (root, contract, entityContracts, rs, policyVersion) =>
        pageValidator.validatePageLayout(root, contract, entityContracts, rs, policyVersion),
    });
    const result = await orchestrator.proposePage(
      { ...pageRequest, references: [{ kind: "image", artifactId: "art_1" }] },
      { pageKey: "catalog", pageContract, currentReadSet: readSet }
    );
    expect(result.degraded).toContain("provider not vision-capable");
  });
});
