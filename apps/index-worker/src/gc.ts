/**
 * Scheduled retention/GC for the index-worker (R2 stream G).
 *
 * The GC rules live in apps/api/src/gc.ts (tested there); this module
 * reimplements the small read/delete SQL locally BY DESIGN — cross-app
 * imports are not allowed (same policy as the job claim SQL below). The
 * worker runs it once per interval (default 24h) when GC_RETENTION_DAYS is
 * configured, guarded by the shared gc_runs table.
 *
 * Object bytes are deleted through the fs driver layout (<root>/<xx>/<digest>).
 * When UI_INTEL_STORAGE_DRIVER=s3 the scheduled run is SKIPPED entirely
 * (byte deletion is not possible here without the S3 SDK; use the API GC
 * route or run the API process) — deleting rows without bytes would leave
 * unreferenced objects behind.
 */
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { newId } from "@ui-intelligence/protocol";
import type { WorkerDb } from "./worker.js";

export type ScheduledGcOptions = {
  now?: Date;
  retentionDays: number;
  /** Minimum spacing between runs in hours (default 24). */
  intervalHours?: number;
  /** fs root of the object store (env UI_INTEL_STORE). */
  artifactRoot?: string;
  dryRun?: boolean;
  log?: (message: string) => void;
};

export type ScheduledGcOutcome = {
  ran: boolean;
  reason?: "disabled" | "not_due" | "s3_driver_unsupported";
  deletedCount?: number;
};

const ARTIFACT_ID_PATTERN = /artifact_[a-z0-9]+/g;

function collectReferenceTimes(db: WorkerDb): Map<string, string> {
  const latest = new Map<string, string>();
  const observe = (artifactId: string, at: string): void => {
    const existing = latest.get(artifactId);
    if (existing === undefined || at > existing) latest.set(artifactId, at);
  };
  const captures = db
    .prepare("SELECT created_at, manifest_json FROM captures")
    .all() as Array<{ created_at: string; manifest_json: string }>;
  for (const capture of captures) {
    try {
      const manifest = JSON.parse(capture.manifest_json) as { artifacts?: Array<{ artifactId?: string }> };
      for (const reference of manifest.artifacts ?? []) {
        if (reference?.artifactId) observe(reference.artifactId, capture.created_at);
      }
    } catch {
      // Malformed historical manifests never abort GC.
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
      for (const match of column.match(ARTIFACT_ID_PATTERN) ?? []) observe(match, proposal.updated_at);
    }
  }
  return latest;
}

function currentBuildArtifactIds(db: WorkerDb): Set<string> {
  const ids = new Set<string>();
  const builds = db
    .prepare("SELECT id, project_id, created_at FROM builds ORDER BY created_at ASC")
    .all() as Array<{ id: string; project_id: string; created_at: string }>;
  const latestPerProject = new Map<string, string>();
  for (const build of builds) latestPerProject.set(build.project_id, build.id);
  for (const buildId of latestPerProject.values()) {
    const captures = db.prepare("SELECT manifest_json FROM captures WHERE build_id = ?").all(buildId) as Array<{
      manifest_json: string;
    }>;
    for (const capture of captures) {
      try {
        const manifest = JSON.parse(capture.manifest_json) as { artifacts?: Array<{ artifactId?: string }> };
        for (const reference of manifest.artifacts ?? []) {
          if (reference?.artifactId) ids.add(reference.artifactId);
        }
      } catch {
        // See collectReferenceTimes.
      }
    }
  }
  return ids;
}

/** Last successful (non-dry) GC finish time, or null when never run. */
export function lastGcRunAt(db: WorkerDb): string | null {
  const row = db
    .prepare("SELECT MAX(finished_at) AS last FROM gc_runs WHERE error IS NULL AND dry_run = 0")
    .get() as { last: string | null };
  return row.last ?? null;
}

/**
 * Daily-gated GC run. Returns { ran: false, reason } when skipped. Throws
 * UiIntelligenceError-shaped Errors only for configuration problems.
 */
export function runScheduledGc(db: WorkerDb, options: ScheduledGcOptions): ScheduledGcOutcome {
  const log = options.log ?? (() => undefined);
  if (!(options.retentionDays > 0)) {
    throw new Error("runScheduledGc requires a positive retentionDays (GC_RETENTION_DAYS)");
  }
  const driver = process.env.UI_INTEL_STORAGE_DRIVER ?? "fs";
  if (driver === "s3") {
    log("scheduled gc: UI_INTEL_STORAGE_DRIVER=s3 — worker-side gc skipped (use the API GC route)");
    return { ran: false, reason: "s3_driver_unsupported" };
  }
  const now = options.now ?? new Date();
  const intervalHours = options.intervalHours ?? 24;
  const last = lastGcRunAt(db);
  if (last) {
    const dueAt = new Date(last).getTime() + intervalHours * 60 * 60 * 1000;
    if (now.getTime() < dueAt) {
      return { ran: false, reason: "not_due" };
    }
  }

  const cutoff = new Date(now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const artifacts = db
    .prepare("SELECT id, digest, created_at FROM artifacts")
    .all() as Array<{ id: string; digest: string; created_at: string }>;
  const referenceTimes = collectReferenceTimes(db);
  const currentBuildIds = currentBuildArtifactIds(db);

  const doomed: Array<{ id: string; digest: string }> = [];
  for (const artifact of artifacts) {
    if (currentBuildIds.has(artifact.id)) continue;
    const lastReferenceAt = referenceTimes.get(artifact.id) ?? null;
    const refOld = lastReferenceAt !== null && lastReferenceAt < cutoff;
    const orphanOld = lastReferenceAt === null && artifact.created_at < cutoff;
    if (refOld || orphanOld) doomed.push({ id: artifact.id, digest: artifact.digest });
  }

  // keepMinimum guard: never mass-delete more than half the store.
  if (doomed.length > artifacts.length / 2) {
    const message = `scheduled gc safety abort: ${doomed.length} of ${artifacts.length} artifacts exceed the 50% guard`;
    log(message);
    db.prepare(
      "INSERT INTO gc_runs (id, project_id, deleted_count, dry_run, started_at, finished_at, error) VALUES (?, NULL, 0, 0, ?, ?, ?)",
    ).run(newId("gc"), now.toISOString(), now.toISOString(), message);
    return { ran: true, deletedCount: 0 };
  }

  const artifactRoot = resolve(options.artifactRoot ?? process.env.UI_INTEL_STORE ?? "./data/artifacts");
  if (!options.dryRun) {
    const tx = db.transaction(() => {
      for (const artifact of doomed) {
        const path = join(artifactRoot, artifact.digest.slice(0, 2), artifact.digest);
        if (existsSync(path)) {
          rmSync(path, { force: true });
        }
        db.prepare("DELETE FROM artifacts WHERE id = ?").run(artifact.id);
      }
    });
    tx();
  }

  db.prepare(
    "INSERT INTO gc_runs (id, project_id, deleted_count, dry_run, started_at, finished_at, error) VALUES (?, NULL, ?, ?, ?, ?, NULL)",
  ).run(newId("gc"), options.dryRun ? 0 : doomed.length, options.dryRun ? 1 : 0, now.toISOString(), now.toISOString());
  log(`scheduled gc: ${options.dryRun ? "dry run, " : ""}${doomed.length} artifact(s) beyond ${options.retentionDays}d retention`);
  return { ran: true, deletedCount: options.dryRun ? 0 : doomed.length };
}
