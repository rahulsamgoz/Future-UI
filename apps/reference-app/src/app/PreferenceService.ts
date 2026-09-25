import type {
  ApplicationRecord,
  JsonValue,
  PreferenceKey,
  Proposal,
  SemanticRule,
  SyncBundle,
  SyncMergeResult,
  TargetReadSet,
} from "@ui-intelligence/protocol";
import { newId } from "@ui-intelligence/protocol";
import type { PreferenceStore } from "@ui-intelligence/preferences";
import { PreferenceBroadcast, SyncManager, type SyncTransport } from "@ui-intelligence/preferences";
import type { RendererRegistry } from "@ui-intelligence/runtime-core";
import { RuleEngine, OperationCoordinator, isRevisionConflict } from "@ui-intelligence/runtime-core";
import { IdbPreferenceStore, MemoryPreferenceStore } from "@ui-intelligence/preferences";
import { ActivePreferenceStore } from "./ActivePreferenceStore.js";

export type ApplyCandidate = {
  representation: string;
  properties: Record<string, JsonValue>;
  digest: string;
  requiredRendererVersions: Record<string, number>;
  /** Contract identity the candidate was validated against. */
  contractVersion: number;
  dataBindingId: string;
  actionIds: string[];
};

export type Switcher = Parameters<OperationCoordinator["apply"]>[4];

/** Outcome of a device sync attempt (never throws; errors are reported). */
export type DeviceSyncResult =
  | { ok: true; synced: number; conflicts: number }
  | { ok: false; error: string };

const PROJECT_ID = "reference-app";

/** Opaque host-provided profile ID. Never used as backend authorization. */
function ensureProfileId(): string {
  try {
    const existing = localStorage.getItem("ui-intel-profile-id");
    if (existing) return existing;
    const id = newId("profile");
    localStorage.setItem("ui-intel-profile-id", id);
    return id;
  } catch {
    return "ephemeral-profile";
  }
}

/**
 * Glue between the local preference transaction store and the app's live
 * preference view. Implements the application protocol of section 9:
 * record pending → switch → finalize (or rollback), recovery at startup,
 * revision-based conflict handling, and atomic batch activation.
 */
function buildProposal(
  proposalId: string,
  entityKey: string,
  representation: string,
  properties: Record<string, JsonValue>,
  readSet: TargetReadSet,
  scope: Proposal["target"]["scope"],
  contractVersion = 1,
  dataBinding = "",
  actions: string[] = []
): Proposal {
  return {
    schemaVersion: 1,
    proposalId,
    target: {
      entityId: entityKey,
      entityVersionId: `${entityKey}@${contractVersion}`,
      scope,
      lockedEntityIds: [],
      batchTargets: [],
    },
    preconditions: {
      appBuildId: readSet.appBuildId,
      contractDigest: readSet.contractDigest,
      policyVersion: readSet.policyVersion,
      preferenceRevision: readSet.preferenceRevision,
    },
    presentation: { type: representation, properties, dataBinding, actions },
    origin: { kind: "generated", referenceIds: [] },
    // Store-level extension: the contract version this specification was
    // validated against, so startup revalidation can detect contract bumps.
    contractVersion,
    dataBindingId: dataBinding,
    actionIds: actions,
  } as Proposal & { contractVersion: number; dataBindingId: string; actionIds: string[] };
}

/** Read the stored contract version from a specification record's proposal. */
function storedContractVersion(spec: { proposal: unknown }): number | undefined {
  const v = (spec.proposal as { contractVersion?: unknown } | null)?.contractVersion;
  return typeof v === "number" ? v : undefined;
}

export class PreferenceService {
  readonly store: PreferenceStore;
  readonly coordinator: OperationCoordinator;
  readonly active = new ActivePreferenceStore();
  /** Opaque host-provided profile ID; reassigned by switchProfile. Never used as backend authorization. */
  profileId: string;
  readonly broadcast: PreferenceBroadcast;
  private unsubscribeBroadcast: (() => void) | null = null;
  /** Preferences retained as recoverable drafts because the current build is incompatible. */
  readonly drafts = new Map<string, { reason: string; digest: string }>();
  /** Semantic rules loaded from the store, evaluated through a RuleEngine (R2 part C). */
  #ruleEngine: RuleEngine = new RuleEngine([]);
  #renderers: RendererRegistry | null = null;
  /** Scope keys the live view was (re)hydrated for; refreshed after device sync. */
  #knownScopeKeys: string[] = [];
  /** Base URL of the device-sync API (null = same-origin); set by the host at boot. */
  apiBaseUrl: string | null = null;

  constructor() {
    this.profileId = ensureProfileId();
    if (typeof indexedDB !== "undefined") {
      this.store = new IdbPreferenceStore();
    } else {
      // Storage unavailable: session-only operation, accurately reported.
      this.store = new MemoryPreferenceStore();
    }
    this.coordinator = new OperationCoordinator();
    // Cross-tab conflict handling (architecture section 9): after a commit,
    // other tabs are notified so they can revalidate. This subscription keeps
    // the live view current when ANOTHER tab applies or undoes — without a
    // reload. BroadcastChannel does not echo to the sender; the local path
    // already updates `active` (and re-reading here is idempotent anyway).
    this.broadcast = new PreferenceBroadcast();
    this.unsubscribeBroadcast = this.broadcast.subscribe((key) => {
      void this.handleRemoteCommit(key);
    });
  }

  /** Release the cross-tab channel (app unmount). */
  dispose(): void {
    this.unsubscribeBroadcast?.();
    this.unsubscribeBroadcast = null;
    this.broadcast.close();
  }

  /** App-level defaults from the handoff file; personal preferences win. */
  async loadAppDefaults(): Promise<void> {
    try {
      const res = await fetch("/ui-intelligence.preferences.json");
      if (!res.ok) return;
      const file = (await res.json()) as {
        defaults?: Array<{
          scopeKey: string;
          scope?: "entity" | "instance" | "page";
          representation: string;
          properties?: Record<string, JsonValue>;
          contractVersion?: number;
        }>;
      };
      for (const entry of file.defaults ?? []) {
        // Only fill gaps: an explicit personal preference always wins.
        if (this.active.get(entry.scopeKey)) continue;
        this.active.set(entry.scopeKey, {
          representation: entry.representation,
          properties: entry.properties ?? {},
          digest: null, // app default, not a personal specification
          revision: 0,
        });
      }
    } catch {
      // No handoff file (normal case) or fetch unavailable — no defaults.
    }
  }

  get persistenceAvailable(): boolean {
    return typeof indexedDB !== "undefined";
  }

  private key(scope: PreferenceKey["scope"], scopeKey: string): PreferenceKey {
    return { profileId: this.profileId, projectId: PROJECT_ID, scope, scopeKey };
  }

  private static scopeOf(scopeKey: string): "entity" | "instance" | "page" {
    if (scopeKey.startsWith("page:")) return "page";
    return scopeKey.includes("#") ? "instance" : "entity";
  }

  /** Startup: recover interrupted commits, revalidate stored preferences. */
  async init(
    knownScopeKeys: string[],
    contractVersions: Map<string, number>,
    renderers?: RendererRegistry,
  ): Promise<void> {
    if (renderers) this.#renderers = renderers;
    await this.loadRules();
    await this.coordinator.recoverAtStartup(this.store);

    // App-level defaults from the developer handoff file
    // (ui-intelligence.preferences.json): applied ONLY where the user has no
    // personal preference (spec section 9 precedence: app defaults < org <
    // personal). Failures to load are non-fatal.
    await this.loadAppDefaults();
    this.#knownScopeKeys = [...knownScopeKeys];
    await this.rehydrate(knownScopeKeys, contractVersions);
  }

  /**
   * The live RuleEngine over this profile's persisted semantic rules. Rules
   * are hints — the precedence explicit preference > rule > contract default
   * is applied at the call site (see useResolvedRepresentation).
   */
  get rules(): RuleEngine {
    return this.#ruleEngine;
  }

  /** Reload the rule list from the store and rebuild the engine (R2 part C). */
  private async loadRules(): Promise<void> {
    const rules = await this.store.getRules(this.profileId, PROJECT_ID);
    this.#ruleEngine = new RuleEngine(rules, this.#renderers ?? undefined);
  }

  /** Persist a new rule list and rebuild the engine. */
  async setRules(rules: SemanticRule[]): Promise<void> {
    await this.store.putRules(this.profileId, PROJECT_ID, rules);
    await this.loadRules();
    // Representation resolution may change anywhere; force consumers of the
    // active-preference view to re-read.
    this.active.touch();
  }

  /**
   * Account switching (architecture section 9): change namespaces and clear
   * in-memory selections and cached context. The store isolates records by
   * profileId, so the new profile never reads the previous profile's
   * preferences; this rehydrates the live view from the new profile's
   * confirmed state.
   */
  async switchProfile(
    profileId: string,
    knownScopeKeys: string[],
    contractVersions: Map<string, number>
  ): Promise<void> {
    this.profileId = profileId;
    this.active.clear();
    this.drafts.clear();
    // Rules are per profile: reload them for the new namespace.
    await this.loadRules();
    await this.coordinator.recoverAtStartup(this.store);
    this.#knownScopeKeys = [...knownScopeKeys];
    await this.rehydrate(knownScopeKeys, contractVersions);
  }

  /** Rebuild the live view from the current profile's stored preferences. */
  private async rehydrate(
    knownScopeKeys: string[],
    contractVersions: Map<string, number>
  ): Promise<void> {
    for (const scopeKey of knownScopeKeys) {
      const scope = PreferenceService.scopeOf(scopeKey);
      const pref = await this.store.getPreference(this.key(scope, scopeKey));
      if (!pref || !pref.activeSpecificationDigest) continue;
      const spec = await this.store.getSpecification(pref.activeSpecificationDigest);
      if (!spec) continue;
      // Release compatibility: revalidate against the current contract.
      const expectedVersion = contractVersions.get(scopeKey);
      const stored = spec.proposal as { contractVersion?: number } | null | undefined;
      if (
        expectedVersion !== undefined &&
        stored?.contractVersion !== undefined &&
        stored.contractVersion !== expectedVersion
      ) {
        this.drafts.set(scopeKey, {
          reason: `contract changed (stored v${stored.contractVersion}, current v${expectedVersion})`,
          digest: pref.activeSpecificationDigest,
        });
        continue;
      }
      const presentation = (
        spec.proposal as { presentation?: { type?: string; properties?: Record<string, JsonValue> } }
      ).presentation;
      if (presentation?.type) {
        this.active.set(scopeKey, {
          representation: presentation.type,
          properties: presentation.properties ?? {},
          digest: pref.activeSpecificationDigest,
          revision: pref.revision,
        });
      }
    }
  }

  /**
   * React to a preference commit (architecture section 9). Called for remote
   * tab commits via the broadcast channel and — because PreferenceBroadcast
   * invokes local subscribers directly — after this tab's own commits too.
   * Re-reads the shared store and refreshes the live view to the confirmed
   * revision; idempotent.
   */
  async handleRemoteCommit(key: PreferenceKey): Promise<void> {
    if (key.profileId !== this.profileId || key.projectId !== PROJECT_ID) return;
    const profileAtStart = this.profileId;
    const pref = await this.store.getPreference(key);
    // The profile may have switched while the store read was in flight;
    // never apply a stale read into the new profile's live view.
    if (this.profileId !== profileAtStart) return;
    const scopeKey = key.scopeKey;
    if (pref?.activeSpecificationDigest) {
      const spec = await this.store.getSpecification(pref.activeSpecificationDigest);
      // Re-check after the second async hop: a profile switch may have
      // cleared the live view while this read was in flight.
      if (this.profileId !== profileAtStart) return;
      const presentation = (
        spec?.proposal as
          | { presentation?: { type?: string; properties?: Record<string, JsonValue> } }
          | null
          | undefined
      )?.presentation;
      if (presentation?.type) {
        this.active.set(scopeKey, {
          representation: presentation.type,
          properties: presentation.properties ?? {},
          digest: pref.activeSpecificationDigest,
          revision: pref.revision,
        });
        return;
      }
    }
    // No confirmed preference for this scope (another tab undid to default or
    // reset): clear the live view so the default interface renders.
    if (this.active.get(scopeKey)) {
      this.active.restore(scopeKey, null);
    }
  }

  /**
   * Apply one accepted candidate to one target scope.
   *
   * `readSet` is the CANDIDATE's generation context (audit finding 5): the
   * read set the alternatives were generated against, carried unchanged on
   * the candidate object. Acceptance revalidates against THAT revision — an
   * old candidate whose target moved on (competing writer, device sync)
   * returns { status: "conflict" } and the live view re-reads the winner,
   * instead of silently overwriting a newer revision. The store re-checks
   * the expected revision transactionally in beginApplication.
   */
  async apply(
    scopeKey: string,
    entityKey: string,
    candidate: ApplyCandidate,
    switcher: Switcher,
    readSet: TargetReadSet
  ): Promise<{ status: "active" | "failed" | "conflict"; applicationId?: string; reason?: string }> {
    const scope = PreferenceService.scopeOf(scopeKey);
    const prefKey = this.key(scope, scopeKey);
    const proposal = buildProposal(
      newId("prop"),
      entityKey,
      candidate.representation,
      candidate.properties,
      readSet,
      scope,
      candidate.contractVersion,
      candidate.dataBindingId,
      candidate.actionIds
    );
    // Persist the immutable specification record before the transaction.
    await this.store.putSpecification({
      digest: candidate.digest,
      proposal,
      requiredRendererVersions: candidate.requiredRendererVersions,
      createdAt: new Date().toISOString(),
    });
    const result = await this.coordinator.apply(
      this.store,
      prefKey,
      {
        digest: candidate.digest,
        proposal,
        requiredRendererVersions: candidate.requiredRendererVersions,
        contractVersion: candidate.contractVersion,
      },
      readSet,
      {
        ...switcher,
        commit: async () => {
          const pref = await this.store.getPreference(prefKey);
          this.active.set(scopeKey, {
            representation: candidate.representation,
            properties: candidate.properties,
            digest: candidate.digest,
            revision: pref?.revision ?? 1,
          });
        },
      }
    );
    if (result.status === "active") {
      // Notify other tabs (architecture section 9); BroadcastChannel does not
      // echo to this tab, and the local subscriber re-read is idempotent.
      this.broadcast.notifyCommit(prefKey);
    } else if (result.status === "conflict") {
      // Conflict detected at BEGIN or finalize time: the store still holds
      // the WINNING record. Re-read it so the live view reflects the winning
      // revision instead of the rejected proposal.
      await this.handleRemoteCommit(prefKey);
    }
    return result;
  }

  /**
   * Atomic batch activation: one application record covers every
   * participating target; a single transaction activates the batch's new
   * revision (protocol section 7). Not a claim that separate tabs paint
   * simultaneously.
   */
  async applyBatch(
    participants: Array<{
      scopeKey: string;
      entityKey: string;
      candidate: ApplyCandidate;
      switcher: Switcher;
      readSet: TargetReadSet;
    }>
  ): Promise<{ status: "active" | "failed" | "conflict"; applicationId?: string; reason?: string; failedScopeKey?: string }> {
    const applicationId = newId("app");
    const prepared: Array<{ key: PreferenceKey; scopeKey: string }> = [];
    const participantRecords: Array<{
      key: PreferenceKey;
      previousRevision: number;
      previousDigest: string | null;
      proposedDigest: string | null;
      contractVersion?: number;
    }> = [];
    try {
      // Phase 0: persist the immutable specification records.
      for (const p of participants) {
        const proposal = buildProposal(
          newId("prop"),
          p.entityKey,
          p.candidate.representation,
          p.candidate.properties,
          p.readSet,
          "batch",
          p.candidate.contractVersion,
          p.candidate.dataBindingId,
          p.candidate.actionIds
        );
        await this.store.putSpecification({
          digest: p.candidate.digest,
          proposal,
          requiredRendererVersions: p.candidate.requiredRendererVersions,
          createdAt: new Date().toISOString(),
        });
      }

      // Phase 1: record the pending change with the complete target read set.
      // Expected revisions come from each candidate's GENERATION context
      // (audit finding 5) — what the user saw when these alternatives were
      // produced — not from a fresh store read nor from the possibly newer
      // displayed revision. Same staleness rule as the single apply.
      const proposed: Record<string, { digest: string; requiredRendererVersions: Record<string, number> }> = {};
      for (const p of participants) {
        const scope = PreferenceService.scopeOf(p.scopeKey);
        const key = this.key(scope, p.scopeKey);
        const current = await this.store.getPreference(key);
        participantRecords.push({
          key,
          previousRevision: p.readSet.preferenceRevision,
          previousDigest: current?.activeSpecificationDigest ?? null,
          proposedDigest: p.candidate.digest,
          contractVersion: p.candidate.contractVersion,
        });
        prepared.push({ key, scopeKey: p.scopeKey });
        proposed[p.scopeKey] = {
          digest: p.candidate.digest,
          requiredRendererVersions: p.candidate.requiredRendererVersions,
        };
      }
      await this.store.beginApplication(applicationId, participantRecords, proposed);

      // Phase 2: switch every region through its adapter, preserving prior
      // state until commit.
      for (let i = 0; i < participants.length; i++) {
        const p = participants[i];
        const sw = p.switcher;
        const can = sw.canSwitch();
        if (!can.allowed) {
          await this.store.rollbackApplication(applicationId, can.reason);
          return { status: "failed", applicationId, reason: can.reason, failedScopeKey: p.scopeKey };
        }
        const state = sw.exportState();
        if (!sw.validateState(state, p.candidate.representation)) {
          await this.store.rollbackApplication(applicationId, "state could not be validated for destination renderer");
          return { status: "failed", applicationId, reason: "state transfer validation failed", failedScopeKey: p.scopeKey };
        }
        sw.importState(state);
        await sw.commit();
      }

      // Phase 3: finalize the batch revision.
      await this.store.finalizeApplication(applicationId);
      for (let i = 0; i < participants.length; i++) {
        const pref = await this.store.getPreference(prepared[i].key);
        this.active.set(participants[i].scopeKey, {
          representation: participants[i].candidate.representation,
          properties: participants[i].candidate.properties,
          digest: participants[i].candidate.digest,
          revision: pref?.revision ?? 1,
        });
        this.broadcast.notifyCommit(prepared[i].key);
      }
      return { status: "active", applicationId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        await this.store.rollbackApplication(applicationId, reason);
      } catch {
        /* already rolled back */
      }
      // Restore the prior confirmed revisions in the live view.
      for (const { scopeKey } of prepared) {
        const current = this.active.get(scopeKey);
        const participant = participants.find((p) => p.scopeKey === scopeKey);
        if (current && participant && current.digest === participant.candidate.digest) {
          this.active.restore(scopeKey, null);
        }
      }
      // A stale live view is a CONFLICT (a competing writer moved the store),
      // not a local failure: report it as such and re-read the winning state.
      if (isRevisionConflict(error)) {
        for (const { key, scopeKey } of prepared) {
          await this.handleRemoteCommit(key);
        }
        return { status: "conflict", applicationId, reason };
      }
      return { status: "failed", applicationId, reason, failedScopeKey: prepared.at(-1)?.scopeKey };
    }
  }

  /** Undo one application (single or batch). Never overwrites newer edits. */
  async undo(applicationId: string): Promise<{ restored: string[]; conflicts?: string[] }> {
    const result = await this.coordinator.undo(this.store, applicationId);
    // Opportunistic housekeeping (review core#15): terminal application
    // records accumulate; prune them without ever blocking the undo result.
    void this.store.pruneApplications().catch(() => {});
    const record = await this.store.getApplication(applicationId);
    if (record) {
      for (const participant of record.participants) {
        const scopeKey = participant.key.scopeKey;
        const pref = await this.store.getPreference(participant.key);
        const wasRestored = result.restored.some((id) => id === scopeKey || id.endsWith("\u0000" + scopeKey));
        if (wasRestored) {
          if (pref?.activeSpecificationDigest) {
            const spec = await this.store.getSpecification(pref.activeSpecificationDigest);
            const presentation = (spec?.proposal as { presentation?: { type?: string; properties?: Record<string, JsonValue> } })?.presentation;
            this.active.set(scopeKey, {
              representation: presentation?.type ?? "",
              properties: presentation?.properties ?? {},
              digest: pref.activeSpecificationDigest,
              revision: pref.revision,
            });
          } else {
            this.active.restore(scopeKey, null);
          }
          this.broadcast.notifyCommit(participant.key);
        }
      }
    }
    return result;
  }

  async lastApplication(): Promise<ApplicationRecord | null> {
    const apps = await this.store.listApplications("active");
    return apps.at(-1) ?? null;
  }

  async listApplications(): Promise<ApplicationRecord[]> {
    return this.store.listApplications();
  }

  /** Full local reset: independent control, always reachable (protocol section 8). */
  async resetAll(knownScopeKeys: string[]): Promise<void> {
    for (const scopeKey of knownScopeKeys) {
      const scope = PreferenceService.scopeOf(scopeKey);
      const key = this.key(scope, scopeKey);
      const pref = await this.store.getPreference(key);
      if (pref) {
        await this.store.setPreference({
          ...pref,
          activeSpecificationDigest: null,
          revision: pref.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        this.broadcast.notifyCommit(key);
      }
      this.active.restore(scopeKey, null);
    }
  }

  async exportBundle(): Promise<string> {
    const bundle = await this.store.exportBundle(this.profileId, PROJECT_ID);
    return JSON.stringify(bundle, null, 2);
  }

  async importBundle(json: string): Promise<{ imported: number; skipped: number }> {
    const bundle = JSON.parse(json) as Parameters<PreferenceStore["importBundle"]>[0];
    return this.store.importBundle(bundle);
  }

  /**
   * Device sync (R2 stream B, architecture section 9): push this profile's
   * local preferences to `${apiBaseUrl || ""}/v1/profiles/${profileId}/sync`
   * and apply the authoritative bundle the server returns. The SyncManager
   * is constructed per call on purpose — its sync bases and retained drafts
   * are PERSISTED in the store, so a fresh manager resumes exactly where the
   * previous one left off. When no API is reachable the failure is caught
   * and reported (outbox entries are kept for a later retry). A transport
   * can be injected for tests.
   */
  async syncNow(transportOverride?: SyncTransport): Promise<DeviceSyncResult> {
    const transport: SyncTransport =
      transportOverride ?? this.#fetchSyncTransport();
    const manager = new SyncManager(this.store, transport, {
      profileId: this.profileId,
      projectId: PROJECT_ID,
      deviceLabel: "reference-app-web",
    });
    try {
      const result = await manager.syncNow();
      // Divergent local specifications survive as recoverable drafts in the
      // manager (and the store); surface them in the service's draft view.
      for (const [identity, specification] of manager.drafts) {
        const scopeKey = identity.slice(identity.indexOf(":") + 1);
        if (!this.drafts.has(scopeKey)) {
          this.drafts.set(scopeKey, {
            reason: "divergent edit retained during device sync",
            digest: specification.digest,
          });
        }
      }
      // The authoritative bundle may have changed any known scope: re-read
      // the store so the live view reflects the winning (server) revision.
      for (const scopeKey of this.#knownScopeKeys) {
        const scope = PreferenceService.scopeOf(scopeKey);
        await this.handleRemoteCommit(this.key(scope, scopeKey));
      }
      return { ok: true, synced: result.accepted.length, conflicts: result.retainedAsDraft.length };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Fetch-based push transport for the API sync endpoint. */
  #fetchSyncTransport(): SyncTransport {
    const base = this.apiBaseUrl ?? "";
    return {
      push: async (bundle: SyncBundle): Promise<SyncMergeResult> => {
        const token =
          (import.meta.env.VITE_API_TOKEN as string | undefined) ?? "dev-token";
        const res = await fetch(
          `${base}/v1/profiles/${encodeURIComponent(this.profileId)}/sync`,
          {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            // The endpoint takes the bundle WITHOUT profileId (it is in the URL).
            body: JSON.stringify({
              projectId: bundle.projectId,
              deviceLabel: bundle.deviceLabel,
              pushedAt: bundle.pushedAt,
              preferences: bundle.preferences,
              specifications: bundle.specifications,
            }),
          },
        );
        if (!res.ok) throw new Error(`sync failed: HTTP ${res.status}`);
        return (await res.json()) as SyncMergeResult;
      },
    };
  }
}
