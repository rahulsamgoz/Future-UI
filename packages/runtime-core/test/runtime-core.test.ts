import { describe, expect, it } from "vitest";
import {
  InstanceRegistry,
  OperationCoordinator,
  ProposalValidator,
  RendererRegistry,
  RuntimeKernel,
  UiIntelligenceError,
} from "../src/index.js";
import type {
  ApplicationSpecification,
  RendererDescriptor,
  RendererSwitcher,
  RuntimeInstanceInfo,
} from "../src/index.js";
import {
  MemoryPreferenceStore,
} from "../../preferences/src/index.js";
import {
  UiIntelligenceError,
} from "@ui-intelligence/protocol";
import type {
  EntityContract,
  JsonValue,
  LayoutNode,
  PageContract,
  PreferenceKey,
  Proposal,
} from "@ui-intelligence/protocol";

const contract: EntityContract = {
  entityKey: "catalog.productChooser",
  contractVersion: 1,
  dataBinding: "catalog.products@1",
  allowedRepresentations: ["carousel@1", "grid@1", "table@1"],
  actions: ["product.open@1", "cart.add@1"],
  requiredFields: ["product.id", "product.name", "product.price"],
  stateFields: ["selectedProductId", "sortOrder", "filters"],
  constraints: { preserveActions: true, preservePriceVisibility: true, maximumColumns: 4 },
};

const otherContract: EntityContract = {
  ...contract,
  entityKey: "catalog.filters",
  requiredFields: [],
};

const gridDescriptor: RendererDescriptor = {
  id: "grid@1",
  version: 1,
  propertySchema: {
    columns: { type: "number", min: 1, max: 6, default: 3 },
    density: { type: "enum", values: ["compact", "comfortable"], default: "comfortable" },
    showDividers: { type: "boolean", default: true },
  },
  rendersFields: ["product.id", "product.name", "product.price"],
  compatibleWith: (c) => c.allowedRepresentations.includes("grid@1"),
};

const readSet = (over: Partial<Parameters<ProposalValidator["validatePresentation"]>[2]> = {}) => ({
  appBuildId: "build_1",
  contractDigest: "digest_1",
  policyVersion: 1,
  preferenceRevision: 0,
  entityVersions: { "catalog.productChooser": "catalog.productChooser@1" },
  ...over,
});

const pageContract: PageContract = {
  pageKey: "catalog",
  contractVersion: 1,
  slots: [
    { slotId: "hero", entityKey: "catalog.hero", required: true, locked: false, repeatable: false, compatibleRenderers: [] },
    { slotId: "products", entityKey: "catalog.productChooser", required: true, locked: true, repeatable: true, compatibleRenderers: ["grid@1", "table@1"] },
    { slotId: "sidebar", entityKey: "catalog.filters", required: false, locked: false, repeatable: false, compatibleRenderers: [] },
  ],
  allowedLayouts: ["stack@1", "grid@1", "split@1"],
  maxDepth: 3,
  maxNodes: 10,
};

const heroContract: EntityContract = {
  ...contract,
  entityKey: "catalog.hero",
  requiredFields: [],
};

const entityContracts = new Map<string, EntityContract>([
  ["catalog.productChooser", contract],
  ["catalog.filters", otherContract],
  ["catalog.hero", heroContract],
]);

const validLayout: LayoutNode = {
  kind: "layout",
  nodeId: "root",
  type: "stack@1",
  properties: {},
  children: [
    { kind: "region", nodeId: "hero_1", slotId: "hero", entityId: "catalog.hero" },
    { kind: "region", nodeId: "products_1", slotId: "products", entityId: "catalog.productChooser", representationId: "grid@1" },
  ],
};

function makeRendererRegistry(): RendererRegistry {
  const registry = new RendererRegistry();
  registry.register(gridDescriptor);
  return registry;
}

function makeKernel(): RuntimeKernel {
  const kernel = new RuntimeKernel(makeRendererRegistry(), new InstanceRegistry(), { buildId: "build_1" });
  kernel.registerEntity(contract, { data: fakeDataBinding(), actions: {} });
  kernel.registerPage(pageContract);
  return kernel;
}

function fakeDataBinding() {
  return {
    contract: { id: "catalog.products", version: 1, schemaDigest: "sha" },
    getSnapshot: () => ({ revision: "r1", status: "ready" as const, value: [] as JsonValue }),
    subscribe: () => () => undefined,
  };
}

describe("RendererRegistry", () => {
  it("throws CAPABILITY_MISSING for unknown required ids", () => {
    const registry = makeRendererRegistry();
    expect(() => registry.get("table@1")).toThrowError(UiIntelligenceError);
    try {
      registry.get("table@1");
    } catch (error) {
      expect((error as UiIntelligenceError).code).toBe("CAPABILITY_MISSING");
    }
  });

  it("rejects duplicate renderer ids and filters by compatibility", () => {
    const registry = makeRendererRegistry();
    expect(() => registry.register(gridDescriptor)).toThrowError(/already registered/);
    expect(registry.listCompatible(contract).map((d) => d.id)).toEqual(["grid@1"]);
    expect(registry.listCompatible({ ...contract, allowedRepresentations: ["carousel@1"] })).toEqual([]);
  });
});

describe("RuntimeKernel", () => {
  it("rejects duplicate entityKey registration as a configuration error", () => {
    const kernel = new RuntimeKernel(makeRendererRegistry(), new InstanceRegistry(), { buildId: "build_1" });
    kernel.registerEntity(contract, { data: fakeDataBinding(), actions: {} });
    try {
      kernel.registerEntity(contract, { data: fakeDataBinding(), actions: {} });
      expect.unreachable("duplicate registration must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UiIntelligenceError);
      expect((error as UiIntelligenceError).code).toBe("SCHEMA_INVALID");
    }
  });

  it("builds a manifest and contract digest from registrations", async () => {
    const kernel = makeKernel();
    const manifest = await kernel.manifest();
    expect(manifest.protocolVersion).toBe(1);
    expect(manifest.buildId).toBe("build_1");
    expect(manifest.rendererVersions).toEqual({ "grid@1": 1 });
    expect(manifest.entities).toHaveLength(1);
    expect(manifest.entities[0]?.entityKey).toBe("catalog.productChooser");
    expect(manifest.pages[0]?.slots).toEqual(["hero", "products", "sidebar"]);
    expect(manifest.contractDigest).toBe(await kernel.contractDigest());
    expect(manifest.contractDigest).toMatch(/^[0-9a-f]{64}$/);

    const kernel2 = makeKernel();
    expect(await kernel2.contractDigest()).toBe(manifest.contractDigest);
  });

  it("currentReadSet carries build, digest, policy, and revision", async () => {
    const kernel = makeKernel();
    const readSet = await kernel.currentReadSet("catalog.productChooser", 3, 7);
    expect(readSet.appBuildId).toBe("build_1");
    expect(readSet.policyVersion).toBe(3);
    expect(readSet.preferenceRevision).toBe(7);
    expect(readSet.entityVersions["catalog.productChooser"]).toBe("catalog.productChooser@1");
    expect(await kernel.currentReadSet("catalog.productChooser", 1)).toMatchObject({ preferenceRevision: 0 });
  });
});

describe("InstanceRegistry", () => {
  const info = (overrides: Partial<RuntimeInstanceInfo> = {}): RuntimeInstanceInfo => ({
    runtimeInstanceId: "rtinst_1",
    entityKey: "catalog.productChooser",
    entityId: "catalog.productChooser",
    contract,
    bindings: { data: fakeDataBinding(), actions: {} },
    getNode: () => null,
    ...overrides,
  });

  it("registers, resolves, and unregisters host nodes", () => {
    const registry = new InstanceRegistry();
    const node = { tagName: "DIV" };
    const unregister = registry.register(node, info({ getNode: () => node }));
    expect(registry.resolve(node)?.runtimeInstanceId).toBe("rtinst_1");
    expect(registry.resolve({})).toBeNull();
    unregister();
    expect(registry.resolve(node)).toBeNull();
    // Unregister is idempotent.
    expect(() => unregister()).not.toThrow();
  });

  it("resolves the nearest registered instance from a composed event path", () => {
    const registry = new InstanceRegistry();
    const outerNode = { tagName: "SECTION" };
    const innerNode = { tagName: "BUTTON" };
    const outerInfo = info({ runtimeInstanceId: "rtinst_outer", getNode: () => outerNode });
    registry.register(outerNode, outerInfo);
    const innerInfo = info({ runtimeInstanceId: "rtinst_inner", logicalParent: outerInfo, getNode: () => innerNode });
    registry.register(innerNode, innerInfo);

    const path = [innerNode, outerNode, { tagName: "BODY" }];
    expect(registry.resolveFromEventPath(path)?.runtimeInstanceId).toBe("rtinst_inner");
    expect(registry.resolveFromEventPath([outerNode])?.runtimeInstanceId).toBe("rtinst_outer");
    expect(registry.resolveFromEventPath([{ tagName: "BODY" }, null])).toBeNull();
    // Portal case: an unregistered portal element on the path falls through
    // to the logically owned ancestor, whose host node is on the path.
    expect(
      registry.resolveFromEventPath([{ tagName: "PORTAL" }, outerNode])?.runtimeInstanceId,
    ).toBe("rtinst_outer");
  });
});

describe("ProposalValidator.validatePresentation", () => {
  const validator = new ProposalValidator(makeRendererRegistry());

  const validSpec = {
    type: "grid@1",
    properties: { columns: 3, density: "compact" },
    dataBinding: "catalog.products@1",
    actions: ["product.open@1", "cart.add@1"],
  };

  it("accepts a valid grid@1 presentation for the product chooser contract", async () => {
    const report = await validator.validatePresentation(validSpec, contract, readSet(), 1);
    expect(report.passed).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.unsupportedChecks).toEqual([]);
    expect(report.checkedInvariants).toContain("property_ranges");
    expect(report.checkedInvariants).toContain("required_fields");
    expect(report.specificationDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a property value with the wrong type or out of range", async () => {
    const report = await validator.validatePresentation(
      { ...validSpec, properties: { columns: "three" } },
      contract,
      readSet(),
      1,
    );
    expect(report.passed).toBe(false);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: "property_ranges", path: "properties.columns" }),
    ]);

    const rangeReport = await validator.validatePresentation(
      { ...validSpec, properties: { columns: 9 } },
      contract,
      readSet(),
      1,
    );
    expect(rangeReport.passed).toBe(false);
    expect(rangeReport.errors[0]?.code).toBe("property_ranges");
  });

  it("rejects strict unknown property keys", async () => {
    const report = await validator.validatePresentation(
      { ...validSpec, properties: { columns: 2, onclick: "alert(1)" } },
      contract,
      readSet(),
      1,
    );
    expect(report.passed).toBe(false);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: "property_ranges", path: "properties.onclick" }),
    ]);
  });

  it("rejects an unregistered representation", async () => {
    const report = await validator.validatePresentation(
      { ...validSpec, type: "table@1" },
      contract,
      readSet(),
      1,
    );
    expect(report.passed).toBe(false);
    expect(report.errors[0]?.code).toBe("CAPABILITY_MISSING");
  });

  it("rejects a representation not allowed by the contract", async () => {
    const report = await validator.validatePresentation(
      { ...validSpec, type: "masonry@1" },
      contract,
      readSet(),
      1,
    );
    expect(report.passed).toBe(false);
    expect(report.errors[0]?.code).toBe("supported_type");
  });

  it("rejects an action not declared by the contract", async () => {
    const report = await validator.validatePresentation(
      { ...validSpec, actions: ["product.open@1", "admin.deleteAll@1"] },
      contract,
      readSet(),
      1,
    );
    expect(report.passed).toBe(false);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: "scope" }),
    ]);
  });

  it("rejects a mismatched data binding", async () => {
    const report = await validator.validatePresentation(
      { ...validSpec, dataBinding: "catalog.products@2" },
      contract,
      readSet(),
      1,
    );
    expect(report.passed).toBe(false);
    expect(report.errors[0]?.code).toBe("binding_version");
  });

  it("records required_fields as unsupported when the renderer does not declare rendered fields", async () => {
    const registry = makeRendererRegistry();
    registry.register({ ...gridDescriptor, id: "carousel@1", rendersFields: undefined });
    const validator2 = new ProposalValidator(registry);
    const report = await validator2.validatePresentation(
      { ...validSpec, type: "carousel@1" },
      contract,
      readSet(),
      1,
    );
    expect(report.passed).toBe(true);
    expect(report.unsupportedChecks).toContain("required_fields");
  });

  it("rejects when the read set does not match the current policy version", async () => {
    const report = await validator.validatePresentation(validSpec, contract, readSet(), 2);
    expect(report.passed).toBe(false);
    expect(report.errors[0]?.code).toBe("VERSION_UNSUPPORTED");
  });
});

describe("ProposalValidator.validatePageLayout", () => {
  const validator = new ProposalValidator(makeRendererRegistry());
  const validate = (layout: LayoutNode, over: Partial<PageContract> = {}) =>
    validator.validatePageLayout(layout, { ...pageContract, ...over }, entityContracts, readSet(), 1);

  it("accepts a valid page layout", async () => {
    const report = await validate(validLayout);
    expect(report.passed).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.checkedInvariants).toContain("slot_membership");
    expect(report.specificationDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a missing required slot", async () => {
    const report = await validate({
      ...validLayout,
      children: [validLayout.children[1]!],
    });
    expect(report.passed).toBe(false);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: "slot_membership", path: "slots.hero" }),
    ]);
  });

  it("rejects a required non-repeatable slot occurring twice", async () => {
    const report = await validate({
      ...validLayout,
      children: [
        validLayout.children[0]!,
        { ...validLayout.children[0]!, nodeId: "hero_2" },
        validLayout.children[1]!,
      ],
    });
    expect(report.passed).toBe(false);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: "slot_membership", path: "slots.hero" }),
    ]);
  });

  it("rejects a locked slot dropped from the layout", async () => {
    const report = await validate({
      ...validLayout,
      children: [validLayout.children[0]!],
    });
    expect(report.passed).toBe(false);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: "locked_regions", path: "slots.products" }),
    ]);
  });

  it("rejects exceeding the page depth bound", async () => {
    const deep: LayoutNode = {
      kind: "layout",
      nodeId: "l1",
      type: "stack@1",
      properties: {},
      children: [
        {
          kind: "layout",
          nodeId: "l2",
          type: "stack@1",
          properties: {},
          children: [
            {
              kind: "layout",
              nodeId: "l3",
              type: "stack@1",
              properties: {},
              children: [validLayout.children[0]!, validLayout.children[1]!],
            },
          ],
        },
      ],
    };
    const report = await validate(deep);
    expect(report.passed).toBe(false);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: "depth_bound" }),
    ]);
  });

  it("rejects an unknown layout type", async () => {
    const report = await validate({
      ...validLayout,
      type: "masonry@1" as LayoutNode extends { type: infer T } ? T : never,
    });
    expect(report.passed).toBe(false);
    expect(report.errors.some((e) => e.code === "supported_type")).toBe(true);
  });

  it("rejects unknown slots, duplicate node ids, and out-of-scope entities", async () => {
    const report = await validate({
      kind: "layout",
      nodeId: "root",
      type: "stack@1",
      properties: {},
      children: [
        { kind: "region", nodeId: "a", slotId: "not_a_slot", entityId: "catalog.hero" },
        { kind: "region", nodeId: "a", slotId: "hero", entityId: "unregistered.entity" },
        { kind: "region", nodeId: "p", slotId: "products", entityId: "catalog.productChooser", representationId: "table@9" },
      ],
    });
    const codes = report.errors.map((e) => e.code);
    expect(codes).toContain("slot_membership");
    expect(codes).toContain("unique_node_ids");
    expect(codes).toContain("scope");
    expect(codes).toContain("representation_compatibility");
  });

  it("rejects node count over the page bound", async () => {
    const children = Array.from({ length: 12 }, (_, i) => ({
      kind: "region" as const,
      nodeId: `n${i}`,
      slotId: "products",
      entityId: "catalog.productChooser",
    }));
    const report = await validate(
      { kind: "layout", nodeId: "root", type: "stack@1", properties: {}, children },
      { maxNodes: 10 },
    );
    expect(report.errors.some((e) => e.code === "node_count_bound")).toBe(true);
  });
});

describe("OperationCoordinator", () => {
  const prefKey: PreferenceKey = {
    profileId: "profile_a",
    projectId: "project_1",
    scope: "entity",
    scopeKey: "catalog.productChooser",
  };

  const proposal: Proposal = {
    schemaVersion: 1,
    proposalId: "proposal_1",
    target: {
      entityId: "catalog.productChooser",
      entityVersionId: "catalog.productChooser@1",
      scope: "entity",
      lockedEntityIds: [],
      batchTargets: [],
    },
    preconditions: {
      appBuildId: "build_1",
      contractDigest: "digest_1",
      policyVersion: 1,
      preferenceRevision: 0,
    },
    presentation: {
      type: "grid@1",
      properties: { columns: 3 },
      dataBinding: "catalog.products@1",
      actions: [],
    },
    origin: { kind: "generated", referenceIds: [] },
  };

  const specification: ApplicationSpecification = {
    digest: "spec_grid",
    proposal,
    requiredRendererVersions: { "grid@1": 1 },
  };

  const switcher = (over: Partial<RendererSwitcher> = {}): RendererSwitcher & {
    commitCalls: number[];
  } => {
    const commitCalls: number[] = [];
    return {
      commitCalls,
      canSwitch: () => ({ allowed: true as const }),
      exportState: () => ({ selectedProductId: "p1" }) as JsonValue,
      validateState: () => true,
      importState: () => undefined,
      commit: () => {
        commitCalls.push(1);
        return Promise.resolve();
      },
      ...over,
    };
  };

  it("applies successfully: commit called, revision bumped, status active", async () => {
    const store = new MemoryPreferenceStore();
    const coordinator = new OperationCoordinator();
    const sw = switcher();
    const result = await coordinator.apply(store, prefKey, specification, { preferenceRevision: 0 }, sw);
    expect(result.status).toBe("active");
    expect(sw.commitCalls).toHaveLength(1);
    const record = await store.getPreference(prefKey);
    expect(record?.revision).toBe(1);
    expect(record?.activeSpecificationDigest).toBe("spec_grid");
    const application = await store.getApplication(result.applicationId);
    expect(application?.status).toBe("active");
    // Undo restores the pristine state as a tombstone record at a fresh
    // monotonic revision (the undo itself is a new revision, so an older
    // bundle cannot resurrect the undone preference).
    const undo = await coordinator.undo(store, result.applicationId);
    expect(undo.restored).toHaveLength(1);
    const undone = await store.getPreference(prefKey);
    expect(undone?.activeSpecificationDigest).toBeNull();
    expect(undone?.revision).toBe(2);
  });

  it("rolls back when the switcher commit fails: revision unchanged, status failed", async () => {
    const store = new MemoryPreferenceStore();
    const coordinator = new OperationCoordinator();
    const result = await coordinator.apply(
      store,
      prefKey,
      specification,
      { preferenceRevision: 0 },
      switcher({ commit: () => Promise.reject(new Error("render failed")) }),
    );
    expect(result.status).toBe("failed");
    expect(await store.getPreference(prefKey)).toBeNull();
    const application = await store.getApplication(result.applicationId);
    expect(application?.status).toBe("failed");
    expect(application?.failureReason).toContain("render failed");
    // Interrupted recovery is a no-op for already-rolled-back applications.
    expect(await coordinator.recoverAtStartup(store)).toEqual([]);
  });

  it("rolls back when the switcher cannot switch or rejects the state", async () => {
    const store = new MemoryPreferenceStore();
    const coordinator = new OperationCoordinator();
    const denied = await coordinator.apply(
      store,
      prefKey,
      specification,
      { preferenceRevision: 0 },
      switcher({ canSwitch: () => ({ allowed: false as const, reason: "pending form" }) }),
    );
    expect(denied.status).toBe("failed");

    const rejectedState = await coordinator.apply(
      store,
      prefKey,
      specification,
      { preferenceRevision: 0 },
      switcher({ validateState: () => false }),
    );
    expect(rejectedState.status).toBe("failed");
    expect(await store.getPreference(prefKey)).toBeNull();
  });

  it("returns conflict without touching the UI when the revision moved", async () => {
    const base = new MemoryPreferenceStore();
    const coordinator = new OperationCoordinator();
    // Simulate a competing tab bumping the revision between the coordinator's
    // read and the store transaction.
    const store = {
      beginApplication: async (
        applicationId: string,
        participants: Parameters<typeof base.beginApplication>[1],
        proposed: Parameters<typeof base.beginApplication>[2],
      ) => {
        await base.setPreference({
          key: participants[0]!.key,
          activeSpecificationDigest: "spec_competing",
          revision: participants[0]!.previousRevision + 1,
          contractVersion: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        await base.beginApplication(applicationId, participants, proposed);
      },
      finalizeApplication: (...args: Parameters<typeof base.finalizeApplication>) => base.finalizeApplication(...args),
      rollbackApplication: (...args: Parameters<typeof base.rollbackApplication>) => base.rollbackApplication(...args),
      getApplication: (...args: Parameters<typeof base.getApplication>) => base.getApplication(...args),
      undoApplication: (...args: Parameters<typeof base.undoApplication>) => base.undoApplication(...args),
      getPreference: (...args: Parameters<typeof base.getPreference>) => base.getPreference(...args),
      recoverPending: (...args: Parameters<typeof base.recoverPending>) => base.recoverPending(...args),
    };
    const result = await coordinator.apply(store, prefKey, specification, { preferenceRevision: 0 }, switcher());
    expect(result.status).toBe("conflict");
    expect((await base.getPreference(prefKey))?.activeSpecificationDigest).toBe("spec_competing");
  });

  it("undo reports a conflict when another operation moved the revision", async () => {
    const store = new MemoryPreferenceStore();
    const coordinator = new OperationCoordinator();
    const first = await coordinator.apply(store, prefKey, specification, { preferenceRevision: 0 }, switcher());
    expect(first.status).toBe("active");
    // A competing operation moves the revision after activation.
    await store.setPreference({
      key: prefKey,
      activeSpecificationDigest: "spec_competing",
      revision: 5,
      contractVersion: 1,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const undo = await coordinator.undo(store, first.applicationId);
    expect(undo.restored).toEqual([]);
    expect(undo.conflicts).toContain("profile_a\u0000project_1\u0000entity\u0000catalog.productChooser");
    expect((await store.getPreference(prefKey))?.activeSpecificationDigest).toBe("spec_competing");
  });

  it("recoverAtStartup reverts pending applications to the previous confirmed version", async () => {
    const store = new MemoryPreferenceStore();
    const coordinator = new OperationCoordinator();
    // Simulate an interrupted commit: pending application, preferences never finalized.
    await store.beginApplication("app_interrupted", [
      { key: prefKey, previousRevision: 0, previousDigest: null, proposedDigest: "spec_grid" },
    ], { [prefKey.scopeKey]: { digest: "spec_grid", requiredRendererVersions: { "grid@1": 1 } } });
    const recovered = await coordinator.recoverAtStartup(store);
    expect(recovered).toEqual(["app_interrupted"]);
    const application = await store.getApplication("app_interrupted");
    expect(application?.status).toBe("failed");
    expect(application?.failureReason).toBe("interrupted");
    expect(await store.getPreference(prefKey)).toBeNull();
  });
});
