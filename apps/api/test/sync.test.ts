/**
 * Device sync endpoint tests (R2 stream B). Bundle A is pushed by device 1;
 * device 2 pushes a higher revision of one preference and a divergent
 * equal-revision/different-digest of the other; the merge classification and
 * the authoritative server state are asserted.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "./helpers.js";
import { buildTestApp, post } from "./helpers.js";

const PROFILE_1 = "profile_device1";
const PROFILE_2 = "profile_device2";
const PROJECT = "proj_reference_app";

type PrefRecord = {
  key: { profileId: string; projectId: string; scope: string; scopeKey: string };
  activeSpecificationDigest: string | null;
  revision: number;
  contractVersion: number;
  updatedAt: string;
};

function record(
  profileId: string,
  scopeKey: string,
  digest: string | null,
  revision: number,
): PrefRecord {
  return {
    key: { profileId, projectId: PROJECT, scope: "entity", scopeKey },
    activeSpecificationDigest: digest,
    revision,
    contractVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function spec(digest: string, marker: string) {
  return {
    digest,
    proposal: { representation: "grid@1", properties: { columns: 3, marker } },
    requiredRendererVersions: { "grid@1": 1 },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function bundleFor(
  profileId: string,
  deviceLabel: string,
  preferences: PrefRecord[],
  specifications: ReturnType<typeof spec>[],
) {
  return {
    profileId,
    projectId: PROJECT,
    preferences,
    specifications,
    deviceLabel,
    pushedAt: "2026-02-01T00:00:00.000Z",
  };
}

describe("POST /v1/profiles/:profileId/sync", () => {
  let app: FastifyInstance;
  let cleanup: () => void;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-sync-"));
    const built = await buildTestApp(dir);
    app = built.app;
    cleanup = built.cleanup;
  });

  afterAll(async () => {
    await app?.close();
    cleanup?.();
  });

  it("requires authentication", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/profiles/${PROFILE_1}/sync`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("validates the bundle shape and the project", async () => {
    const missing = await post(app, `/v1/profiles/${PROFILE_1}/sync`, { deviceLabel: "d" });
    expect(missing.statusCode).toBe(422);

    const unknownProject = await post(app, `/v1/profiles/${PROFILE_1}/sync`, {
      projectId: "proj_nope",
      deviceLabel: "d",
      pushedAt: "2026-02-01T00:00:00.000Z",
      preferences: [],
      specifications: [],
    });
    expect(unknownProject.statusCode).toBe(404);
  });

  it("merges device bundles: newer revision accepted, divergent equal revision -> server wins", async () => {
    // Device 1 pushes bundle A: two preferences at revision 1.
    const pushA = await post(app, `/v1/profiles/${PROFILE_1}/sync`, bundleFor(PROFILE_1, "device-1", [
      record(PROFILE_1, "catalog.productChooser", "digestA1", 1),
      record(PROFILE_1, "ui.primaryButton", "digestB1", 1),
    ], [spec("digestA1", "device1"), spec("digestB1", "device1")]));
    expect(pushA.statusCode).toBe(200);
    const mergeA = JSON.parse(pushA.body);
    expect(mergeA.accepted.sort()).toEqual(["entity:catalog.productChooser", "entity:ui.primaryButton"]);
    expect(mergeA.serverWins).toEqual([]);
    expect(mergeA.retainedAsDraft).toEqual([]);
    expect(mergeA.authoritative.preferences).toHaveLength(2);
    expect(mergeA.authoritative.deviceLabel).toBe("server");

    // Device 2 (same profile, different device) pushes: product chooser at a
    // HIGHER revision (accepted), button at the SAME revision with a
    // DIFFERENT digest (server wins; retained as draft on the device).
    const pushB = await post(app, `/v1/profiles/${PROFILE_1}/sync`, bundleFor(PROFILE_1, "device-2", [
      record(PROFILE_1, "catalog.productChooser", "digestA2", 2),
      record(PROFILE_1, "ui.primaryButton", "digestB2", 1),
    ], [spec("digestA2", "device2"), spec("digestB2", "device2")]));
    expect(pushB.statusCode).toBe(200);
    const mergeB = JSON.parse(pushB.body);

    expect(mergeB.accepted).toEqual(["entity:catalog.productChooser"]);
    expect(mergeB.serverWins).toEqual(["entity:ui.primaryButton"]);
    expect(mergeB.retainedAsDraft).toEqual(["entity:ui.primaryButton"]);

    // Authoritative state: chooser moved to device 2's revision-2 spec; the
    // button kept the SERVER's (device 1's) spec — never silently merged.
    const authoritative = new Map(
      (mergeB.authoritative.preferences as PrefRecord[]).map((r) => [r.key.scopeKey, r]),
    );
    expect(authoritative.get("catalog.productChooser")?.revision).toBe(2);
    expect(authoritative.get("catalog.productChooser")?.activeSpecificationDigest).toBe("digestA2");
    expect(authoritative.get("ui.primaryButton")?.revision).toBe(1);
    expect(authoritative.get("ui.primaryButton")?.activeSpecificationDigest).toBe("digestB1");
    const specs = mergeB.authoritative.specifications as Array<{ digest: string }>;
    // Only ACTIVE specs travel: digestA1 was superseded by digestA2, and
    // digestB2 was never stored (server won).
    expect(specs.map((s) => s.digest).sort()).toEqual(["digestA2", "digestB1"]);

    // The table holds the merged state (one row per key, both spec payloads).
    const rows = app.db
      .prepare("SELECT scope_key, revision, active_spec_digest, spec_json FROM synced_preferences WHERE profile_id = ? ORDER BY scope_key")
      .all(PROFILE_1) as Array<{ scope_key: string; revision: number; active_spec_digest: string; spec_json: string }>;
    expect(rows).toHaveLength(2);
    const chooserRow = rows.find((r) => r.scope_key === "catalog.productChooser");
    expect(chooserRow?.revision).toBe(2);
    expect(JSON.parse(chooserRow!.spec_json)).toMatchObject({ digest: "digestA2" });
  });

  it("rejects a bundle whose digest has no specification payload", async () => {
    const res = await post(app, `/v1/profiles/${PROFILE_2}/sync`, bundleFor(PROFILE_2, "device-3", [
      record(PROFILE_2, "catalog.productChooser", "digestMissing", 1),
    ], []));
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("SCHEMA_INVALID");
  });

  it("accepts the project name as the projectId", async () => {
    const res = await post(app, `/v1/profiles/${PROFILE_2}/sync`, {
      ...bundleFor(PROFILE_2, "device-3", [
        record(PROFILE_2, "catalog.productChooser", "digestC1", 1),
      ], [spec("digestC1", "device3")]),
      projectId: "reference-app",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).accepted).toEqual(["entity:catalog.productChooser"]);
    // Canonicalized to the stored project id.
    const row = app.db
      .prepare("SELECT project_id FROM synced_preferences WHERE profile_id = ?")
      .get(PROFILE_2) as { project_id: string };
    expect(row.project_id).toBe(PROJECT);
  });
});
