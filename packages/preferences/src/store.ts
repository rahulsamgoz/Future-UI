/**
 * Preference store port (architecture section 9). Both the in-memory and
 * IndexedDB implementations satisfy this interface with identical
 * transactional semantics.
 *
 * Participant/proposed shapes mirror runtime-core's PreferenceStoreLike
 * structurally (the packages do not depend on each other).
 */
import type {
  ApplicationRecord,
  ApplicationStatus,
  PreferenceExportBundle,
  PreferenceKey,
  PreferenceRecord,
  SpecificationRecord,
  SyncOperation,
} from "@ui-intelligence/protocol";

export type ApplicationParticipantInput = {
  key: PreferenceKey;
  previousRevision: number;
  previousDigest: string | null;
  proposedDigest: string | null;
  contractVersion?: number;
};

export type ProposedSpecificationEntry = {
  digest: string;
  requiredRendererVersions: Record<string, number>;
};

/**
 * Application record extended with the revisions each participant had after
 * finalization, so undo can detect that a participant has moved on. The
 * protocol ApplicationRecord is unchanged; this is a store-level extension.
 */
export type StoredApplicationRecord = ApplicationRecord & {
  postApplyRevisions?: Record<string, number>;
};

export type UndoResult = { restored: string[]; conflicts?: string[] };

export type ImportResult = { imported: number; skipped: number };

export interface PreferenceStore {
  getPreference(key: PreferenceKey): Promise<PreferenceRecord | null>;
  setPreference(record: PreferenceRecord): Promise<void>;
  getSpecification(digest: string): Promise<SpecificationRecord | null>;
  putSpecification(record: SpecificationRecord): Promise<void>;

  /** One transaction: verify every participant's expected revision, write pending application. Throws PreferenceConflictError on mismatch. */
  beginApplication(
    applicationId: string,
    participants: ApplicationParticipantInput[],
    proposed: Record<string, ProposedSpecificationEntry>,
  ): Promise<void>;
  /** One transaction: verify still pending and revisions unchanged; activate and bump participant revisions. */
  finalizeApplication(applicationId: string): Promise<void>;
  /** One transaction: mark failed with reason; preferences were never touched by a pending application. */
  rollbackApplication(applicationId: string, reason: string): Promise<void>;
  getApplication(applicationId: string): Promise<StoredApplicationRecord | null>;
  /** One transaction: restore every participant's previous digest/revision; participants that moved on are reported, not overwritten. */
  undoApplication(applicationId: string): Promise<UndoResult>;
  /** Startup recovery: pending applications are interrupted commits; mark failed, preferences need no restore. */
  recoverPending(): Promise<string[]>;

  exportBundle(profileId: string, projectId: string): Promise<PreferenceExportBundle>;
  importBundle(bundle: PreferenceExportBundle): Promise<ImportResult>;
  listApplications(status?: ApplicationStatus): Promise<ApplicationRecord[]>;
  close(): void | Promise<void>;
}

export type { SyncOperation };
