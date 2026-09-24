import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IdbPreferenceStore,
  MemoryPreferenceStore,
  PreferenceConflictError,
  preferenceKeyToString,
} from "../src/index.js";
import type {
  ApplicationParticipantInput,
  PreferenceStore,
} from "../src/index.js";
import type { PreferenceKey, PreferenceRecord } from "@ui-intelligence/protocol";
import { installFakeIndexedDB } from "./fake-idb.js";

const key = (over: Partial<PreferenceKey> = {}): PreferenceKey => ({
  profileId: "profile_a",
  projectId: "project_1",
  scope: "entity",
  scopeKey: "catalog.productChooser",
  ...over,
});

const participant = (
  over: Partial<ApplicationParticipantInput> = {},
): ApplicationParticipantInput => ({
  key: key(),
  previousRevision: 0,
  previousDigest: null,
  proposedDigest: "spec_new",
  ...over,
});

async function applyOnce(
  store: PreferenceStore,
  applicationId: string,
  input: ApplicationParticipantInput,
): Promise<void> {
  await store.beginApplication(applicationId, [input], {
    [input.key.scopeKey]: { digest: input.proposedDigest ?? "spec_new", requiredRendererVersions: { "grid@1": 1 } },
  });
  await store.finalizeApplication(applicationId);
}

function defineStoreSuites(makeStore: () => PreferenceStore, closeStore: (store: PreferenceStore) => void | Promise<void>): void {
  describe("preference store transactional semantics", () => {
    let store: PreferenceStore;
    beforeEach(() => {
      store = makeStore();
    });
    afterEach(async () => {
      await closeStore(store);
    });

    it("round-trips a preference record", async () => {
      const record: PreferenceRecord = {
        key: key(),
        activeSpecificationDigest: "spec_1",
        revision: 4,
        contractVersion: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      await store.setPreference(record);
      const loaded = await store.getPreference(key());
      expect(loaded).not.toBeNull();
      expect(loaded?.revision).toBe(4);
      expect(loaded?.activeSpecificationDigest).toBe("spec_1");
      expect(await store.getPreference(key({ scopeKey: "other" }))).toBeNull();
    });

    it("throws a conflict on begin when the participant revision moved", async () => {
      await store.setPreference({
        key: key(),
        activeSpecificationDigest: "spec_old",
        revision: 3,
        contractVersion: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await expect(
        store.beginApplication("app_conflict", [participant({ previousRevision: 1 })], {
          [key().scopeKey]: { digest: "spec_new", requiredRendererVersions: {} },
        }),
      ).rejects.toMatchObject({
        name: "PreferenceConflictError",
        code: "STALE_REVISION",
        currentRevision: 3,
      });
      // The rejected application left no pending record behind.
      expect(await store.getApplication("app_conflict")).toBeNull();
      // And the current preference is untouched.
      expect((await store.getPreference(key()))?.revision).toBe(3);
      await expect(
        store.beginApplication("app_conflict", [participant({ previousRevision: 1 })], {}),
      ).rejects.toBeInstanceOf(PreferenceConflictError);
    });

    it("finalize marks active and bumps participant revisions", async () => {
      await applyOnce(store, "app_1", participant());
      const record = await store.getPreference(key());
      expect(record?.revision).toBe(1);
      expect(record?.activeSpecificationDigest).toBe("spec_new");
      const application = await store.getApplication("app_1");
      expect(application?.status).toBe("active");
      // Finalize is single-use.
      await expect(store.finalizeApplication("app_1")).rejects.toThrow(/expected pending/);
      // Undo then also works from the post-apply revision.
      const undo = await store.undoApplication("app_1");
      expect(undo.restored).toContain(preferenceKeyToString(key()));
      expect(await store.getPreference(key())).toBeNull();
    });

    it("restores the previous digest and revision on undo", async () => {
      await store.setPreference({
        key: key(),
        activeSpecificationDigest: "spec_old",
        revision: 2,
        contractVersion: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await applyOnce(store, "app_2", participant({ previousRevision: 2, previousDigest: "spec_old" }));
      expect((await store.getPreference(key()))?.activeSpecificationDigest).toBe("spec_new");
      const undo = await store.undoApplication("app_2");
      expect(undo.conflicts ?? []).toEqual([]);
      const restored = await store.getPreference(key());
      expect(restored?.activeSpecificationDigest).toBe("spec_old");
      expect(restored?.revision).toBe(2);
      expect((await store.getApplication("app_2"))?.status).toBe("reverted");
    });

    it("rollback leaves preferences untouched and records the reason", async () => {
      await store.beginApplication("app_3", [participant()], {
        [key().scopeKey]: { digest: "spec_new", requiredRendererVersions: {} },
      });
      await store.rollbackApplication("app_3", "switch disallowed");
      expect(await store.getPreference(key())).toBeNull();
      const application = await store.getApplication("app_3");
      expect(application?.status).toBe("failed");
      expect(application?.failureReason).toBe("switch disallowed");
      await expect(store.undoApplication("app_3")).rejects.toThrow(/expected active/);
    });

    it("undo reports a participant whose revision moved on without overwriting it", async () => {
      await applyOnce(store, "app_4", participant());
      // A competing operation moved the revision after finalization.
      await store.setPreference({
        key: key(),
        activeSpecificationDigest: "spec_competing",
        revision: 9,
        contractVersion: 1,
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
      const undo = await store.undoApplication("app_4");
      expect(undo.restored).toEqual([]);
      expect(undo.conflicts).toContain(preferenceKeyToString(key()));
      const record = await store.getPreference(key());
      expect(record?.activeSpecificationDigest).toBe("spec_competing");
      expect(record?.revision).toBe(9);
    });

    it("recoverPending marks interrupted commits as failed", async () => {
      await store.beginApplication("app_5", [participant()], {
        [key().scopeKey]: { digest: "spec_new", requiredRendererVersions: {} },
      });
      const recovered = await store.recoverPending();
      expect(recovered).toEqual(["app_5"]);
      const application = await store.getApplication("app_5");
      expect(application?.status).toBe("failed");
      expect(application?.failureReason).toBe("interrupted");
      expect(await store.getPreference(key())).toBeNull();
      expect(await store.recoverPending()).toEqual([]);
    });

    it("exports and imports one namespace without silent overwrites", async () => {
      await store.putSpecification({
        digest: "spec_new",
        proposal: { type: "grid@1" },
        requiredRendererVersions: { "grid@1": 1 },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await applyOnce(store, "app_6", participant());
      const bundle = await store.exportBundle("profile_a", "project_1");
      expect(bundle.formatVersion).toBe(1);
      expect(bundle.preferences).toHaveLength(1);
      expect(bundle.specifications).toHaveLength(1);

      const target = makeStore();
      try {
        const first = await target.importBundle(bundle);
        expect(first).toEqual({ imported: 1, skipped: 0 });
        const imported = await target.getPreference(key());
        expect(imported?.activeSpecificationDigest).toBe("spec_new");
        const specification = await target.getSpecification("spec_new");
        expect(specification?.proposal).toEqual({ type: "grid@1" });
        // Re-import does not silently overwrite.
        const second = await target.importBundle(bundle);
        expect(second).toEqual({ imported: 0, skipped: 1 });
      } finally {
        await closeStore(target);
      }
    });

    it("isolates namespaces by profileId and projectId", async () => {
      await applyOnce(store, "app_7", participant());
      expect(await store.getPreference(key({ profileId: "profile_b" }))).toBeNull();
      expect(await store.getPreference(key({ projectId: "project_2" }))).toBeNull();
      const otherBundle = await store.exportBundle("profile_b", "project_1");
      expect(otherBundle.preferences).toHaveLength(0);
      const bundle = await store.exportBundle("profile_a", "project_1");
      expect(bundle.preferences).toHaveLength(1);
      // A key from another namespace is invisible to undo as well.
      const undo = await store.undoApplication("app_7");
      expect(undo.restored).toContain(preferenceKeyToString(key()));
    });

    it("specification records round-trip", async () => {
      expect(await store.getSpecification("digest_x")).toBeNull();
      await store.putSpecification({
        digest: "digest_x",
        proposal: { properties: { columns: 3 } },
        requiredRendererVersions: { "grid@1": 1 },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect((await store.getSpecification("digest_x"))?.requiredRendererVersions).toEqual({ "grid@1": 1 });
    });

    it("lists applications filtered by status", async () => {
      await applyOnce(store, "app_8", participant());
      await store.beginApplication("app_9", [participant({ key: key({ scopeKey: "other.entity" }) })], {});
      await store.rollbackApplication("app_9", "test");
      const active = await store.listApplications("active");
      const failed = await store.listApplications("failed");
      expect(active.map((a) => a.applicationId)).toEqual(["app_8"]);
      expect(failed.map((a) => a.applicationId)).toEqual(["app_9"]);
      expect((await store.listApplications()).length).toBe(2);
    });
  });
}

describe("MemoryPreferenceStore", () => {
  defineStoreSuites(
    () => new MemoryPreferenceStore(),
    () => undefined,
  );
});

describe("IdbPreferenceStore", () => {
  defineStoreSuites(
    () => {
      installFakeIndexedDB();
      return new IdbPreferenceStore();
    },
    (store) => store.close(),
  );

  it("preview cache and sync outbox helpers", async () => {
    installFakeIndexedDB();
    const store = new IdbPreferenceStore();
    try {
      await store.putPreviewArtifact("preview_1", { kind: "grid" });
      await store.enqueueSync({
        operationId: "op_1",
        key: key(),
        baseRevision: 2,
        digest: "spec_new",
      });
      expect((await store.listOutbox()).map((op) => op.operationId)).toEqual(["op_1"]);
      await store.clearSync("op_1");
      expect(await store.listOutbox()).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("throws CAPABILITY_MISSING when IndexedDB is unavailable", async () => {
    const { uninstallFakeIndexedDB } = await import("./fake-idb.js");
    uninstallFakeIndexedDB();
    expect(() => new IdbPreferenceStore()).toThrowError(/IndexedDB is not available/);
  });
});
