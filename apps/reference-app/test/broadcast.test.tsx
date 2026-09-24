/**
 * Cross-tab live-view sync and account switching (architecture sections 9
 * and 19). jsdom does not implement BroadcastChannel, so PreferenceBroadcast
 * degrades to its local no-op channel; the tests drive the service's
 * remote-commit handler directly, which is exactly what the broadcast
 * subscription invokes in a real browser.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { PreferenceKey, TargetReadSet } from "@ui-intelligence/protocol";
import { MemoryPreferenceStore } from "@ui-intelligence/preferences";
import type { PreferenceStore } from "@ui-intelligence/preferences";
import { PreferenceService, type ApplyCandidate } from "../src/app/PreferenceService.js";

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

const remoteKey = (profileId: string): PreferenceKey => ({
  profileId,
  projectId: "reference-app",
  scope: "entity",
  scopeKey: SCOPE_KEY,
});

/** Build a service bound to an explicit profile id and a shared store. */
function makeService(profileId: string, store: PreferenceStore): PreferenceService {
  window.localStorage.setItem("ui-intel-profile-id", profileId);
  const service = new PreferenceService();
  (service as unknown as { store: PreferenceStore }).store = store;
  return service;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("cross-tab live-view sync", () => {
  it("reflects another tab's apply in the live view without a reload", async () => {
    const store = new MemoryPreferenceStore();
    const tabA = makeService("profile_shared", store);
    const tabB = makeService("profile_shared", store);
    await tabA.init(SCOPES, VERSIONS);
    await tabB.init(SCOPES, VERSIONS);
    expect(tabB.active.get(SCOPE_KEY)).toBeNull();

    const result = await tabA.apply(SCOPE_KEY, SCOPE_KEY, gridCandidate("spec_grid", 3), switcher, readSet());
    expect(result.status).toBe("active");

    // In a browser the BroadcastChannel delivers this; jsdom has none, so
    // drive the notification handler directly.
    await tabB.handleRemoteCommit(remoteKey("profile_shared"));
    const view = tabB.active.get(SCOPE_KEY);
    expect(view?.digest).toBe("spec_grid");
    expect(view?.representation).toBe("grid@1");
    expect(view?.properties).toEqual({ columns: 3 });
  });

  it("reflects another tab's undo as a cleared live view", async () => {
    const store = new MemoryPreferenceStore();
    const tabA = makeService("profile_shared", store);
    const tabB = makeService("profile_shared", store);
    await tabA.init(SCOPES, VERSIONS);
    await tabB.init(SCOPES, VERSIONS);
    const result = await tabA.apply(SCOPE_KEY, SCOPE_KEY, gridCandidate("spec_grid", 3), switcher, readSet());
    await tabB.handleRemoteCommit(remoteKey("profile_shared"));
    expect(tabB.active.get(SCOPE_KEY)?.digest).toBe("spec_grid");

    await tabA.undo(result.applicationId!);
    await tabB.handleRemoteCommit(remoteKey("profile_shared"));
    expect(tabB.active.get(SCOPE_KEY)).toBeNull();
  });

  it("ignores commits for other profiles", async () => {
    const store = new MemoryPreferenceStore();
    const tabA = makeService("profile_a", store);
    const tabB = makeService("profile_b", store);
    await tabA.init(SCOPES, VERSIONS);
    await tabB.init(SCOPES, VERSIONS);
    await tabA.apply(SCOPE_KEY, SCOPE_KEY, gridCandidate("spec_grid", 3), switcher, readSet());
    await tabB.handleRemoteCommit(remoteKey("profile_a"));
    expect(tabB.active.get(SCOPE_KEY)).toBeNull();
  });
});

describe("account switching", () => {
  it("switches namespaces, rehydrates, and never leaks the other profile's digest", async () => {
    const store = new MemoryPreferenceStore();
    const service = makeService("profile_a", store);
    await service.init(SCOPES, VERSIONS);

    const result = await service.apply(SCOPE_KEY, SCOPE_KEY, gridCandidate("spec_grid_a", 3), switcher, readSet());
    expect(result.status).toBe("active");
    expect(service.active.get(SCOPE_KEY)?.digest).toBe("spec_grid_a");

    // Profile B starts from defaults and never sees A's digest.
    await service.switchProfile("profile_b", SCOPES, VERSIONS);
    expect(service.profileId).toBe("profile_b");
    expect(service.active.get(SCOPE_KEY)).toBeNull();

    const resultB = await service.apply(SCOPE_KEY, SCOPE_KEY, gridCandidate("spec_grid_b", 2), switcher, readSet());
    expect(resultB.status).toBe("active");
    expect(service.active.get(SCOPE_KEY)?.digest).toBe("spec_grid_b");

    // Switching back to A restores A's stored grid preference.
    await service.switchProfile("profile_a", SCOPES, VERSIONS);
    expect(service.profileId).toBe("profile_a");
    expect(service.active.get(SCOPE_KEY)?.digest).toBe("spec_grid_a");
    expect(service.active.get(SCOPE_KEY)?.properties).toEqual({ columns: 3 });
  });

  it("undo on profile B does not touch profile A's stored preference", async () => {
    const store = new MemoryPreferenceStore();
    const service = makeService("profile_a", store);
    await service.init(SCOPES, VERSIONS);
    const resultA = await service.apply(SCOPE_KEY, SCOPE_KEY, gridCandidate("spec_grid_a", 3), switcher, readSet());

    await service.switchProfile("profile_b", SCOPES, VERSIONS);
    const resultB = await service.apply(SCOPE_KEY, SCOPE_KEY, gridCandidate("spec_grid_b", 2), switcher, readSet());
    await service.undo(resultB.applicationId!);
    expect(service.active.get(SCOPE_KEY)).toBeNull();

    await service.switchProfile("profile_a", SCOPES, VERSIONS);
    expect(service.active.get(SCOPE_KEY)?.digest).toBe("spec_grid_a");
    // The undo above must not have reverted A's application record.
    const record = await store.getApplication(resultA.applicationId!);
    expect(record?.status).toBe("active");
  });

  it("dispose closes the broadcast channel without error", async () => {
    const service = makeService("profile_a", new MemoryPreferenceStore());
    service.dispose();
    // A second dispose is safe.
    service.dispose();
  });
});
