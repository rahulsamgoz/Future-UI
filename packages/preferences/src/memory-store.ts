/**
 * In-memory preference store: synchronous semantics expressed through the
 * same async interface, used for tests, SSR, and non-browser contexts.
 * Semantics are identical to IdbPreferenceStore; the two implementations
 * share the same transaction protocol by construction.
 */
import type {
  ApplicationStatus,
  PreferenceExportBundle,
  PreferenceKey,
  PreferenceRecord,
  SpecificationRecord,
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

function nowIso(): string {
  return new Date().toISOString();
}

export class MemoryPreferenceStore implements PreferenceStore {
  #preferences = new Map<string, PreferenceRecord>();
  #specifications = new Map<string, SpecificationRecord>();
  #applications = new Map<string, StoredApplicationRecord>();

  async getPreference(key: PreferenceKey): Promise<PreferenceRecord | null> {
    const record = this.#preferences.get(preferenceKeyToString(key));
    return record ? { ...record, key: { ...record.key } } : null;
  }

  async setPreference(record: PreferenceRecord): Promise<void> {
    this.#preferences.set(preferenceKeyToString(record.key), {
      ...record,
      key: { ...record.key },
    });
  }

  async getSpecification(digest: string): Promise<SpecificationRecord | null> {
    const record = this.#specifications.get(digest);
    return record ? { ...record } : null;
  }

  async putSpecification(record: SpecificationRecord): Promise<void> {
    this.#specifications.set(record.digest, { ...record });
  }

  async beginApplication(
    applicationId: string,
    participants: ApplicationParticipantInput[],
    proposed: Record<string, ProposedSpecificationEntry>,
  ): Promise<void> {
    for (const participant of participants) {
      const existing = this.#preferences.get(preferenceKeyToString(participant.key));
      const currentRevision = existing?.revision ?? 0;
      if (currentRevision !== participant.previousRevision) {
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
    const record: StoredApplicationRecord = {
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
    this.#applications.set(applicationId, record);
    // Ensure the proposed specifications are persisted so undo/restore can
    // reactivate previous digests later.
    for (const [scopeKey, entry] of Object.entries(proposed)) {
      void scopeKey;
      if (!this.#specifications.has(entry.digest)) {
        this.#specifications.set(entry.digest, {
          digest: entry.digest,
          proposal: null,
          requiredRendererVersions: { ...entry.requiredRendererVersions },
          createdAt: nowIso(),
        });
      }
    }
  }

  async finalizeApplication(applicationId: string): Promise<void> {
    const application = this.#applications.get(applicationId);
    if (!application) {
      throw new Error(`application "${applicationId}" not found`);
    }
    if (application.status !== "pending") {
      throw new Error(
        `application "${applicationId}" is ${application.status}, expected pending`,
      );
    }
    const postApplyRevisions: Record<string, number> = {};
    const existingContractVersions = new Map<string, number>();
    for (const participant of application.participants) {
      const identity = preferenceKeyToString(participant.key);
      const existing = this.#preferences.get(identity);
      const currentRevision = existing?.revision ?? 0;
      if (currentRevision !== participant.previousRevision) {
        throw new PreferenceConflictError(
          `preference revision moved before finalize: expected ${participant.previousRevision}, current ${currentRevision}`,
          {
            conflictKey: participant.key,
            expectedRevision: participant.previousRevision,
            currentRevision,
          },
        );
      }
      if (existing?.contractVersion !== undefined) {
        existingContractVersions.set(identity, existing.contractVersion);
      }
    }
    for (const participant of application.participants) {
      const identity = preferenceKeyToString(participant.key);
      const revision = participant.previousRevision + 1;
      postApplyRevisions[identity] = revision;
      this.#preferences.set(identity, {
        key: { ...participant.key },
        activeSpecificationDigest: participant.proposedDigest,
        revision,
        contractVersion: existingContractVersions.get(identity) ?? 0,
        updatedAt: nowIso(),
      });
    }
    application.status = "active";
    application.postApplyRevisions = postApplyRevisions;
  }

  async rollbackApplication(applicationId: string, reason: string): Promise<void> {
    const application = this.#applications.get(applicationId);
    if (!application) {
      throw new Error(`application "${applicationId}" not found`);
    }
    // A pending application never changed preference records, so nothing to
    // restore — just record the terminal failed state.
    application.status = "failed";
    application.failureReason = reason;
  }

  async getApplication(applicationId: string): Promise<StoredApplicationRecord | null> {
    const application = this.#applications.get(applicationId);
    if (!application) return null;
    return {
      ...application,
      participants: application.participants.map((p) => ({ ...p, key: { ...p.key } })),
      postApplyRevisions: application.postApplyRevisions
        ? { ...application.postApplyRevisions }
        : undefined,
    };
  }

  async undoApplication(applicationId: string): Promise<UndoResult> {
    const application = this.#applications.get(applicationId);
    if (!application) {
      throw new Error(`application "${applicationId}" not found`);
    }
    if (application.status !== "active") {
      throw new Error(
        `application "${applicationId}" is ${application.status}, expected active`,
      );
    }
    const restored: string[] = [];
    const conflicts: string[] = [];
    for (const participant of application.participants) {
      const identity = preferenceKeyToString(participant.key);
      const expectedPost =
        application.postApplyRevisions?.[identity] ??
        participant.previousRevision + 1;
      const existing = this.#preferences.get(identity);
      const currentRevision = existing?.revision ?? 0;
      if (currentRevision !== expectedPost) {
        conflicts.push(identity);
        continue;
      }
      if (participant.previousRevision === 0 && participant.previousDigest === null) {
        // No record existed before the application; restore by removing it.
        this.#preferences.delete(identity);
      } else {
        this.#preferences.set(identity, {
          key: { ...participant.key },
          activeSpecificationDigest: participant.previousDigest,
          revision: participant.previousRevision,
          contractVersion: existing?.contractVersion ?? 0,
          updatedAt: nowIso(),
        });
      }
      restored.push(identity);
    }
    application.status = "reverted";
    return { restored, ...(conflicts.length > 0 ? { conflicts } : {}) };
  }

  async recoverPending(): Promise<string[]> {
    const recovered: string[] = [];
    for (const application of this.#applications.values()) {
      if (application.status === "pending") {
        application.status = "failed";
        application.failureReason = "interrupted";
        recovered.push(application.applicationId);
      }
    }
    return recovered;
  }

  async exportBundle(profileId: string, projectId: string): Promise<PreferenceExportBundle> {
    const preferences = [...this.#preferences.values()]
      .filter(
        (record) =>
          record.key.profileId === profileId && record.key.projectId === projectId,
      )
      .map((record) => ({ ...record, key: { ...record.key } }));
    const referencedDigests = new Set(
      preferences.map((record) => record.activeSpecificationDigest).filter((d): d is string => d !== null),
    );
    const specifications = [...this.#specifications.values()]
      .filter((record) => referencedDigests.has(record.digest))
      .map((record) => ({ ...record }));
    return {
      formatVersion: 1,
      exportedAt: nowIso(),
      profileId,
      projectId,
      preferences,
      specifications,
    };
  }

  async importBundle(bundle: PreferenceExportBundle): Promise<ImportResult> {
    let imported = 0;
    let skipped = 0;
    for (const specification of bundle.specifications) {
      if (!this.#specifications.has(specification.digest)) {
        this.#specifications.set(specification.digest, { ...specification });
      }
    }
    for (const record of bundle.preferences) {
      const identity = preferenceKeyToString(record.key);
      const existing = this.#preferences.get(identity);
      // Never silently overwrite: skip records whose revision is not newer.
      if (existing && existing.revision >= record.revision) {
        skipped += 1;
        continue;
      }
      this.#preferences.set(identity, { ...record, key: { ...record.key } });
      imported += 1;
    }
    return { imported, skipped };
  }

  async listApplications(status?: ApplicationStatus): Promise<StoredApplicationRecord[]> {
    return [...this.#applications.values()]
      .filter((application) => status === undefined || application.status === status)
      .map((application) => ({ ...application }));
  }

  close(): void {
    this.#preferences.clear();
    this.#specifications.clear();
    this.#applications.clear();
  }
}
