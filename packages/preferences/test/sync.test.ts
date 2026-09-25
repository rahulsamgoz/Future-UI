/**
 * SyncManager tests (R2 stream B). Two devices with MemoryPreferenceStores
 * converge through a fake server transport that implements the same merge
 * rules as the API sync endpoint (highest revision wins; equal revision with
 * a different digest = server wins, local retained as draft).
 */
import { describe, expect, it, vi } from "vitest";
import {
  syncIdentityString,
  type PreferenceKey,
  type PreferenceRecord,
  type SpecificationRecord,
  type SyncBundle,
  type SyncMergeResult,
} from "@ui-intelligence/protocol";
import { MemoryPreferenceStore } from "../src/memory-store.js";
import { SyncManager, type SyncTransport } from "../src/sync.js";

const PROFILE = "profile_device_test";
const PROJECT = "proj_reference_app";

function entityKey(scopeKey: string): PreferenceKey {
  return { profileId: PROFILE, projectId: PROJECT, scope: "entity", scopeKey };
}

function record(
  scopeKey: string,
  digest: string,
  revision: number,
  updatedAt = "2026-01-01T00:00:00.000Z",
): PreferenceRecord {
  return {
    key: entityKey(scopeKey),
    activeSpecificationDigest: digest,
    revision,
    contractVersion: 1,
    updatedAt,
  };
}

function specification(digest: string, marker: string): SpecificationRecord {
  return {
    digest,
    proposal: { representation: "grid@1", properties: { columns: 3, marker } },
    requiredRendererVersions: { "grid@1": 1 },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Fake server: same merge semantics as apps/api/src/sync.ts — replace when
 * the server revision is lower, no-op on equal revision + equal digest,
 * server-wins on equal revision + different digest.
 */
class FakeSyncServer {
  readonly #records = new Map<string, PreferenceRecord>();
  readonly #specs = new Map<string, SpecificationRecord>();
  pushCount = 0;

  push(deviceLabel: string): SyncTransport {
    return {
      push: async (bundle: SyncBundle): Promise<SyncMergeResult> => {
        this.pushCount += 1;
        return this.merge(bundle, deviceLabel);
      },
    };
  }

  merge(bundle: SyncBundle, _deviceLabel: string): SyncMergeResult {
    const accepted: string[] = [];
    const serverWins: string[] = [];
    for (const spec of bundle.specifications) this.#specs.set(spec.digest, spec);
    for (const record of bundle.preferences) {
      const identity = syncIdentityString(record.key);
      const existing = this.#records.get(identity);
      if (!existing || existing.revision < record.revision) {
        this.#records.set(identity, { ...record });
        accepted.push(identity);
      } else if (existing.revision === record.revision) {
        if (existing.activeSpecificationDigest === record.activeSpecificationDigest) {
          accepted.push(identity);
        } else {
          // Server wins; the key is flagged so the device retains its local
          // specification as a draft.
          serverWins.push(identity);
        }
      }
      // existing.revision > record.revision: server is ahead; ignore.
    }
    return {
      accepted,
      serverWins,
      retainedAsDraft: [...serverWins],
      authoritative: this.authoritativeBundle(bundle.profileId, bundle.projectId),
    };
  }

  authoritativeBundle(profileId: string, projectId: string): SyncBundle {
    const preferences = [...this.#records.values()]
      .filter((r) => r.key.profileId === profileId && r.key.projectId === projectId)
      .map((r) => ({ ...r, key: { ...r.key } }));
    const referenced = new Set(
      preferences.map((r) => r.activeSpecificationDigest).filter((d): d is string => d !== null),
    );
    const specifications = [...this.#specs.values()]
      .filter((s) => referenced.has(s.digest))
      .map((s) => ({ ...s }));
    return {
      profileId,
      projectId,
      preferences,
      specifications,
      deviceLabel: "server",
      pushedAt: new Date().toISOString(),
    };
  }
}

async function seedDevice(
  store: MemoryPreferenceStore,
  records: Array<{ record: PreferenceRecord; spec: SpecificationRecord }>,
): Promise<void> {
  for (const { record, spec } of records) {
    await store.putSpecification(spec);
    await store.setPreference(record);
  }
}

describe("SyncManager", () => {
  it("pushes the local bundle, enqueues the outbox before the push, and clears it after success", async () => {
    const store = new MemoryPreferenceStore();
    await seedDevice(store, [
      { record: record("catalog.productChooser", "digestA", 1), spec: specification("digestA", "device1") },
      { record: record("ui.primaryButton", "digestB", 1), spec: specification("digestB", "device1") },
    ]);
    const server = new FakeSyncServer();
    const manager = new SyncManager(store, server.push("device-1"), {
      profileId: PROFILE,
      projectId: PROJECT,
      deviceLabel: "device-1",
    });

    const result = await manager.syncNow();

    expect(result.accepted.sort()).toEqual(["entity:catalog.productChooser", "entity:ui.primaryButton"]);
    expect(result.serverWins).toEqual([]);
    // Outbox drained after a successful push.
    await expect(store.listOutbox()).resolves.toHaveLength(0);
    // The server now holds both preferences.
    expect(server.authoritativeBundle(PROFILE, PROJECT).preferences).toHaveLength(2);
  });

  it("keeps outbox entries when the transport fails, and drains them on the next successful sync", async () => {
    const store = new MemoryPreferenceStore();
    await seedDevice(store, [
      { record: record("catalog.productChooser", "digestA", 1), spec: specification("digestA", "x") },
    ]);
    const server = new FakeSyncServer();
    let fail = true;
    const transport: SyncTransport = {
      push: async (bundle) => {
        if (fail) throw new Error("network down");
        return server.merge(bundle, "device-1");
      },
    };
    const manager = new SyncManager(store, transport, {
      profileId: PROFILE,
      projectId: PROJECT,
      deviceLabel: "device-1",
    });

    await expect(manager.syncNow()).rejects.toThrow("network down");
    await expect(store.listOutbox()).resolves.toHaveLength(1);

    fail = false;
    const result = await manager.syncNow();
    expect(result.accepted).toEqual(["entity:catalog.productChooser"]);
    await expect(store.listOutbox()).resolves.toHaveLength(0);
  });

  it("converges two stores: device 2's higher revision is accepted, device 1 pulls it back", async () => {
    const server = new FakeSyncServer();

    const store1 = new MemoryPreferenceStore();
    await seedDevice(store1, [
      { record: record("catalog.productChooser", "digestA1", 1), spec: specification("digestA1", "device1") },
      { record: record("ui.primaryButton", "digestB1", 1), spec: specification("digestB1", "device1") },
    ]);
    const device1 = new SyncManager(store1, server.push("device-1"), {
      profileId: PROFILE,
      projectId: PROJECT,
      deviceLabel: "device-1",
    });
    await device1.syncNow();

    // Device 2 starts from the same base but has applied a NEWER revision of
    // the product chooser and a DIVERGENT same-revision button spec.
    const store2 = new MemoryPreferenceStore();
    await seedDevice(store2, [
      { record: record("catalog.productChooser", "digestA1", 1), spec: specification("digestA1", "device1") },
      { record: record("ui.primaryButton", "digestB1", 1), spec: specification("digestB1", "device1") },
      { record: record("catalog.productChooser", "digestA2", 2), spec: specification("digestA2", "device2") },
      { record: record("ui.primaryButton", "digestB2", 1), spec: specification("digestB2", "device2") },
    ]);
    const device2 = new SyncManager(store2, server.push("device-2"), {
      profileId: PROFILE,
      projectId: PROJECT,
      deviceLabel: "device-2",
    });
    const result2 = await device2.syncNow();

    // Classifications: newer revision accepted; equal-revision divergent spec
    // is a server win, reported back as a retained draft.
    expect(result2.accepted).toEqual(["entity:catalog.productChooser"]);
    expect(result2.serverWins).toEqual(["entity:ui.primaryButton"]);
    expect(result2.retainedAsDraft).toEqual(["entity:ui.primaryButton"]);

    // Device 2's store now holds the SERVER's button spec (never silently
    // overwritten), and its own divergent button spec survives as a draft.
    const button2 = await store2.getPreference(entityKey("ui.primaryButton"));
    expect(button2?.activeSpecificationDigest).toBe("digestB1");
    expect(button2?.revision).toBe(1);
    expect(device2.drafts.get("entity:ui.primaryButton")?.digest).toBe("digestB2");
    expect(device2.drafts.size).toBe(1);

    // Device 1 pulls the authoritative bundle: product chooser moves to
    // revision 2 (device 2's spec); the button re-pushes as a no-op (equal
    // revision, equal digest) and reports as accepted.
    const result1 = await device1.syncNow();
    expect(result1.accepted).toEqual(["entity:ui.primaryButton"]);
    expect(result1.retainedAsDraft).toEqual([]);

    const chooser1 = await store1.getPreference(entityKey("catalog.productChooser"));
    const chooser2 = await store2.getPreference(entityKey("catalog.productChooser"));
    expect(chooser1).toEqual(chooser2);
    expect(chooser1?.activeSpecificationDigest).toBe("digestA2");
    expect(chooser1?.revision).toBe(2);
    const button1 = await store1.getPreference(entityKey("ui.primaryButton"));
    expect(button1?.activeSpecificationDigest).toBe("digestB1");
    // Device 1 never diverged, so it holds no drafts.
    expect(device1.drafts.size).toBe(0);
  });

  it("applies server records to an empty local store (fresh device pull)", async () => {
    const server = new FakeSyncServer();
    const store1 = new MemoryPreferenceStore();
    await seedDevice(store1, [
      { record: record("catalog.productChooser", "digestA1", 3), spec: specification("digestA1", "device1") },
    ]);
    await new SyncManager(store1, server.push("device-1"), {
      profileId: PROFILE,
      projectId: PROJECT,
      deviceLabel: "device-1",
    }).syncNow();

    // A brand-new device pulls everything from the server.
    const store3 = new MemoryPreferenceStore();
    const device3 = new SyncManager(store3, server.push("device-3"), {
      profileId: PROFILE,
      projectId: PROJECT,
      deviceLabel: "device-3",
    });
    await device3.applyAuthoritative(server.authoritativeBundle(PROFILE, PROJECT));
    const chooser = await store3.getPreference(entityKey("catalog.productChooser"));
    expect(chooser?.revision).toBe(3);
    expect(chooser?.activeSpecificationDigest).toBe("digestA1");
    const spec = await store3.getSpecification("digestA1");
    expect(spec?.proposal).toEqual(specification("digestA1", "device1").proposal);
  });

  it("startAutoSync pushes on the interval until stopped", async () => {
    vi.useRealTimers();
    const store = new MemoryPreferenceStore();
    await seedDevice(store, [
      { record: record("catalog.productChooser", "digestA", 1), spec: specification("digestA", "x") },
    ]);
    const server = new FakeSyncServer();
    const manager = new SyncManager(store, server.push("device-1"), {
      profileId: PROFILE,
      projectId: PROJECT,
      deviceLabel: "device-1",
    });
    const errors: unknown[] = [];
    const stop = manager.startAutoSync(20, (error) => errors.push(error));
    await vi.waitFor(() => expect(server.pushCount).toBeGreaterThanOrEqual(2));
    stop();
    stop(); // idempotent
    const afterStop = server.pushCount;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(server.pushCount).toBe(afterStop);
    expect(errors).toEqual([]);
  });
});
