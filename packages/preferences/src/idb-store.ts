/**
 * IndexedDB-backed preference store (architecture section 9). Database
 * `ui-intelligence` v1 with stores: preferences, specifications,
 * applications, syncOutbox, previewCache.
 *
 * Every multi-record mutation (begin/finalize/undo/recover/import) runs in
 * ONE IndexedDB transaction and performs its expected-revision checks inside
 * that transaction; on any mismatch the transaction aborts and a
 * PreferenceConflictError is thrown, so a competing writer can never be
 * partially overwritten.
 */
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import type {
  ApplicationStatus,
  JsonValue,
  PreferenceExportBundle,
  PreferenceKey,
  PreferenceRecord,
  SpecificationRecord,
  SyncOperation,
} from "@ui-intelligence/protocol";
import {
  PreferenceConflictError,
  preferenceKeyToString,
} from "./errors.js";
import type {
  ApplicationParticipantInput,
  ImportResult,
  PreferenceStore,
  ProposedSpecificationEntry,
  StoredApplicationRecord,
  UndoResult,
} from "./store.js";

const DATABASE_NAME = "ui-intelligence";
const DATABASE_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function keyToArray(key: PreferenceKey): IDBValidKey[] {
  return [key.profileId, key.projectId, key.scope, key.scopeKey];
}

export class IdbPreferenceStore implements PreferenceStore {
  #db: Promise<IDBDatabase>;

  constructor() {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) {
      throw new UiIntelligenceError(
        "CAPABILITY_MISSING",
        "IndexedDB is not available in this context; use MemoryPreferenceStore instead",
      );
    }
    this.#db = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("preferences")) {
          db.createObjectStore("preferences", {
            keyPath: ["key.profileId", "key.projectId", "key.scope", "key.scopeKey"],
          });
        }
        if (!db.objectStoreNames.contains("specifications")) {
          db.createObjectStore("specifications", { keyPath: "digest" });
        }
        if (!db.objectStoreNames.contains("applications")) {
          db.createObjectStore("applications", { keyPath: "applicationId" });
        }
        if (!db.objectStoreNames.contains("syncOutbox")) {
          db.createObjectStore("syncOutbox", { keyPath: "operationId" });
        }
        if (!db.objectStoreNames.contains("previewCache")) {
          db.createObjectStore("previewCache", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("failed to open IndexedDB"));
    });
  }

  async #transaction<T>(
    storeNames: string[],
    mode: IDBTransactionMode,
    body: (stores: Record<string, IDBObjectStore>) => Promise<T>,
  ): Promise<T> {
    const db = await this.#db;
    const tx = db.transaction(storeNames, mode);
    const stores: Record<string, IDBObjectStore> = {};
    for (const name of storeNames) stores[name] = tx.objectStore(name);

    let committed = false;
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
    const settled = new Promise<void>((resolve) => {
      tx.oncomplete = () => {
        committed = true;
        resolve();
      };
      tx.onabort = () => resolve();
      tx.onerror = () => resolve();
    });

    try {
      const value = await body(stores);
      outcome = { ok: true, value };
    } catch (error) {
      outcome = { ok: false, error };
      try {
        tx.abort();
      } catch {
        // Transaction already aborted or completed.
      }
    }
    await settled;
    if (!outcome!.ok) throw outcome!.error;
    if (!committed) {
      throw new Error("IndexedDB transaction did not commit");
    }
    return outcome!.value;
  }

  async getPreference(key: PreferenceKey): Promise<PreferenceRecord | null> {
    return this.#transaction(["preferences"], "readonly", async (stores) => {
      const value = (await wrap(stores.preferences.get(keyToArray(key)))) as
        | PreferenceRecord
        | undefined;
      return value ?? null;
    });
  }

  async setPreference(record: PreferenceRecord): Promise<void> {
    await this.#transaction(["preferences"], "readwrite", async (stores) => {
      stores.preferences.put(record);
    });
  }

  async getSpecification(digest: string): Promise<SpecificationRecord | null> {
    return this.#transaction(["specifications"], "readonly", async (stores) => {
      const value = (await wrap(stores.specifications.get(digest))) as
        | SpecificationRecord
        | undefined;
      return value ?? null;
    });
  }

  async putSpecification(record: SpecificationRecord): Promise<void> {
    await this.#transaction(["specifications"], "readwrite", async (stores) => {
      stores.specifications.put(record);
    });
  }

  async beginApplication(
    applicationId: string,
    participants: ApplicationParticipantInput[],
    proposed: Record<string, ProposedSpecificationEntry>,
  ): Promise<void> {
    await this.#transaction(
      ["preferences", "applications", "specifications"],
      "readwrite",
      async (stores) => {
        const current = await Promise.all(
          participants.map((p) =>
            wrap(stores.preferences.get(keyToArray(p.key))) as Promise<PreferenceRecord | undefined>,
          ),
        );
        for (let i = 0; i < participants.length; i += 1) {
          const participant = participants[i]!;
          const currentRevision = current[i]?.revision ?? 0;
          if (currentRevision !== participant.previousRevision) {
            stores.preferences.transaction.abort();
            throw new PreferenceConflictError(
              `preference revision moved: expected ${participant.previousRevision}, current ${currentRevision}`,
              {
                conflictKey: participant.key,
                expectedRevision: participant.previousRevision,
                currentRevision,
              },
            );
          }
        }
        const application: StoredApplicationRecord = {
          applicationId,
          createdAt: nowIso(),
          status: "pending",
          participants: participants.map((p) => ({
            key: { ...p.key },
            previousRevision: p.previousRevision,
            previousDigest: p.previousDigest,
            proposedDigest: p.proposedDigest,
          })),
        };
        stores.applications.put(application);
        for (const entry of Object.values(proposed)) {
          const existing = (await wrap(stores.specifications.get(entry.digest))) as
            | SpecificationRecord
            | undefined;
          if (!existing) {
            stores.specifications.put({
              digest: entry.digest,
              proposal: null,
              requiredRendererVersions: { ...entry.requiredRendererVersions },
              createdAt: nowIso(),
            });
          }
        }
      },
    );
  }

  async finalizeApplication(applicationId: string): Promise<void> {
    await this.#transaction(
      ["applications", "preferences"],
      "readwrite",
      async (stores) => {
        const application = (await wrap(stores.applications.get(applicationId))) as
          | StoredApplicationRecord
          | undefined;
        if (!application) {
          stores.applications.transaction.abort();
          throw new Error(`application "${applicationId}" not found`);
        }
        if (application.status !== "pending") {
          stores.applications.transaction.abort();
          throw new Error(
            `application "${applicationId}" is ${application.status}, expected pending`,
          );
        }
        const current = await Promise.all(
          application.participants.map((p) =>
            wrap(stores.preferences.get(keyToArray(p.key))) as Promise<PreferenceRecord | undefined>,
          ),
        );
        for (let i = 0; i < application.participants.length; i += 1) {
          const participant = application.participants[i]!;
          const currentRevision = current[i]?.revision ?? 0;
          if (currentRevision !== participant.previousRevision) {
            stores.preferences.transaction.abort();
            throw new PreferenceConflictError(
              `preference revision moved before finalize: expected ${participant.previousRevision}, current ${currentRevision}`,
              {
                conflictKey: participant.key,
                expectedRevision: participant.previousRevision,
                currentRevision,
              },
            );
          }
        }
        const postApplyRevisions: Record<string, number> = {};
        application.participants.forEach((participant, i) => {
          const identity = preferenceKeyToString(participant.key);
          const revision = participant.previousRevision + 1;
          postApplyRevisions[identity] = revision;
          stores.preferences.put({
            key: { ...participant.key },
            activeSpecificationDigest: participant.proposedDigest,
            revision,
            contractVersion:
              current[i]?.contractVersion ??
              0,
            updatedAt: nowIso(),
          });
        });
        stores.applications.put({ ...application, status: "active", postApplyRevisions });
      },
    );
  }

  async rollbackApplication(applicationId: string, reason: string): Promise<void> {
    await this.#transaction(["applications"], "readwrite", async (stores) => {
      const application = (await wrap(stores.applications.get(applicationId))) as
        | StoredApplicationRecord
        | undefined;
      if (!application) {
        stores.applications.transaction.abort();
        throw new Error(`application "${applicationId}" not found`);
      }
      // A pending application never changed preference records, so nothing to
      // restore — record the terminal failed state with its reason.
      stores.applications.put({ ...application, status: "failed", failureReason: reason });
    });
  }

  async getApplication(applicationId: string): Promise<StoredApplicationRecord | null> {
    return this.#transaction(["applications"], "readonly", async (stores) => {
      const value = (await wrap(stores.applications.get(applicationId))) as
        | StoredApplicationRecord
        | undefined;
      return value ?? null;
    });
  }

  async undoApplication(applicationId: string): Promise<UndoResult> {
    return this.#transaction(["applications", "preferences"], "readwrite", async (stores) => {
      const application = (await wrap(stores.applications.get(applicationId))) as
        | StoredApplicationRecord
        | undefined;
      if (!application) {
        stores.applications.transaction.abort();
        throw new Error(`application "${applicationId}" not found`);
      }
      if (application.status !== "active") {
        stores.applications.transaction.abort();
        throw new Error(
          `application "${applicationId}" is ${application.status}, expected active`,
        );
      }
      const restored: string[] = [];
      const conflicts: string[] = [];
      for (const participant of application.participants) {
        const identity = preferenceKeyToString(participant.key);
        const expectedPost =
          application.postApplyRevisions?.[identity] ?? participant.previousRevision + 1;
        const existing = (await wrap(
          stores.preferences.get(keyToArray(participant.key)),
        )) as PreferenceRecord | undefined;
        const currentRevision = existing?.revision ?? 0;
        if (currentRevision !== expectedPost) {
          conflicts.push(identity);
          continue;
        }
        if (participant.previousRevision === 0 && participant.previousDigest === null) {
          stores.preferences.delete(keyToArray(participant.key));
        } else {
          stores.preferences.put({
            key: { ...participant.key },
            activeSpecificationDigest: participant.previousDigest,
            revision: participant.previousRevision,
            contractVersion: existing?.contractVersion ?? 0,
            updatedAt: nowIso(),
          });
        }
        restored.push(identity);
      }
      stores.applications.put({ ...application, status: "reverted" });
      return { restored, ...(conflicts.length > 0 ? { conflicts } : {}) };
    });
  }

  async recoverPending(): Promise<string[]> {
    return this.#transaction(["applications"], "readwrite", async (stores) => {
      const all = (await wrap(stores.applications.getAll())) as StoredApplicationRecord[];
      const recovered: string[] = [];
      for (const application of all) {
        if (application.status === "pending") {
          // Interrupted commit: preference records were never changed.
          stores.applications.put({
            ...application,
            status: "failed",
            failureReason: "interrupted",
          });
          recovered.push(application.applicationId);
        }
      }
      return recovered;
    });
  }

  async exportBundle(profileId: string, projectId: string): Promise<PreferenceExportBundle> {
    return this.#transaction(
      ["preferences", "specifications"],
      "readonly",
      async (stores) => {
        const allPreferences = (await wrap(stores.preferences.getAll())) as PreferenceRecord[];
        const preferences = allPreferences.filter(
          (record) =>
            record.key.profileId === profileId && record.key.projectId === projectId,
        );
        const referenced = new Set(
          preferences
            .map((record) => record.activeSpecificationDigest)
            .filter((d): d is string => d !== null),
        );
        const allSpecifications = (await wrap(stores.specifications.getAll())) as SpecificationRecord[];
        return {
          formatVersion: 1,
          exportedAt: nowIso(),
          profileId,
          projectId,
          preferences,
          specifications: allSpecifications.filter((s) => referenced.has(s.digest)),
        };
      },
    );
  }

  async importBundle(bundle: PreferenceExportBundle): Promise<ImportResult> {
    return this.#transaction(
      ["preferences", "specifications"],
      "readwrite",
      async (stores) => {
        let imported = 0;
        let skipped = 0;
        for (const specification of bundle.specifications) {
          const existing = (await wrap(stores.specifications.get(specification.digest))) as
            | SpecificationRecord
            | undefined;
          if (!existing) stores.specifications.put(specification);
        }
        for (const record of bundle.preferences) {
          const existing = (await wrap(
            stores.preferences.get(keyToArray(record.key)),
          )) as PreferenceRecord | undefined;
          // Never silently overwrite: skip records whose revision is not newer.
          if (existing && existing.revision >= record.revision) {
            skipped += 1;
            continue;
          }
          stores.preferences.put(record);
          imported += 1;
        }
        return { imported, skipped };
      },
    );
  }

  async listApplications(status?: ApplicationStatus): Promise<StoredApplicationRecord[]> {
    return this.#transaction(["applications"], "readonly", async (stores) => {
      const all = (await wrap(stores.applications.getAll())) as StoredApplicationRecord[];
      return status === undefined ? all : all.filter((a) => a.status === status);
    });
  }

  async putPreviewArtifact(id: string, data: JsonValue): Promise<void> {
    await this.#transaction(["previewCache"], "readwrite", async (stores) => {
      stores.previewCache.put({ id, data });
    });
  }

  async listOutbox(): Promise<SyncOperation[]> {
    return this.#transaction(["syncOutbox"], "readonly", async (stores) => {
      return (await wrap(stores.syncOutbox.getAll())) as SyncOperation[];
    });
  }

  async enqueueSync(operation: SyncOperation): Promise<void> {
    await this.#transaction(["syncOutbox"], "readwrite", async (stores) => {
      stores.syncOutbox.put(operation);
    });
  }

  async clearSync(operationId: string): Promise<void> {
    await this.#transaction(["syncOutbox"], "readwrite", async (stores) => {
      stores.syncOutbox.delete(operationId);
    });
  }

  async close(): Promise<void> {
    const db = await this.#db;
    db.close();
  }
}
