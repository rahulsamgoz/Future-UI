/**
 * Server-side device preference merge (R2 stream B). The API holds no device
 * preference state otherwise; `synced_preferences` is the server side of
 * POST /v1/profiles/:profileId/sync.
 *
 * Merge rules (architecture section 9 — revision-based conflicts, never
 * silently merged), applied in ONE transaction:
 * - server revision <  incoming → replace with the incoming record;
 * - equal revision, equal digest → no-op (agreed; classified accepted);
 * - equal revision, DIFFERENT digest → server wins; the key is reported in
 *   serverWins AND retainedAsDraft so the pushing device retains its local
 *   specification as a draft instead of dropping it;
 * - server revision >  incoming → ignore (server is ahead); the key is
 *   unclassified and the authoritative bundle carries the server state.
 */
import {
  syncIdentityString,
  UiIntelligenceError,
  type PreferenceRecord,
  type SpecificationRecord,
  type SyncBundle,
  type SyncMergeResult,
} from "@ui-intelligence/protocol";
import { z } from "zod";
import type { Db } from "./db.js";
import { nowIso } from "./db.js";

export const syncBundleSchema = z.object({
  projectId: z.string().min(1),
  deviceLabel: z.string().min(1).max(200),
  pushedAt: z.string().min(1),
  preferences: z
    .array(
      z.object({
        key: z.object({
          profileId: z.string().min(1),
          projectId: z.string().min(1),
          scope: z.enum(["app", "page", "entity", "instance"]),
          scopeKey: z.string().min(1),
        }),
        activeSpecificationDigest: z.string().nullable(),
        revision: z.number().int().nonnegative(),
        contractVersion: z.number().int().nonnegative(),
        updatedAt: z.string().min(1),
      }),
    )
    .max(10_000),
  specifications: z
    .array(
      z.object({
        digest: z.string().min(1),
        proposal: z.any(),
        requiredRendererVersions: z.record(z.number()),
        createdAt: z.string().min(1),
      }),
    )
    .max(10_000),
});

type SyncedRow = {
  profile_id: string;
  project_id: string;
  scope: string;
  scope_key: string;
  revision: number;
  active_spec_digest: string | null;
  spec_json: string | null;
  updated_at: string;
};

function rowToRecord(row: SyncedRow, profileId: string, projectId: string): PreferenceRecord {
  return {
    key: {
      profileId,
      projectId,
      scope: row.scope as PreferenceRecord["key"]["scope"],
      scopeKey: row.scope_key,
    },
    activeSpecificationDigest: row.active_spec_digest,
    revision: row.revision,
    // contractVersion is not part of the synced server row; the authoritative
    // record carries the local contract check (the runtime revalidates every
    // applied specification against the CURRENT contract anyway).
    contractVersion: 0,
    updatedAt: row.updated_at,
  };
}

export function authoritativeBundle(db: Db, profileId: string, projectId: string): SyncBundle {
  const rows = db
    .prepare(
      "SELECT * FROM synced_preferences WHERE profile_id = ? AND project_id = ? ORDER BY scope, scope_key",
    )
    .all(profileId, projectId) as SyncedRow[];
  const specifications = new Map<string, SpecificationRecord>();
  for (const row of rows) {
    if (!row.spec_json) continue;
    const spec = JSON.parse(row.spec_json) as SpecificationRecord;
    specifications.set(spec.digest, spec);
  }
  return {
    profileId,
    projectId,
    preferences: rows.map((row) => rowToRecord(row, profileId, projectId)),
    specifications: [...specifications.values()],
    deviceLabel: "server",
    pushedAt: nowIso(),
  };
}

/**
 * Response-boundary identity translation (closure audit, finding 2): the
 * client submits ITS project identifier (the reference app uses the project
 * NAME "reference-app"; other clients may use the canonical id). Stored rows
 * always keep the CANONICAL project id, but the authoritative bundle handed
 * back to the caller must use the SAME identifier the client sent — the
 * SyncManager on the device applies only records whose key.projectId matches
 * its own namespace, so a canonical-only response would be silently skipped.
 * Only the response is relabeled; rows in synced_preferences stay canonical,
 * and records of other projects are never included (namespace isolation).
 */
export function relabelAuthoritativeProjectId(result: SyncMergeResult, projectId: string): SyncMergeResult {
  return {
    ...result,
    authoritative: {
      ...result.authoritative,
      projectId,
      preferences: result.authoritative.preferences.map((record) => ({
        ...record,
        key: { ...record.key, projectId },
      })),
    },
  };
}

/** Merge one pushed bundle into synced_preferences within a single transaction. */
export function mergeSyncBundle(
  db: Db,
  profileId: string,
  bundle: SyncBundle,
  options?: { registerProfileOwner?: string },
): SyncMergeResult {
  const accepted: string[] = [];
  const serverWins: string[] = [];
  const specificationsByDigest = new Map(
    bundle.specifications.map((specification) => [specification.digest, specification]),
  );

  const tx = db.transaction(() => {
    // Profile registration is part of the SAME transaction as the merge
    // (closure audit, finding 1): the ownership row is only created when the
    // request has already been authorized (project resolved + membership
    // checked by the caller) and the merge is actually running. A rejected
    // request never reaches this point, so it leaves no ownership row.
    if (options?.registerProfileOwner) {
      db.prepare(
        "INSERT OR IGNORE INTO sync_profiles (profile_id, owner_user_id, created_at) VALUES (?, ?, ?)"
      ).run(profileId, options.registerProfileOwner, nowIso());
    }
    for (const record of bundle.preferences) {
      const identity = syncIdentityString(record.key);
      const existing = db
        .prepare(
          "SELECT revision, active_spec_digest FROM synced_preferences WHERE profile_id = ? AND project_id = ? AND scope = ? AND scope_key = ?",
        )
        .get(profileId, bundle.projectId, record.key.scope, record.key.scopeKey) as
        | { revision: number; active_spec_digest: string | null }
        | undefined;

      if (existing === undefined || existing.revision < record.revision) {
        const specification = record.activeSpecificationDigest
          ? specificationsByDigest.get(record.activeSpecificationDigest)
          : undefined;
        if (record.activeSpecificationDigest && !specification) {
          throw new UiIntelligenceError(
            "SCHEMA_INVALID",
            `sync bundle is missing the specification for digest ${record.activeSpecificationDigest}`,
            { httpStatus: 422 },
          );
        }
        db.prepare(
          `INSERT INTO synced_preferences (profile_id, project_id, scope, scope_key, revision, active_spec_digest, spec_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (profile_id, project_id, scope, scope_key)
           DO UPDATE SET revision = excluded.revision, active_spec_digest = excluded.active_spec_digest,
             spec_json = excluded.spec_json, updated_at = excluded.updated_at`,
        ).run(
          profileId,
          bundle.projectId,
          record.key.scope,
          record.key.scopeKey,
          record.revision,
          record.activeSpecificationDigest,
          specification ? JSON.stringify(specification) : null,
          record.updatedAt || nowIso(),
        );
        accepted.push(identity);
        continue;
      }

      if (existing.revision === record.revision) {
        if (existing.active_spec_digest === record.activeSpecificationDigest) {
          // Already agreed.
          accepted.push(identity);
        } else {
          // Equal revision, different digest: the server state stands; the
          // device must retain its local specification as a draft.
          serverWins.push(identity);
        }
      }
      // existing.revision > record.revision: server ahead — unclassified.
    }
    return {
      accepted,
      serverWins,
      retainedAsDraft: [...serverWins],
      authoritative: authoritativeBundle(db, profileId, bundle.projectId),
    } satisfies SyncMergeResult;
  });

  return tx() as SyncMergeResult;
}
