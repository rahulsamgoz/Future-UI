/**
 * Local preference persistence contracts (protocol section 9).
 * Namespaced by application origin, project, and an opaque profile ID.
 */

export type PreferenceKey = {
  profileId: string; // opaque host-provided ID; never used as backend authorization
  projectId: string;
  scope: "app" | "page" | "entity" | "instance";
  scopeKey: string; // app id / page key / entity key / stable instance key
};

export type PreferenceRecord = {
  key: PreferenceKey;
  activeSpecificationDigest: string | null;
  revision: number; // per-key monotonic revision
  contractVersion: number;
  updatedAt: string;
};

export type SpecificationRecord = {
  digest: string; // exact specification digest
  proposal: unknown; // immutable validated proposal
  requiredRendererVersions: Record<string, number>;
  createdAt: string;
};

export type ApplicationStatus = "pending" | "active" | "reverted" | "failed" | "conflict";

export type ApplicationRecord = {
  applicationId: string;
  createdAt: string;
  status: ApplicationStatus;
  /** preference keys participating in this (possibly batch) application */
  participants: Array<{
    key: PreferenceKey;
    previousRevision: number;
    previousDigest: string | null;
    proposedDigest: string | null;
  }>;
  failureReason?: string;
};

export type SyncOperation = {
  operationId: string;
  key: PreferenceKey;
  baseRevision: number;
  digest: string | null;
};

/** Deterministic precedence: app defaults < org < personal; app < page < entity < instance. */
export type PrecedenceContext = {
  profileId: string;
  projectId: string;
  pageKey?: string;
  entityKey?: string;
  instanceKey?: string;
};

export const PREFERENCE_PRECEDENCE = ["app", "page", "entity", "instance"] as const;

export function preferenceScopeRank(scope: PreferenceKey["scope"]): number {
  return PREFERENCE_PRECEDENCE.indexOf(scope);
}

/** Export bundle for local export/import. */
export type PreferenceExportBundle = {
  formatVersion: 1;
  exportedAt: string;
  profileId: string;
  projectId: string;
  preferences: PreferenceRecord[];
  specifications: SpecificationRecord[];
};

export type ConflictResult = { status: "ok" } | { status: "conflict"; currentRevision: number };

/**
 * Device synchronization (R2 stream B, architecture section 9: "its future
 * implementation uses revision-based conflicts, with conflicting layouts
 * never silently merged").
 *
 * A device exports its local bundle (same shape as PreferenceExportBundle
 * plus device identity) and pushes it; the server merges by highest revision
 * per key and returns the authoritative bundle.
 */
export type SyncBundle = {
  profileId: string;
  projectId: string;
  preferences: PreferenceRecord[];
  specifications: SpecificationRecord[];
  deviceLabel: string;
  pushedAt: string;
};

/**
 * Merge outcome per preference key (identity = syncIdentityString):
 * - accepted: the pushed record was stored (higher revision) or already
 *   agreed with the server (equal revision, equal digest).
 * - serverWins: equal revision with a DIFFERENT digest — the server keeps
 *   its record; the pushing device must retain its local specification as a
 *   draft (never silently overwritten).
 * - retainedAsDraft: the subset of serverWins keys the device should keep as
 *   local drafts. The server reports the same keys as serverWins so the
 *   classification survives round trips through any client.
 * - authoritative: the merged server state after the push.
 */
export type SyncMergeResult = {
  accepted: string[];
  serverWins: string[];
  retainedAsDraft: string[];
  authoritative: SyncBundle;
};

/** Composite identity for a preference key within one sync bundle/profile. */
export function syncIdentityString(key: Pick<PreferenceKey, "scope" | "scopeKey">): string {
  return `${key.scope}:${key.scopeKey}`;
}
