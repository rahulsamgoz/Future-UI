/**
 * Retention/GC tests (R2 stream G). Seeds artifacts with controlled
 * timestamps and references: a fresh referenced capture (kept), an old
 * referenced capture beyond retention (deleted, bytes gone), an old orphan
 * (deleted), a fresh orphan (kept), and an old reference on the CURRENT
 * build (always kept). dryRun makes no changes; the >50% guard aborts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDb, type Db } from "../src/db.js";
import { runGc } from "../src/gc.js";
import { ObjectStore } from "../src/objectstore.js";

const PROJECT = "proj_reference_app";
const NOW = new Date("2026-03-01T12:00:00.000Z");
const RETENTION_DAYS = 30;
const OLD = "2026-01-15T00:00:00.000Z"; // ~45 days before NOW
const FRESH = "2026-02-25T00:00:00.000Z";

type Fixture = {
  db: Db;
  store: ObjectStore;
  dir: string;
  cleanup: () => void;
};

function seedProject(db: Db): void {
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, tenant_id, name, repository, policy_revision, meta_json, created_at) VALUES (?, 'local', 'gc-proj', 'repo://gc', 1, NULL, ?)",
  ).run(PROJECT, OLD);
}

function seedArtifact(db: Db, id: string, createdAt: string, digest: string): void {
  db.prepare(
    "INSERT INTO artifacts (id, project_id, kind, digest, mime_type, byte_size, visibility, retention, created_at) VALUES (?, ?, 'screenshot-png', ?, 'image/png', 11, 'project', 'standard', ?)",
  ).run(id, PROJECT, digest, createdAt);
}

function seedCapture(
  db: Db,
  captureId: string,
  buildId: string,
  createdAt: string,
  artifactIds: string[],
  artifacts: Array<{ id: string; digest: string }>,
): void {
  const manifest = {
    artifacts: artifactIds.map((artifactId) => ({
      artifactId,
      digest: artifacts.find((a) => a.id === artifactId)?.digest ?? "0".repeat(64),
      byteSize: 11,
    })),
  };
  db.prepare(
    "INSERT INTO captures (id, project_id, build_id, scenario_id, commit_sha, evidence_label, manifest_json, manifest_digest, request_key, created_at) VALUES (?, ?, ?, 's1', 'c0ffee', 'authentic', ?, 'd', ?, ?)",
  ).run(captureId, PROJECT, buildId, JSON.stringify(manifest), `rk_${captureId}`, createdAt);
}

function seedBuilds(db: Db, oldBuildId: string, currentBuildId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES (?, ?, 'old0000', 'd0', 'succeeded', ?)",
  ).run(oldBuildId, PROJECT, OLD);
  db.prepare(
    "INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES (?, ?, 'new0000', 'd1', 'succeeded', ?)",
  ).run(currentBuildId, PROJECT, FRESH);
}

/** Standard 5-artifact fixture; returns artifact digests keyed by short name. */
async function seedStandard(db: Db, store: ObjectStore): Promise<Record<string, string>> {
  seedProject(db);
  seedBuilds(db, "build_old", "build_new");
  const bytes = (marker: string) => Buffer.from(`png-bytes-${marker}`);
  const digests: Record<string, string> = {};
  const put = async (name: string, createdAt: string, id: string): Promise<void> => {
    const b = bytes(name);
    digests[name] = ObjectStore.sha256(b);
    await store.put(digests[name], b);
    seedArtifact(db, id, createdAt, digests[name]);
  };
  await put("freshRef", FRESH, "art_fresh_ref"); // referenced, fresh capture → kept
  await put("oldRef", OLD, "art_old_ref"); // referenced by old capture → deleted
  await put("orphanOld", OLD, "art_orphan_old"); // no reference, old → deleted
  await put("orphanFresh", FRESH, "art_orphan_fresh"); // no reference, fresh → kept
  await put("currentBuild", OLD, "art_current_build"); // old ref on CURRENT build → kept

  seedCapture(db, "cap_old_ref", "build_old", OLD, ["art_old_ref"], []);
  seedCapture(db, "cap_fresh_ref", "build_new", FRESH, ["art_fresh_ref"], []);
  // Old capture on the CURRENT build referencing art_current_build.
  seedCapture(db, "cap_current", "build_new", OLD, ["art_current_build"], []);
  return digests;
}

describe("runGc", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-gc-"));
    const db = openDb(join(dir, "gc.sqlite"));
    migrate(db);
    const store = new ObjectStore(join(dir, "artifacts"));
    await seedStandard(db, store);
    fixture = { db, store, dir, cleanup: () => db.close() };
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it("deletes old-referenced and old-orphan artifacts, keeps fresh and current-build ones", async () => {
    const result = await runGc(fixture.db, fixture.store, { now: NOW, retentionDays: RETENTION_DAYS });

    expect(result.scanned).toBe(5);
    expect(result.planned.map((d) => d.artifactId).sort()).toEqual(["art_old_ref", "art_orphan_old"]);
    expect(result.deleted.map((d) => d.artifactId).sort()).toEqual(["art_old_ref", "art_orphan_old"]);
    expect(result.kept).toBe(3);

    // Rows are gone; bytes are gone from the object store.
    const remaining = fixture.db.prepare("SELECT id FROM artifacts ORDER BY id").all().map((r) => (r as { id: string }).id);
    expect(remaining.sort()).toEqual(["art_current_build", "art_fresh_ref", "art_orphan_fresh"]);
    expect(await fixture.store.exists(result.planned[0].digest)).toBe(false);
    expect(await fixture.store.get(result.planned[1].digest)).toBeNull();

    // The run is recorded.
    const run = fixture.db.prepare("SELECT deleted_count, dry_run, error FROM gc_runs").get() as {
      deleted_count: number;
      dry_run: number;
      error: string | null;
    };
    expect(run.deleted_count).toBe(2);
    expect(run.dry_run).toBe(0);
    expect(run.error).toBeNull();
  });

  it("dryRun classifies without deleting anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-gc-dry-"));
    const db = openDb(join(dir, "gc.sqlite"));
    migrate(db);
    const store = new ObjectStore(join(dir, "artifacts"));
    await seedStandard(db, store);

    const result = await runGc(db, store, { now: NOW, retentionDays: RETENTION_DAYS, dryRun: true });
    expect(result.planned.map((d) => d.artifactId).sort()).toEqual(["art_old_ref", "art_orphan_old"]);
    expect(result.deleted).toEqual([]);
    expect(result.dryRun).toBe(true);
    // Nothing changed.
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toMatchObject({ n: 5 });
    expect(await store.exists((result.planned[0] as { digest: string }).digest)).toBe(true);
    db.close();
  });

  it("aborts with a safety error when deletion would remove more than 50% of artifacts, unless forced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-gc-abort-"));
    const db = openDb(join(dir, "gc.sqlite"));
    migrate(db);
    const store = new ObjectStore(join(dir, "artifacts"));
    seedProject(db);
    const bytes = Buffer.from("old-bytes");
    const digest = ObjectStore.sha256(bytes);
    await store.put(digest, bytes);
    seedArtifact(db, "art_old_1", OLD, digest);
    seedArtifact(db, "art_old_2", OLD, digest); // both old orphans → 2/2 > 50%

    await expect(runGc(db, store, { now: NOW, retentionDays: RETENTION_DAYS })).rejects.toThrowError(
      /gc safety abort.*more than 50%/,
    );
    // Nothing was deleted by the aborted run.
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toMatchObject({ n: 2 });
    expect(await store.exists(digest)).toBe(true);
    // The abort is recorded with the error.
    const aborted = db.prepare("SELECT error, deleted_count FROM gc_runs ORDER BY started_at").all() as Array<{
      error: string | null;
      deleted_count: number;
    }>;
    expect(aborted[0].error).toMatch(/gc safety abort/);

    // Forced run deletes.
    const forced = await runGc(db, store, { now: NOW, retentionDays: RETENTION_DAYS, force: true });
    expect(forced.deleted).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toMatchObject({ n: 0 });
    expect(await store.exists(digest)).toBe(false);
    db.close();
  });

  it("keeps artifacts whose latest reference is within retention even if an older reference exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-gc-latest-"));
    const db = openDb(join(dir, "gc.sqlite"));
    migrate(db);
    const store = new ObjectStore(join(dir, "artifacts"));
    seedProject(db);
    seedBuilds(db, "build_old", "build_cur");
    const bytes = Buffer.from("twice-referenced");
    const digest = ObjectStore.sha256(bytes);
    await store.put(digest, bytes);
    seedArtifact(db, "art_twice", OLD, digest);
    seedCapture(db, "cap_old", "build_old", OLD, ["art_twice"], []);
    seedCapture(db, "cap_new", "build_cur", FRESH, ["art_twice"], []); // latest reference is fresh

    const result = await runGc(db, store, { now: NOW, retentionDays: RETENTION_DAYS });
    expect(result.planned).toEqual([]);
    expect(await store.exists(digest)).toBe(true);
    db.close();
  });
});

describe("POST /v1/projects/:p/gc", () => {
  it("runs dry-run and real deletions through the API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-gc-api-"));
    const { buildTestApp } = await import("./helpers.js");
    const { post } = await import("./helpers.js");
    const built = await buildTestApp(dir);
    const app = built.app;
    try {
      const db = app.db;
      const store = new ObjectStore(join(dir, "artifacts"));
      seedProject(db);
      // The route runs on the real clock: seed ages relative to NOW.
      const oldAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
      const freshAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES ('build_old', ?, 'old0000', 'd0', 'succeeded', ?)").run(PROJECT, oldAt);
      db.prepare("INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES ('build_cur', ?, 'new0000', 'd1', 'succeeded', ?)").run(PROJECT, freshAt);
      const bytes = Buffer.from("api-gc-bytes");
      const digest = ObjectStore.sha256(bytes);
      await store.put(digest, bytes);
      seedArtifact(db, "art_api_old", oldAt, digest);
      seedArtifact(db, "art_api_fresh", freshAt, digest);

      const dry = await post(app, `/v1/projects/${PROJECT}/gc`, { retentionDays: RETENTION_DAYS, dryRun: true });
      expect(dry.statusCode).toBe(200);
      const dryBody = JSON.parse(dry.body);
      expect(dryBody.planned.map((d: { artifactId: string }) => d.artifactId)).toEqual(["art_api_old"]);
      expect(dryBody.deleted).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toMatchObject({ n: 2 });

      const real = await post(app, `/v1/projects/${PROJECT}/gc`, { retentionDays: RETENTION_DAYS });
      expect(real.statusCode).toBe(200);
      expect(JSON.parse(real.body).deleted.map((d: { artifactId: string }) => d.artifactId)).toEqual(["art_api_old"]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toMatchObject({ n: 1 });
      expect(await store.exists(digest)).toBe(false);

      const unauth = await app.inject({ method: "POST", url: `/v1/projects/${PROJECT}/gc`, payload: {} });
      expect(unauth.statusCode).toBe(401);
    } finally {
      await app.close();
      built.cleanup();
    }
  });
});
