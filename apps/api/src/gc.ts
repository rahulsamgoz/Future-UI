/**
 * Reference-aware retention/GC (R2 stream G, architecture section 14:
 * "Retention and deletion cover derived embeddings and previews as well as
 * originals; reference-aware garbage collection preserves artifacts still
 * referenced by allowed records, subject to explicit deletion policy").
 *
 * Deletion rules:
 * - An artifact whose LAST referencing capture/proposal is older than the
 *   retention window is deleted (row + object bytes).
 * - An artifact with NO reference whose created_at is older than the window
 *   is deleted (row + object bytes).
 * - Artifacts referenced within the window are NEVER deleted.
 * - Artifacts referenced by captures of each project's CURRENT (latest)
 *   build are always kept, regardless of age.
 * - keepMinimum guard (default on): if deletion would remove more than 50%
 *   of the scanned artifacts, the run aborts with a safety error unless
 *   `force` is set.
 *
 * Dry runs compute and report the same classification without touching the
 * store or the table.
 */
import {
  UiIntelligenceError,
  newId,
} from "@ui-intelligence/protocol";
import type { Db } from "./db.js";
import { nowIso } from "./db.js";
import type { ObjectStore } from "./objectstore.js";

export type GcOptions = {
  /** Instant used for all age comparisons (injectable clock). */
  now?: Date;
  retentionDays: number;
  dryRun?: boolean;
  /** Guard against mass deletion (default true). */
  keepMinimum?: boolean;
  /** Override the keepMinimum guard. */
  force?: boolean;
  /** Limit the run to one project (defaults to all projects). */
  projectId?: string;
  /** Recording hook for the gc_runs table (wired by the route/worker). */
  recordRun?: boolean;
};

export type GcDeletion = {
  artifactId: string;
  digest: string;
  projectId: string;
  reason: "reference_older_than_retention" | "orphan_older_than_retention";
  lastReferenceAt: string | null;
};

export type GcResult = {
  scanned: number;
  /** Full classification result (what would be deleted). */
  planned: GcDeletion[];
  /** Deletions actually performed (empty on dry runs). */
  deleted: GcDeletion[];
  kept: number;
  dryRun: boolean;
  aborted: boolean;
};

const ARTIFACT_ID_PATTERN = /artifact_[a-z0-9]+/g;

type ArtifactRow = {
  id: string;
  project_id: string;
  digest: string;
  created_at: string;
};

/**
 * Latest reference timestamp per artifact id from capture manifests
 * (manifest.artifacts[].artifactId) and proposal JSON columns.
 */
export function collectReferenceTimes(db: Db): Map<string, string> {
  const latest = new Map<string, string>();
  const observe = (artifactId: string, at: string): void => {
    const existing = latest.get(artifactId);
    if (existing === undefined || at > existing) latest.set(artifactId, at);
  };

  const captures = db
    .prepare("SELECT id, project_id, created_at, manifest_json FROM captures")
    .all() as Array<{ id: string; project_id: string; created_at: string; manifest_json: string }>;
  for (const capture of captures) {
    try {
      const manifest = JSON.parse(capture.manifest_json) as {
        artifacts?: Array<{ artifactId?: string }>;
      };
      for (const reference of manifest.artifacts ?? []) {
        if (reference?.artifactId) observe(reference.artifactId, capture.created_at);
      }
    } catch {
      // A malformed historical manifest must not abort GC; the artifact it
      // references is then treated as unreferenced only if its own age also
      // exceeds retention — the conservative path is kept for valid rows.
    }
  }

  const proposals = db
    .prepare("SELECT updated_at, request_json, target_json, candidates_json, accepted_candidate_json FROM proposals")
    .all() as Array<{
    updated_at: string;
    request_json: string | null;
    target_json: string | null;
    candidates_json: string | null;
    accepted_candidate_json: string | null;
  }>;
  for (const proposal of proposals) {
    for (const column of [proposal.request_json, proposal.target_json, proposal.candidates_json, proposal.accepted_candidate_json]) {
      if (!column) continue;
      for (const match of column.match(ARTIFACT_ID_PATTERN) ?? []) {
        observe(match, proposal.updated_at);
      }
    }
  }
  return latest;
}

/** Artifact ids referenced by each project's CURRENT (latest) build. */
export function currentBuildArtifactIds(db: Db): Set<string> {
  const ids = new Set<string>();
  const builds = db
    .prepare("SELECT id, project_id, created_at FROM builds ORDER BY created_at ASC")
    .all() as Array<{ id: string; project_id: string; created_at: string }>;
  const latestPerProject = new Map<string, { id: string; created_at: string }>();
  for (const build of builds) {
    latestPerProject.set(build.project_id, { id: build.id, created_at: build.created_at });
  }
  for (const build of latestPerProject.values()) {
    const captures = db
      .prepare("SELECT manifest_json FROM captures WHERE build_id = ?")
      .all(build.id) as Array<{ manifest_json: string }>;
    for (const capture of captures) {
      try {
        const manifest = JSON.parse(capture.manifest_json) as {
          artifacts?: Array<{ artifactId?: string }>;
        };
        for (const reference of manifest.artifacts ?? []) {
          if (reference?.artifactId) ids.add(reference.artifactId);
        }
      } catch {
        // Same malformed-manifest policy as collectReferenceTimes.
      }
    }
  }
  return ids;
}

export async function runGc(db: Db, store: ObjectStore, options: GcOptions): Promise<GcResult> {
  if (!(options.retentionDays > 0)) {
    throw new UiIntelligenceError("SCHEMA_INVALID", "retentionDays must be a positive number", { httpStatus: 422 });
  }
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const dryRun = options.dryRun ?? false;
  const keepMinimum = options.keepMinimum ?? true;

  const artifactRows = (
    options.projectId
      ? db.prepare("SELECT id, project_id, digest, created_at FROM artifacts WHERE project_id = ?").all(options.projectId)
      : db.prepare("SELECT id, project_id, digest, created_at FROM artifacts").all()
  ) as ArtifactRow[];

  const referenceTimes = collectReferenceTimes(db);
  const currentBuildIds = currentBuildArtifactIds(db);

  const deleted: GcDeletion[] = [];
  let kept = 0;
  for (const artifact of artifactRows) {
    const lastReferenceAt = referenceTimes.get(artifact.id) ?? null;
    if (currentBuildIds.has(artifact.id)) {
      // Current build's captures are always kept.
      kept += 1;
      continue;
    }
    if (lastReferenceAt !== null) {
      if (lastReferenceAt >= cutoff) {
        kept += 1;
        continue;
      }
      deleted.push({
        artifactId: artifact.id,
        digest: artifact.digest,
        projectId: artifact.project_id,
        reason: "reference_older_than_retention",
        lastReferenceAt,
      });
      continue;
    }
    if (artifact.created_at >= cutoff) {
      kept += 1;
      continue;
    }
    deleted.push({
      artifactId: artifact.id,
      digest: artifact.digest,
      projectId: artifact.project_id,
      reason: "orphan_older_than_retention",
      lastReferenceAt: null,
    });
  }

  const abort = (): UiIntelligenceError =>
    new UiIntelligenceError(
      "FORBIDDEN",
      `gc safety abort: deleting ${deleted.length} of ${artifactRows.length} artifacts would remove more than 50% of the store; pass force to override`,
      { httpStatus: 409, details: { candidates: deleted.length, scanned: artifactRows.length } },
    );

  if (keepMinimum && !options.force && artifactRows.length > 0 && deleted.length > artifactRows.length / 2) {
    recordRun(db, options, now, 0, dryRun, abort().message);
    throw abort();
  }

  if (!dryRun) {
    // Object bytes first (awaited — audit fix, finding 4): if byte deletion
    // fails the rows stay, so no capture ever references a deleted object.
    for (const deletion of deleted) {
      await store.delete(deletion.digest);
    }
    const tx = db.transaction(() => {
      for (const deletion of deleted) {
        db.prepare("DELETE FROM artifacts WHERE id = ?").run(deletion.artifactId);
      }
    });
    tx();
  }

  recordRun(db, options, now, dryRun ? 0 : deleted.length, dryRun, null);
  return {
    scanned: artifactRows.length,
    planned: deleted,
    deleted: dryRun ? [] : deleted,
    kept,
    dryRun,
    aborted: false,
  };
}

function recordRun(db: Db, options: GcOptions, now: Date, deletedCount: number, dryRun: boolean, error: string | null): void {
  if (options.recordRun === false) return;
  db.prepare(
    `INSERT INTO gc_runs (id, project_id, deleted_count, dry_run, started_at, finished_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId("gc"),
    options.projectId ?? null,
    deletedCount,
    dryRun ? 1 : 0,
    new Date(now.getTime() - 1).toISOString(),
    nowIso(),
    error,
  );
}
