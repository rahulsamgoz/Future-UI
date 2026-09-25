/**
 * Device synchronization client (R2 stream B, architecture section 9).
 *
 * Precedence and conflict policy:
 * - The local bundle is exported from the store, enqueued into the sync
 *   outbox, then pushed through the transport.
 * - On success the outbox is cleared and the authoritative bundle returned
 *   by the server is applied:
 *     - local revision <  server revision → apply the server record;
 *     - equal revision, equal digest      → skip (already converged);
 *     - equal revision, DIFFERENT digest  → the server wins: the server
 *       record is stored, and the local specification is retained as a
 *       DRAFT (never silently overwritten);
 *     - local revision >  server revision → keep local (server lagged).
 *
 * Drafts: the store has no draft concept by design (a preference record
 * always reflects the ACTIVE specification). Divergent local specifications
 * are therefore held in this SyncManager as `Map<scopeKey, SpecificationRecord>`
 * (keyed by syncIdentityString's identity within the manager's single
 * profile/project). Drafts are in-memory only — they survive neither reload
 * nor account switch (architecture section 9: account switching clears
 * in-memory selections) — and are exposed via `drafts` for UI recovery ("an
 * incompatible preference is retained as a recoverable draft").
 */
import {
  newId,
  syncIdentityString,
  type PreferenceRecord,
  type SpecificationRecord,
  type SyncBundle,
  type SyncMergeResult,
  type SyncOperation,
} from "@ui-intelligence/protocol";
import type { PreferenceStore } from "./store.js";

/** Push transport: one POST to the server sync endpoint. */
export type SyncTransport = {
  push(bundle: SyncBundle): Promise<SyncMergeResult>;
};

export type SyncManagerOptions = {
  /** Opaque host-provided profile ID (never used for authorization). */
  profileId: string;
  projectId: string;
  /** Human-readable device identity carried in the pushed bundle. */
  deviceLabel: string;
};

export type ApplyOutcome = {
  applied: string[];
  skipped: string[];
  retainedAsDraft: string[];
};

export class SyncManager {
  readonly #store: PreferenceStore;
  readonly #transport: SyncTransport;
  readonly #options: SyncManagerOptions;
  /**
   * Divergent local specifications retained after an equal-revision/
   * different-digest conflict, keyed by syncIdentityString within this
   * manager's profile+project. See the module documentation.
   */
  readonly #drafts = new Map<string, SpecificationRecord>();
  #autoSyncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(store: PreferenceStore, transport: SyncTransport, options: SyncManagerOptions) {
    this.#store = store;
    this.#transport = transport;
    this.#options = options;
  }

  /** Divergent local specifications kept as recoverable drafts. */
  get drafts(): Map<string, SpecificationRecord> {
    return this.#drafts;
  }

  /**
   * Export the local state, enqueue outbox operations, push, clear the
   * outbox, then apply the authoritative bundle. Throws when the transport
   * fails — the outbox entries are kept so a later syncNow retries.
   */
  async syncNow(): Promise<SyncMergeResult> {
    const bundle = await this.#exportBundle();
    // Enqueue BEFORE the push (architecture section 9: syncOutbox carries
    // operations with a unique operation id and base revision) so an
    // interrupted sync is recoverable.
    for (const record of bundle.preferences) {
      const operation: SyncOperation = {
        operationId: newId("sync"),
        key: { ...record.key },
        baseRevision: record.revision,
        digest: record.activeSpecificationDigest,
      };
      await this.#store.enqueueSync(operation);
    }
    let result: SyncMergeResult;
    try {
      result = await this.#transport.push(bundle);
    } catch (error) {
      // Outbox entries stay enqueued for the next attempt (at-least-once).
      throw error;
    }
    // The full local state was pushed successfully: drain the whole outbox,
    // including entries left over from a previously failed attempt.
    for (const operation of await this.#store.listOutbox()) {
      await this.#store.clearSync(operation.operationId);
    }
    await this.applyAuthoritative(result.authoritative);
    return result;
  }

  /**
   * Apply a server-authoritative bundle to the local store using the
   * revision/digest policy documented on the class. Exported separately so
   * a device can pull (another device's push) without pushing first.
   */
  async applyAuthoritative(bundle: SyncBundle): Promise<ApplyOutcome> {
    const applied: string[] = [];
    const skipped: string[] = [];
    const retainedAsDraft: string[] = [];
    const specificationsByDigest = new Map(
      bundle.specifications.map((specification) => [specification.digest, specification]),
    );
    for (const record of bundle.preferences) {
      // Only records for this manager's namespace are applied.
      if (record.key.profileId !== this.#options.profileId || record.key.projectId !== this.#options.projectId) {
        continue;
      }
      const identity = syncIdentityString(record.key);
      const local = await this.#store.getPreference(record.key);
      if (local === null || local.revision < record.revision) {
        await this.#applyServerRecord(record, specificationsByDigest);
        applied.push(identity);
        continue;
      }
      if (local.revision > record.revision) {
        // Server is behind (e.g. its merge dropped our push): local wins.
        skipped.push(identity);
        continue;
      }
      // Equal revision.
      if (local.activeSpecificationDigest === record.activeSpecificationDigest) {
        skipped.push(identity);
        continue;
      }
      // Equal revision, different digest: server wins in the store; the
      // local specification is retained as a recoverable draft (never
      // silently overwritten).
      const localSpec = local.activeSpecificationDigest
        ? await this.#store.getSpecification(local.activeSpecificationDigest)
        : null;
      if (localSpec) this.#drafts.set(identity, localSpec);
      await this.#applyServerRecord(record, specificationsByDigest);
      applied.push(identity);
      retainedAsDraft.push(identity);
    }
    return { applied, skipped, retainedAsDraft };
  }

  /**
   * Interval auto-sync helper. Returns a stop function; calling stop twice
   * is harmless. Errors from syncNow are reported via onError (the outbox
   * retains the pending operations for the next run).
   */
  startAutoSync(intervalMs: number, onError?: (error: unknown) => void): () => void {
    if (this.#autoSyncTimer) clearInterval(this.#autoSyncTimer);
    this.#autoSyncTimer = setInterval(() => {
      void this.syncNow().catch((error) => onError?.(error));
    }, intervalMs);
    return () => {
      if (this.#autoSyncTimer) {
        clearInterval(this.#autoSyncTimer);
        this.#autoSyncTimer = null;
      }
    };
  }

  async #exportBundle(): Promise<SyncBundle> {
    const exported = await this.#store.exportBundle(this.#options.profileId, this.#options.projectId);
    return {
      profileId: exported.profileId,
      projectId: exported.projectId,
      preferences: exported.preferences,
      specifications: exported.specifications,
      deviceLabel: this.#options.deviceLabel,
      pushedAt: new Date().toISOString(),
    };
  }

  async #applyServerRecord(
    record: PreferenceRecord,
    specificationsByDigest: Map<string, SpecificationRecord>,
  ): Promise<void> {
    const specification = record.activeSpecificationDigest
      ? specificationsByDigest.get(record.activeSpecificationDigest)
      : undefined;
    if (specification) await this.#store.putSpecification({ ...specification });
    await this.#store.setPreference({ ...record, key: { ...record.key } });
  }
}
