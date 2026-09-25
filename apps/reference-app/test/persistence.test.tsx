/**
 * Persistence/preference correctness regressions (audit defects 1-3):
 * - stale read sets must CONFLICT, never overwrite a newer revision, and the
 *   live view must end up showing the winning revision;
 * - a candidate's real contract identity must survive into the stored
 *   specification (a v2 candidate is stored as v2, a stored v1 spec under a
 *   current v2 contract suspends as a draft — both directions);
 * - the editor's device-sync button pushes through the API sync endpoint and
 *   reports "synced N / conflicts N".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UiRuntimeProvider } from "@ui-intelligence/react";
import { MemoryPreferenceStore } from "@ui-intelligence/preferences";
import type { SpecificationRecord, SyncMergeResult } from "@ui-intelligence/protocol";
import type { RuntimeInstanceInfo } from "@ui-intelligence/runtime-core";
import { ServicesContext, type AppServices } from "../src/Services.js";
import { PreferenceService, type ApplyCandidate } from "../src/app/PreferenceService.js";
import { createAppKernel } from "../src/kernel.js";
import { LocalGenerator } from "../src/editor/LocalGenerator.js";
import { Editor } from "../src/editor/Editor.js";
import {
  createCart,
  createCatalogDataBinding,
  createProductOpenAction,
  createCartAddAction,
  createChooserStateAdapter,
} from "../src/data/catalog.js";
import { productChooserContract } from "../src/contracts.js";
import type { EntityContract, JsonValue, TargetReadSet } from "@ui-intelligence/protocol";

const SCOPE_KEY = "catalog.productChooser";
const SCOPES = [SCOPE_KEY];
const VERSIONS = new Map([[SCOPE_KEY, 1]]);

const readSet = (): TargetReadSet => ({
  appBuildId: "build_1",
  contractDigest: "sha256:contract",
  policyVersion: 1,
  preferenceRevision: 0,
  entityVersions: {},
});

const gridCandidate = (digest: string, columns: number): ApplyCandidate => ({
  representation: "grid@1",
  properties: { columns },
  digest,
  requiredRendererVersions: { "grid@1": 1 },
  contractVersion: 1,
  dataBindingId: "catalog.products",
  actionIds: [],
});

const switcher = {
  canSwitch: () => ({ allowed: true as const }),
  exportState: () => null,
  validateState: () => true,
  importState: () => {},
  commit: async () => {},
};

function makeService(profileId: string, store: MemoryPreferenceStore): PreferenceService {
  window.localStorage.setItem("ui-intel-profile-id", profileId);
  const service = new PreferenceService();
  (service as unknown as { store: unknown }).store = store;
  return service;
}

function keyFor(profileId: string) {
  return {
    profileId,
    projectId: "reference-app",
    scope: "entity" as const,
    scopeKey: SCOPE_KEY,
  };
}

function specRecord(digest: string, contractVersion: number): SpecificationRecord {
  return {
    digest,
    proposal: {
      schemaVersion: 1,
      contractVersion,
      presentation: { type: "grid@1", properties: { columns: 4 }, dataBinding: "catalog.products", actions: [] },
    },
    requiredRendererVersions: { "grid@1": 1 },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  window.localStorage.clear();
  cleanup();
});

describe("stale acceptance conflict reconciliation (audit defect 1)", () => {
  it("returns conflict, keeps revision 3, and shows the winning spec in the live view", async () => {
    const store = new MemoryPreferenceStore();
    const service = makeService("profile_stale", store);
    await service.init(SCOPES, VERSIONS);

    // Revision 3 is written externally (device sync, import, another tab)
    // AFTER the UI last read the store: the read set still says revision 0.
    await store.putSpecification(specRecord("digest-winning", 1));
    await store.setPreference({
      key: keyFor("profile_stale"),
      activeSpecificationDigest: "digest-winning",
      revision: 3,
      contractVersion: 1,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    // The live view never saw revision 3.
    expect(service.active.get(SCOPE_KEY)).toBeNull();

    const result = await service.apply(SCOPE_KEY, SCOPE_KEY, gridCandidate("digest-stale", 3), switcher, readSet());

    expect(result.status).toBe("conflict");
    // The store still holds the winning revision with its original digest.
    const pref = await store.getPreference(keyFor("profile_stale"));
    expect(pref?.revision).toBe(3);
    expect(pref?.activeSpecificationDigest).toBe("digest-winning");
    // The live view reflects the WINNING revision, not the rejected proposal.
    const view = service.active.get(SCOPE_KEY);
    expect(view?.digest).toBe("digest-winning");
    expect(view?.revision).toBe(3);
    expect(view?.properties).toEqual({ columns: 4 });
  });

  it("applies cleanly when the displayed revision matches the store", async () => {
    const store = new MemoryPreferenceStore();
    const service = makeService("profile_fresh", store);
    await service.init(SCOPES, VERSIONS);
    const result = await service.apply(SCOPE_KEY, SCOPE_KEY, gridCandidate("digest-a", 3), switcher, readSet());
    expect(result.status).toBe("active");
    const pref = await store.getPreference(keyFor("profile_fresh"));
    expect(pref?.revision).toBe(1);
    // A follow-up apply grounded on the UPDATED live view also succeeds.
    const second = await service.apply(SCOPE_KEY, SCOPE_KEY, gridCandidate("digest-b", 2), switcher, {
      ...readSet(),
      preferenceRevision: 1,
    });
    expect(second.status).toBe("active");
    const after = await store.getPreference(keyFor("profile_fresh"));
    expect(after?.revision).toBe(2);
    expect(after?.activeSpecificationDigest).toBe("digest-b");
  });
});

describe("single-target contract identity persistence (audit defect 2)", () => {
  it("stores a v2 candidate as v2 and reactivates it on init (full flow)", async () => {
    const contract: EntityContract = { ...productChooserContract, contractVersion: 2 };
    const kernel = createAppKernel();
    const binding = createCatalogDataBinding("default", false);
    const actions = {
      "product.open@1": createProductOpenAction(() => {}),
      "cart.add@1": createCartAddAction(createCart()),
    };
    kernel.registerEntity(contract, { data: binding, actions });
    const instance = {
      runtimeInstanceId: "ri_v2",
      entityKey: contract.entityKey,
      entityId: `entity_${contract.entityKey}`,
      contract,
      bindings: { data: binding, actions, state: createChooserStateAdapter() },
      getNode: () => null,
    } as unknown as RuntimeInstanceInfo;
    const generator = new LocalGenerator(kernel);
    const candidates = await generator.candidatesFor(instance, "make it a grid", [], 4);
    expect(candidates.length).toBeGreaterThan(0);
    const candidate = candidates[0]!;
    expect(candidate.contractVersion).toBe(2);

    const store = new MemoryPreferenceStore();
    const service = makeService("profile_v2", store);
    await service.init(SCOPES, new Map([[SCOPE_KEY, 2]]));
    const result = await service.apply(SCOPE_KEY, SCOPE_KEY, candidate, switcher, readSet());
    expect(result.status).toBe("active");

    // The stored specification carries the candidate's REAL contract
    // identity, binding, and actions — never v1 defaults.
    const spec = await store.getSpecification(candidate.digest);
    const proposal = spec?.proposal as {
      contractVersion?: number;
      presentation?: { dataBinding?: string; actions?: string[] };
    };
    expect(proposal.contractVersion).toBe(2);
    expect(proposal.presentation?.dataBinding).toBe(contract.dataBinding);
    expect(proposal.presentation?.actions).toEqual(contract.actions);
    // The participant record's contract identity lands on the preference.
    const pref = await store.getPreference(keyFor("profile_v2"));
    expect(pref?.contractVersion).toBe(2);

    // Re-init under the SAME v2 contract: the preference must ACTIVATE,
    // not suspend as an incompatible draft.
    const reloaded = makeService("profile_v2", store);
    await reloaded.init(SCOPES, new Map([[SCOPE_KEY, 2]]));
    expect(reloaded.drafts.has(SCOPE_KEY)).toBe(false);
    expect(reloaded.active.get(SCOPE_KEY)?.digest).toBe(candidate.digest);
  });

  it("suspends a stored v1 specification as a draft under a current v2 contract", async () => {
    const store = new MemoryPreferenceStore();
    await store.putSpecification(specRecord("digest-v1", 1));
    await store.setPreference({
      key: keyFor("profile_v1"),
      activeSpecificationDigest: "digest-v1",
      revision: 2,
      contractVersion: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const service = makeService("profile_v1", store);
    await service.init(SCOPES, new Map([[SCOPE_KEY, 2]]));
    expect(service.drafts.get(SCOPE_KEY)?.reason).toContain("contract changed");
    expect(service.active.get(SCOPE_KEY)).toBeNull();
  });
});

describe("device sync wiring (audit defect 3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function buildServices(): AppServices {
    const kernel = createAppKernel();
    const binding = {
      contract: { id: "placeholder", version: 1, schemaDigest: "sha256:placeholder" },
      getSnapshot: () => ({ revision: "none", status: "loading" as const, value: null }),
      subscribe: () => () => {},
    };
    for (const contract of [productChooserContract]) {
      kernel.registerEntity(contract, { data: binding, actions: {} });
    }
    const preferences = new PreferenceService();
    const store = new MemoryPreferenceStore();
    (preferences as unknown as { store: unknown }).store = store;
    const generator = new LocalGenerator(kernel);
    return { kernel, preferences, generator, cart: createCart(), apiBaseUrl: null };
  }

  function withServices(ui: React.ReactNode, services: AppServices) {
    return (
      <ServicesContext.Provider value={services}>
        <UiRuntimeProvider kernel={services.kernel}>{ui}</UiRuntimeProvider>
      </ServicesContext.Provider>
    );
  }

  it("syncs from the editor footer via the API sync endpoint and reports the result", async () => {
    const services = buildServices();
    const store = (services.preferences as unknown as { store: MemoryPreferenceStore }).store;
    await services.preferences.init(SCOPES, VERSIONS);

    const profileId = services.preferences.profileId;
    const mergeResult: SyncMergeResult = {
      accepted: ["entity:catalog.productChooser"],
      serverWins: [],
      retainedAsDraft: [],
      authoritative: {
        profileId,
        projectId: "reference-app",
        preferences: [
          {
            key: keyFor(profileId),
            activeSpecificationDigest: "digest-sync",
            revision: 5,
            contractVersion: 1,
            updatedAt: "2026-01-03T00:00:00.000Z",
          },
        ],
        specifications: [
          {
            digest: "digest-sync",
            proposal: {
              schemaVersion: 1,
              contractVersion: 1,
              presentation: { type: "grid@1", properties: { columns: 2 }, dataBinding: "", actions: [] },
            },
            requiredRendererVersions: { "grid@1": 1 },
            createdAt: "2026-01-03T00:00:00.000Z",
          },
        ],
        deviceLabel: "server",
        pushedAt: "2026-01-03T00:00:00.000Z",
      },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => mergeResult }));
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(withServices(<Editor />, services));
    await user.click(await screen.findByTestId("editor-open"));
    await user.click(screen.getByTestId("sync-now"));

    await waitFor(() => {
      expect(screen.getByTestId("editor-status").textContent).toContain("Synced 1 / conflicts 0");
    });
    // The push went to the profile-scoped sync endpoint.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/v1/profiles/${encodeURIComponent(profileId)}/sync`);
    expect(init.method).toBe("POST");
    // The authoritative record was applied to the store and the live view.
    const pref = await store.getPreference(keyFor(profileId));
    expect(pref?.revision).toBe(5);
    expect(pref?.activeSpecificationDigest).toBe("digest-sync");
    expect(services.preferences.active.get(SCOPE_KEY)?.digest).toBe("digest-sync");
    expect(services.preferences.active.get(SCOPE_KEY)?.revision).toBe(5);
  });

  it("reports a sync failure without throwing when no API is reachable", async () => {
    const services = buildServices();
    await services.preferences.init(SCOPES, VERSIONS);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network down"))));

    const result = await services.preferences.syncNow();
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("network down");
    // Outbox entries are retained for a later retry.
    await expect(
      (services.preferences as unknown as { store: MemoryPreferenceStore }).store.listOutbox()
    ).resolves.toHaveLength(0); // nothing local to push: no entries queued
  });

  it("retains a divergent local spec as a draft through the service-level sync", async () => {
    const services = buildServices();
    const store = (services.preferences as unknown as { store: MemoryPreferenceStore }).store;
    await services.preferences.init(SCOPES, VERSIONS);
    const profileId = services.preferences.profileId;

    // Local edit at revision 1 (the device never pulled anything else).
    await store.putSpecification(specRecord("digest-local", 1));
    await store.setPreference({
      key: keyFor(profileId),
      activeSpecificationDigest: "digest-local",
      revision: 1,
      contractVersion: 1,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    // Server holds a divergent record at the same revision: server wins.
    const mergeResult: SyncMergeResult = {
      accepted: [],
      serverWins: ["entity:catalog.productChooser"],
      retainedAsDraft: ["entity:catalog.productChooser"],
      authoritative: {
        profileId,
        projectId: "reference-app",
        preferences: [
          {
            key: keyFor(profileId),
            activeSpecificationDigest: "digest-server",
            revision: 1,
            contractVersion: 1,
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        specifications: [
          {
            digest: "digest-server",
            proposal: {
              schemaVersion: 1,
              contractVersion: 1,
              presentation: { type: "grid@1", properties: { columns: 6 }, dataBinding: "", actions: [] },
            },
            requiredRendererVersions: { "grid@1": 1 },
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        deviceLabel: "server",
        pushedAt: "2026-01-02T00:00:00.000Z",
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => mergeResult })));

    const result = await services.preferences.syncNow();
    expect(result).toEqual({ ok: true, synced: 0, conflicts: 1 });
    const pref = await store.getPreference(keyFor(profileId));
    expect(pref?.activeSpecificationDigest).toBe("digest-server");
    expect(services.preferences.drafts.get(SCOPE_KEY)?.digest).toBe("digest-local");
  });
});
