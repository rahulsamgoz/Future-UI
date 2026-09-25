/**
 * Device synchronization client (R2 stream B, architecture section 9).
 *
 * Precedence and conflict policy:
 * - The local bundle is exported from the store, enqueued into the sync
 *   outbox, then pushed through the transport.
 * - On success the outbox is cleared and the authoritative bundle returned
 *   by the server is applied. Revisions from independent devices have no
 *   causal meaning (device A's revision 1 is not "before" device B's
 *   revision 2), so every comparison is anchored on the lastSyncedBase
 *   revision per scope key — the last SERVER revision this device observed
 *   being adopted (see below):
 *     - local revision >  base AND server revision > base AND digests
 *       differ → DIVERGENT edit: both sides changed since the last observed
 *       server state, regardless of which revision number is bigger. The
 *       server record is applied and the local specification is retained as
 *       a DRAFT (never silently overwritten);
 *     - local revision <= base (local unchanged since the observed server
 *       state) → the server change is a strict fast-forward and may apply
 *       silently (equal revision with a different digest still retains the
 *       local spec as a draft — the server-wins policy);
 *     - local revision > base, server revision <= base → the server is
 *       behind what we already observed: local wins, nothing is applied;
 *     - equal digests → converged, nothing to do.
 *
 * Persistence (additive, no schema change): the store has no draft or sync
 * bookkeeping concept by design (a preference record always reflects the
 * ACTIVE specification). SyncManager therefore persists its state as
 * SpecificationRecords under RESERVED digest prefixes via
 * putSpecification/listSpecifications:
 *   - `draft:<profileId>:<projectId>:<scope>:<scopeKey>` → the retained
 *     local SpecificationRecord is wrapped in `proposal`;
 *   - `sync-bases:<profileId>:<projectId>` → the base-revision map
 *     (Record<identity, number>) in `proposal`.
 * Reserved prefixes never collide with content digests, and records that no
 * active preference references are excluded from exportBundle, so
 * bookkeeping never leaks into a pushed bundle. State survives manager
 * recreation (reload, account switch back); `restore()` re-loads it and the
 * constructor starts hydration automatically.
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

/** Reserved digest prefixes for SyncManager bookkeeping records. */
export const DRAFT_DIGEST_PREFIX = "draft:";
export const SYNC_BASES_DIGEST_PREFIX = "sync-bases:";

function draftDigestId(profileId: string, projectId: string, identity: string): string {
  return `${DRAFT_DIGEST_PREFIX}${profileId}:${projectId}:${identity}`;
}

function syncBasesDigestId(profileId: string, projectId: string): string {
  return `${SYNC_BASES_DIGEST_PREFIX}${profileId}:${projectId}`;
}

export class SyncManager {
  readonly #store: PreferenceStore;
  readonly #transport: SyncTransport;
  readonly #options: SyncManagerOptions;
  /**
   * Divergent local specifications retained after a conflict, keyed by
   * syncIdentityString within this manager's profile+project. Persisted to
   * the store under the reserved draft digest prefix (see module docs).
   */
  readonly #drafts = new Map<string, SpecificationRecord>();
  /**
   * lastSyncedBase revision per scope-key identity: the last SERVER revision
   * this device observed being adopted (or agreed on while pulling). Local
   * revision counters are device-local and never update it directly.
   * Persisted under the reserved sync-bases digest prefix.
   */
  #bases = new Map<string, number>();
  /** Hydrates persisted drafts and bases exactly once per manager. */
  readonly #ready: Promise<void>;
  #autoSyncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(store: PreferenceStore, transport: SyncTransport, options: SyncManagerOptions) {
    this.#store = store;
    this.#transport = transport;
    this.#options = options;
    this.#ready = this.#hydrate();
  }

  /** Divergent local specifications kept as recoverable drafts. */
  get drafts(): Map<string, SpecificationRecord> {
    return this.#drafts;
  }

  /**
   * (Re)load persisted drafts and sync bases from the store. Idempotent;
   * called automatically by the constructor and before every sync.
   */
  async restore(): Promise<void> {
    await this.#ready;
  }

  async #hydrate(): Promise<void> {
    let records: SpecificationRecord[];
    try {
      records = await this.#store.listSpecifications();
    } catch {
      return; // Store unavailable: operate from memory only.
    }
    const draftPrefix = `${DRAFT_DIGEST_PREFIX}${this.#options.profileId}:${this.#options.projectId}:`;
    const basesId = syncBasesDigestId(this.#options.profileId, this.#options.projectId);
    for (const record of records) {
      if (record.digest === basesId) {
        const bases = record.proposal as Record<string, unknown> | null;
        if (bases && typeof bases === "object") {
          for (const [identity, revision] of Object.entries(bases)) {
            if (typeof revision === "number" && !this.#bases.has(identity)) {
              this.#bases.set(identity, revision);
            }
          }
        }
        continue;
      }
      if (record.digest.startsWith(draftPrefix)) {
        const identity = record.digest.slice(draftPrefix.length);
        const specification = record.proposal as SpecificationRecord | null;
        if (specification && typeof specification.digest === "string" && !this.#drafts.has(identity)) {
          this.#drafts.set(identity, specification);
        }
      }
    }
  }

  /** Persist one retained draft as a reserved SpecificationRecord. */
  async #retainDraft(identity: string, specification: SpecificationRecord): Promise<void> {
    this.#drafts.set(identity, specification);
    await this.#store.putSpecification({
      digest: draftDigestId(this.#options.profileId, this.#options.projectId, identity),
      // The retained record is wrapped whole, so the draft's own content
      // digest survives round trips.
      proposal: specification,
      requiredRendererVersions: { ...specification.requiredRendererVersions },
      createdAt: new Date().toISOString(),
    });
  }

  /** Persist the base-revision map (only called when it changed). */
  async #persistBases(): Promise<void> {
    const bases: Record<string, number> = {};
    for (const [identity, revision] of this.#bases) bases[identity] = revision;
    await this.#store.putSpecification({
      digest: syncBasesDigestId(this.#options.profileId, this.#options.projectId),
      proposal: bases,
      requiredRendererVersions: {},
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Export the local state, enqueue outbox operations, push, clear the
   * outbox, then apply the authoritative bundle. Throws when the transport
   * fails — the outbox entries are kept so a later syncNow retries.
   *
   * The returned SyncMergeResult is the server's classification, with
   * `retainedAsDraft` AUGMENTED by every key this device detected as
   * divergent while applying the authoritative bundle (the server cannot
   * classify a push it ignored because its revision was already ahead).
   */
  async syncNow(): Promise<SyncMergeResult> {
    await this.#ready;
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
    const outcome = await this.applyAuthoritative(result.authoritative);
    return {
      ...result,
      retainedAsDraft: [...new Set([...result.retainedAsDraft, ...outcome.retainedAsDraft])],
    };
  }

  /**
   * Apply a server-authoritative bundle to the local store using the
   * revision/digest policy documented on the class. Exported separately so
   * a device can pull (another device's push) without pushing first.
   */
  async applyAuthoritative(bundle: SyncBundle): Promise<ApplyOutcome> {
    await this.#ready;
    const applied: string[] = [];
    const skipped: string[] = [];
    const retainedAsDraft: string[] = [];
    let basesChanged = false;
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
      const serverDigest = record.activeSpecificationDigest;
      const localDigest = local?.activeSpecificationDigest ?? null;
      const base = this.#bases.get(identity) ?? 0;

      if (local === null) {
        // Nothing local (fresh device pull): adopt the server record; the
        // adopted revision becomes the new observed-server anchor.
        await this.#applyServerRecord(record, specificationsByDigest);
        this.#bases.set(identity, record.revision);
        basesChanged = true;
        applied.push(identity);
        continue;
      }
      if (localDigest === serverDigest) {
        // Converged content. The base is intentionally NOT advanced here:
        // the agreement may just be this device's own push being echoed
        // back, and the base must keep pointing at the last SERVER state
        // this device observed, so a later server-side clobber of our push
        // is detected as a divergence.
        skipped.push(identity);
        continue;
      }
      if (local.revision > base && record.revision > base) {
        // DIVERGENT: both sides changed since the last observed server
        // state. Revision numbers carry no causal meaning across devices —
        // the server record is applied and the local specification is
        // retained as a recoverable draft no matter which revision is
        // bigger.
        const localSpec = local.activeSpecificationDigest
          ? await this.#store.getSpecification(local.activeSpecificationDigest)
          : null;
        if (localSpec) await this.#retainDraft(identity, localSpec);
        await this.#applyServerRecord(record, specificationsByDigest);
        this.#bases.set(identity, record.revision);
        basesChanged = true;
        applied.push(identity);
        retainedAsDraft.push(identity);
        continue;
      }
      if (local.revision <= base) {
        // Local unchanged since the last observed server state: the server
        // change is a fast-forward and may apply silently — EXCEPT at equal
        // revision with a different digest, where the server-wins policy
        // still retains the local specification as a draft.
        if (record.revision === local.revision) {
          const localSpec = local.activeSpecificationDigest
            ? await this.#store.getSpecification(local.activeSpecificationDigest)
            : null;
          if (localSpec) await this.#retainDraft(identity, localSpec);
          await this.#applyServerRecord(record, specificationsByDigest);
          this.#bases.set(identity, record.revision);
          basesChanged = true;
          applied.push(identity);
          retainedAsDraft.push(identity);
          continue;
        }
        if (record.revision > local.revision) {
          await this.#applyServerRecord(record, specificationsByDigest);
          this.#bases.set(identity, record.revision);
          basesChanged = true;
          applied.push(identity);
          continue;
        }
        // Server is behind an unchanged local record: keep local.
        skipped.push(identity);
        continue;
      }
      // Local changed since the last observed server state and the server
      // still sits at (or behind) it: local wins; nothing to apply.
      skipped.push(identity);
    }
    if (basesChanged) await this.#persistBases();
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
