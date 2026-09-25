/**
 * Scheduled GC tests (R2 stream G): daily gating via gc_runs, retention
 * rules, 50% safety guard, and byte deletion through the fs layout.
 */
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateWorker } from "../src/worker.js";
import { lastGcRunAt, runScheduledGc } from "../src/gc.js";
import { openWorkerDb } from "../src/db.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const OLD = "2026-01-15T00:00:00.000Z";
const FRESH = "2026-02-25T00:00:00.000Z";

const PREV_STORAGE_DRIVER = process.env.UI_INTEL_STORAGE_DRIVER;
afterEach(() => {
  if (PREV_STORAGE_DRIVER === undefined) delete process.env.UI_INTEL_STORAGE_DRIVER;
  else process.env.UI_INTEL_STORAGE_DRIVER = PREV_STORAGE_DRIVER;
});

function seed(db: ReturnType<typeof openWorkerDb>, artifactRoot: string): { oldDigest: string; freshDigest: string } {
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, tenant_id, name, repository, policy_revision, meta_json, created_at) VALUES ('proj_gc', 'local', 'gc-proj', 'repo://gc', 1, NULL, ?)",
  ).run(OLD);
  db.prepare("INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES ('build_old', 'proj_gc', 'old0000', 'd0', 'succeeded', ?)").run(OLD);
  db.prepare("INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES ('build_cur', 'proj_gc', 'new0000', 'd1', 'succeeded', ?)").run(FRESH);

  const digests: Record<string, string> = {};
  const put = (marker: string, id: string, createdAt: string): void => {
    const bytes = Buffer.from(`worker-gc-${marker}`);
    digests[marker] = bytes.toString("hex").slice(0, 64);
    const path = join(artifactRoot, digests[marker].slice(0, 2), digests[marker]);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
    db.prepare(
      "INSERT INTO artifacts (id, project_id, kind, digest, mime_type, byte_size, visibility, retention, created_at) VALUES (?, 'proj_gc', 'screenshot-png', ?, 'image/png', 11, 'project', 'standard', ?)",
    ).run(id, digests[marker], createdAt);
  };
  put("old", "art_old", OLD);
  put("fresh", "art_fresh", FRESH);
  put("curbuild", "art_curbuild", OLD);

  const manifest = (artifactId: string) => JSON.stringify({ artifacts: [{ artifactId, digest: "0".repeat(64), byteSize: 11 }] });
  db.prepare(
    "INSERT INTO captures (id, project_id, build_id, scenario_id, commit_sha, evidence_label, manifest_json, manifest_digest, request_key, created_at) VALUES ('cap_old', 'proj_gc', 'build_old', 's1', 'c0ffee', 'authentic', ?, 'd', 'rk1', ?)",
  ).run(manifest("art_old"), OLD);
  db.prepare(
    "INSERT INTO captures (id, project_id, build_id, scenario_id, commit_sha, evidence_label, manifest_json, manifest_digest, request_key, created_at) VALUES ('cap_cur', 'proj_gc', 'build_cur', 's1', 'c0ffee', 'authentic', ?, 'd', 'rk2', ?)",
  ).run(manifest("art_curbuild"), OLD);
  return { oldDigest: digests.old, freshDigest: digests.fresh };
}

describe("runScheduledGc", () => {
  it("deletes retention-expired artifacts (bytes included), keeps fresh and current-build", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-wgc-"));
    const artifactRoot = join(dir, "artifacts");
    const db = openWorkerDb(join(dir, "w.sqlite"));
    migrateWorker(db);
    const { oldDigest, freshDigest } = seed(db, artifactRoot);

    const outcome = runScheduledGc(db, {
      now: NOW,
      retentionDays: 30,
      artifactRoot,
      log: () => undefined,
    });
    expect(outcome).toMatchObject({ ran: true, deletedCount: 1 });
    expect(lastGcRunAt(db)).toBeTypeOf("string");

    const remaining = db.prepare("SELECT id FROM artifacts ORDER BY id").all().map((r) => (r as { id: string }).id);
    expect(remaining).toEqual(["art_curbuild", "art_fresh"]);
    expect(existsSync(join(artifactRoot, oldDigest.slice(0, 2), oldDigest))).toBe(false);
    expect(existsSync(join(artifactRoot, freshDigest.slice(0, 2), freshDigest))).toBe(true);
    db.close();
  });

  it("skips when the last successful run is younger than the interval", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-wgc2-"));
    const db = openWorkerDb(join(dir, "w.sqlite"));
    migrateWorker(db);
    runScheduledGc(db, { now: NOW, retentionDays: 30, artifactRoot: join(dir, "a"), log: () => undefined });
    const second = runScheduledGc(db, {
      now: new Date(NOW.getTime() + 2 * 60 * 60 * 1000), // +2h < 24h
      retentionDays: 30,
      artifactRoot: join(dir, "a"),
      log: () => undefined,
    });
    expect(second).toEqual({ ran: false, reason: "not_due" });
    // But it runs once the interval has passed.
    const third = runScheduledGc(db, {
      now: new Date(NOW.getTime() + 25 * 60 * 60 * 1000),
      retentionDays: 30,
      artifactRoot: join(dir, "a"),
      log: () => undefined,
    });
    expect(third.ran).toBe(true);
    db.close();
  });

  it("skips entirely when the s3 driver is configured", () => {
    process.env.UI_INTEL_STORAGE_DRIVER = "s3";
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-wgc3-"));
    const db = openWorkerDb(join(dir, "w.sqlite"));
    migrateWorker(db);
    const outcome = runScheduledGc(db, { now: NOW, retentionDays: 30, artifactRoot: join(dir, "a"), log: () => undefined });
    expect(outcome).toEqual({ ran: false, reason: "s3_driver_unsupported" });
    db.close();
  });

  it("aborts (recorded with an error) when more than 50% would be deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-wgc4-"));
    const db = openWorkerDb(join(dir, "w.sqlite"));
    migrateWorker(db);
    db.prepare(
      "INSERT OR IGNORE INTO projects (id, tenant_id, name, repository, policy_revision, meta_json, created_at) VALUES ('proj_gc', 'local', 'gc-proj', 'repo://gc', 1, NULL, ?)",
    ).run(OLD);
    for (const id of ["art_a", "art_b"]) {
      db.prepare(
        "INSERT INTO artifacts (id, project_id, kind, digest, mime_type, byte_size, visibility, retention, created_at) VALUES (?, 'proj_gc', 'screenshot-png', ?, 'image/png', 1, 'project', 'standard', ?)",
      ).run(id, "d".repeat(64), OLD);
    }
    const logs: string[] = [];
    const outcome = runScheduledGc(db, {
      now: NOW,
      retentionDays: 30,
      artifactRoot: join(dir, "a"),
      log: (message) => logs.push(message),
    });
    expect(outcome).toMatchObject({ ran: true, deletedCount: 0 });
    expect(logs.join("\n")).toMatch(/safety abort/);
    const run = db.prepare("SELECT error FROM gc_runs").get() as { error: string | null };
    expect(run.error).toMatch(/safety abort/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toMatchObject({ n: 2 });
    db.close();
  });
});
