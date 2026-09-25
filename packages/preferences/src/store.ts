/**
 * Preference store port (architecture section 9). Both the in-memory and
 * IndexedDB implementations satisfy this interface with identical
 * transactional semantics.
 *
 * Participant/proposed shapes mirror runtime-core's PreferenceStoreLike
 * structurally (the packages do not depend on each other).
 */
import {
  UiIntelligenceError,
  semanticRuleSchema,
} from "@ui-intelligence/protocol";
import type {
  ApplicationRecord,
  ApplicationStatus,
  PreferenceExportBundle,
  PreferenceKey,
  PreferenceRecord,
  SemanticRule,
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

/**
 * Reserved preference-store scope used to persist the per-profile semantic
 * rule list (R2 part C) as ONE record under scope "app", scopeKey
 * "__rules__". The record is a regular PreferenceRecord carrying a `rules`
 * field, so the whole list travels with exportBundle/importBundle.
 */
export const RULES_SCOPE = "app" as const;
export const RULES_SCOPE_KEY = "__rules__";

export function rulesKey(profileId: string, projectId: string): PreferenceKey {
  return { profileId, projectId, scope: RULES_SCOPE, scopeKey: RULES_SCOPE_KEY };
}

/** Read the persisted rule list out of a rules record (empty when absent). */
export function readRulesFromRecord(record: unknown): SemanticRule[] {
  const rules = (record as { rules?: unknown } | null)?.rules;
  return Array.isArray(rules) ? (rules as SemanticRule[]) : [];
}

/**
 * Validate every rule with the protocol schema; reject the write with
 * SCHEMA_INVALID when any rule is malformed.
 */
export function validateRules(rules: SemanticRule[]): SemanticRule[] {
  for (let i = 0; i < rules.length; i += 1) {
    const result = semanticRuleSchema.safeParse(rules[i]);
    if (!result.success) {
      throw new UiIntelligenceError(
        "SCHEMA_INVALID",
        `semantic rule at index ${i} is invalid: ${result.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`).join("; ")}`,
        { details: { index: i } },
      );
    }
  }
  return rules;
}

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

  /**
   * Opportunistic housekeeping: delete terminal (failed/reverted) application
   * records beyond the most recent `keepLast` (default 50, by createdAt).
   * Active and pending records are NEVER touched — they may still be needed
   * for undo. Returns the number of records removed.
   */
  pruneApplications(keepLast?: number): Promise<number>;

  exportBundle(profileId: string, projectId: string): Promise<PreferenceExportBundle>;
  importBundle(bundle: PreferenceExportBundle): Promise<ImportResult>;
  listApplications(status?: ApplicationStatus): Promise<ApplicationRecord[]>;

  /**
   * Sync outbox (architecture section 9, R2 stream B). Operations are keyed
   * by their unique operationId; enqueue replaces any operation with the same
   * id. The SyncManager enqueues before each push and clears after success.
   */
  listOutbox(): Promise<SyncOperation[]>;
  enqueueSync(operation: SyncOperation): Promise<void>;
  clearSync(operationId: string): Promise<void>;

  /** Read the whole semantic rule list for one profile+project (empty when none stored). */
  getRules(profileId: string, projectId: string): Promise<SemanticRule[]>;
  /** Replace the whole rule list for one profile+project; validates every rule (SCHEMA_INVALID on failure). */
  putRules(profileId: string, projectId: string, rules: SemanticRule[]): Promise<void>;

  close(): void | Promise<void>;
}
