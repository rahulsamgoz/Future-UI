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
