import type {
  ApplicationRecord,
  JsonValue,
  LayoutNode,
  PreferenceKey,
  Proposal,
  TargetReadSet,
} from "@ui-intelligence/protocol";
import { newId } from "@ui-intelligence/protocol";
import type { PreferenceStore } from "@ui-intelligence/preferences";
import { OperationCoordinator } from "@ui-intelligence/runtime-core";
import { IdbPreferenceStore, MemoryPreferenceStore } from "@ui-intelligence/preferences";
import { ActivePreferenceStore, preferenceScopeKey } from "./ActivePreferenceStore.js";

export type ApplyCandidate = {
  representation: string;
  properties: Record<string, JsonValue>;
  digest: string;
  requiredRendererVersions: Record<string, number>;
};

export type Switcher = Parameters<OperationCoordinator["apply"]>[4];

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
  scope: Proposal["target"]["scope"]
): Proposal {
  return {
    schemaVersion: 1,
    proposalId,
    target: {
      entityId: entityKey,
      entityVersionId: `${entityKey}@1`,
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
    presentation: { type: representation, properties, dataBinding: "", actions: [] },
    origin: { kind: "generated", referenceIds: [] },
  };
}

export class PreferenceService {
  readonly store: PreferenceStore;
  readonly coordinator: OperationCoordinator;
  readonly active = new ActivePreferenceStore();
  readonly profileId: string;
  /** Preferences retained as recoverable drafts because the current build is incompatible. */
  readonly drafts = new Map<string, { reason: string; digest: string }>();

  constructor() {
    this.profileId = ensureProfileId();
    if (typeof indexedDB !== "undefined") {
      this.store = new IdbPreferenceStore();
    } else {
      // Storage unavailable: session-only operation, accurately reported.
      this.store = new MemoryPreferenceStore();
    }
    this.coordinator = new OperationCoordinator();
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
  async init(knownScopeKeys: string[], contractVersions: Map<string, number>): Promise<void> {
    await this.coordinator.recoverAtStartup(this.store);
    for (const scopeKey of knownScopeKeys) {
      const scope = PreferenceService.scopeOf(scopeKey);
      const pref = await this.store.getPreference(this.key(scope, scopeKey));
      if (!pref || !pref.activeSpecificationDigest) continue;
      const spec = await this.store.getSpecification(pref.activeSpecificationDigest);
      if (!spec) continue;
      // Release compatibility: revalidate against the current contract.
      const expectedVersion = contractVersions.get(scopeKey);
      if (expectedVersion !== undefined && spec.proposal && (spec.proposal as { contractVersion?: number }).contractVersion !== undefined) {
        const specContractVersion = (spec.proposal as { contractVersion?: number }).contractVersion;
        if (specContractVersion !== expectedVersion) {
          this.drafts.set(scopeKey, {
            reason: `contract changed (stored v${specContractVersion}, current v${expectedVersion})`,
            digest: pref.activeSpecificationDigest,
          });
          continue;
        }
      }
      const presentation = (spec.proposal as { presentation?: { type?: string; properties?: Record<string, JsonValue> } }).presentation;
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

  /** Apply one accepted candidate to one target scope. */
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
      scope === "page" ? "page" : scope === "instance" ? "instance" : "entity"
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
        contractVersion: 1,
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
          "batch"
        );
        await this.store.putSpecification({
          digest: p.candidate.digest,
          proposal,
          requiredRendererVersions: p.candidate.requiredRendererVersions,
          createdAt: new Date().toISOString(),
        });
      }

      // Phase 1: record the pending change with the complete target read set.
      const proposed: Record<string, { digest: string; requiredRendererVersions: Record<string, number> }> = {};
      for (const p of participants) {
        const scope = PreferenceService.scopeOf(p.scopeKey);
        const key = this.key(scope, p.scopeKey);
        const current = await this.store.getPreference(key);
        participantRecords.push({
          key,
          previousRevision: current?.revision ?? 0,
          previousDigest: current?.activeSpecificationDigest ?? null,
          proposedDigest: p.candidate.digest,
          contractVersion: 1,
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
      return { status: "failed", applicationId, reason, failedScopeKey: prepared.at(-1)?.scopeKey };
    }
  }

  /** Undo one application (single or batch). Never overwrites newer edits. */
  async undo(applicationId: string): Promise<{ restored: string[]; conflicts?: string[] }> {
    const result = await this.coordinator.undo(this.store, applicationId);
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
        }
      }
    }
    return result;
  }

  async lastApplication(): Promise<ApplicationRecord | null> {
    const apps = await this.store.listApplications("active");
    return apps.length ? (apps[apps.length - 1] as ApplicationRecord) : null;
  }

  async listApplications(): Promise<ApplicationRecord[]> {
    return this.store.listApplications();
  }

  /** Full local reset: independent control, always reachable (protocol section 8). */
  async resetAll(knownScopeKeys: string[]): Promise<void> {
    for (const scopeKey of knownScopeKeys) {
      const scope = PreferenceService.scopeOf(scopeKey);
      const pref = await this.store.getPreference(this.key(scope, scopeKey));
      if (pref) {
        await this.store.setPreference({
          ...pref,
          activeSpecificationDigest: null,
          revision: pref.revision + 1,
          updatedAt: new Date().toISOString(),
        });
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
}

export type { LayoutNode };
