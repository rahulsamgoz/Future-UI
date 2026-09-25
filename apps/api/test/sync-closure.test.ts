/**
 * Closure audit regressions (findings 1 + 2).
 *
 * Finding 1: a REJECTED sync request must leave NO sync_profiles ownership
 * row — authorization (project resolution + membership) happens FIRST, and
 * profile registration is transactional with the successful merge.
 *
 * Finding 2: the sync route must return the authoritative bundle under the
 * SAME project identifier the client submitted (the reference app uses the
 * project NAME "reference-app"; stored rows stay canonical). Integration:
 * two real SyncManager instances over the real Fastify sync route converge.
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPreferenceStore, SyncManager } from "@ui-intelligence/preferences";
import type { PreferenceRecord, SpecificationRecord, SyncBundle, SyncMergeResult } from "@ui-intelligence/protocol";
import { buildTestApp } from "./helpers.js";
import type { Db } from "../src/db.js";

const OPERATOR = "dev-token";
/** The app's actual project NAME — the client namespace of the reference app. */
const CLIENT_PROJECT = "reference-app";
const CANONICAL_PROJECT = "proj_reference_app";
const PROFILE = "profile_closure";

async function makeApp(): Promise<{ app: FastifyInstance & { db: Db }; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "sync-closure-"));
  const built = await buildTestApp(dir);
  return built as unknown as { app: FastifyInstance & { db: Db }; cleanup: () => void };
}

async function provisionUser(
  app: FastifyInstance,
  memberships: Array<{ projectId: string; role: string }>,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
    payload: { displayName: "Closure Test User", keyLabel: "closure", memberships },
  });
  expect(res.statusCode).toBe(201);
  return (JSON.parse(res.body) as { apiKey: string }).apiKey;
}

function bundle(profileId: string, projectId: string, withPreference: boolean): unknown {
  return {
    profileId,
    projectId,
    deviceLabel: "closure-device",
    pushedAt: "2026-04-01T00:00:00.000Z",
    preferences: withPreference
      ? [
          {
            key: { profileId, projectId, scope: "entity", scopeKey: "catalog.productChooser" },
            activeSpecificationDigest: null,
            revision: 1,
            contractVersion: 1,
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        ]
      : [],
    specifications: [],
  };
}

function syncVia(
  app: FastifyInstance,
  token: string,
  profileId: string,
  projectId: string,
  withPreference: boolean,
): Promise<{ statusCode: number; body: string }> {
  return app.inject({
    method: "POST",
    url: `/v1/profiles/${profileId}/sync`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: bundle(profileId, projectId, withPreference),
  });
}

function ownedRow(db: Db, profileId: string): { owner_user_id: string } | undefined {
  return db.prepare("SELECT owner_user_id FROM sync_profiles WHERE profile_id = ?").get(profileId) as
    | { owner_user_id: string }
    | undefined;
}

describe("finding 1: rejected sync requests leave no profile ownership row", () => {
  it("a zero-membership user's 403 does NOT register the profile; a member can then claim it", async () => {
    const { app, cleanup } = await makeApp();
    try {
      // (a) Zero-membership user submits an UNREGISTERED profile -> 403.
      const outsider = await provisionUser(app, []);
      const rejected = await syncVia(app, outsider, PROFILE, CANONICAL_PROJECT, true);
      expect(rejected.statusCode).toBe(403);
      // REGRESSION: the ownership row must NOT persist after the rejection.
      expect(ownedRow(app.db, PROFILE)).toBeUndefined();

      // (b) The authorized member can then register and use that profile.
      const member = await provisionUser(app, [{ projectId: CANONICAL_PROJECT, role: "member" }]);
      const accepted = await syncVia(app, member, PROFILE, CANONICAL_PROJECT, true);
      expect(accepted.statusCode).toBe(200);
      expect(ownedRow(app.db, PROFILE)?.owner_user_id).toBeTruthy();

      // (c) A second member gets 403 foreign-profile (existing behavior).
      const member2 = await provisionUser(app, [{ projectId: CANONICAL_PROJECT, role: "member" }]);
      const foreign = await syncVia(app, member2, PROFILE, CANONICAL_PROJECT, true);
      expect(foreign.statusCode).toBe(403);
      expect((JSON.parse(foreign.body) as { error: { message: string } }).error.message).toContain(
        "belongs to another principal",
      );
    } finally {
      cleanup();
    }
  });

  it("a 404 for an unknown project also leaves no ownership row", async () => {
    const { app, cleanup } = await makeApp();
    try {
      const member = await provisionUser(app, [{ projectId: CANONICAL_PROJECT, role: "member" }]);
      const res = await syncVia(app, member, "profile_unknown_project", "proj_nope", true);
      expect(res.statusCode).toBe(404);
      expect(ownedRow(app.db, "profile_unknown_project")).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 2: real SyncManager devices over the REAL sync route, using the
// app's project NAME as the client namespace.
// ---------------------------------------------------------------------------

function spec(digest: string, columns: number): SpecificationRecord {
  return {
    digest,
    proposal: { representation: "grid@1", properties: { columns } },
    requiredRendererVersions: { "grid@1": 1 },
    createdAt: "2026-04-01T00:00:00.000Z",
  };
}

function record(profileId: string, digest: string, revision: number): PreferenceRecord {
  return {
    key: { profileId, projectId: CLIENT_PROJECT, scope: "entity", scopeKey: "catalog.productChooser" },
    activeSpecificationDigest: digest,
    revision,
    contractVersion: 1,
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

/** Real HTTP transport against the Fastify sync route (operator token). */
function httpTransport(app: FastifyInstance): { push(bundle: SyncBundle): Promise<SyncMergeResult> } {
  return {
    async push(bundle: SyncBundle): Promise<SyncMergeResult> {
      const res = await app.inject({
        method: "POST",
        url: `/v1/profiles/${bundle.profileId}/sync`,
        headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
        payload: bundle,
      });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as SyncMergeResult;
    },
  };
}

const CHOOSER_KEY = {
  profileId: PROFILE,
  projectId: CLIENT_PROJECT,
  scope: "entity" as const,
  scopeKey: "catalog.productChooser",
};
const CHOOSER_IDENTITY = "entity:catalog.productChooser";

async function applyLocal(
  store: MemoryPreferenceStore,
  digest: string,
  columns: number,
  revision: number,
): Promise<void> {
  await store.putSpecification(spec(digest, columns));
  await store.setPreference(record(PROFILE, digest, revision));
}

describe("finding 2: device sync converges through the real API with the client project namespace", () => {
  it("device B receives device A's preference and both sides see the submitted project id", async () => {
    const { app, cleanup } = await makeApp();
    try {
      const storeA = new MemoryPreferenceStore();
      const storeB = new MemoryPreferenceStore();
      const managerA = new SyncManager(storeA, httpTransport(app), {
        profileId: PROFILE,
        projectId: CLIENT_PROJECT,
        deviceLabel: "device-a",
      });
      const managerB = new SyncManager(storeB, httpTransport(app), {
        profileId: PROFILE,
        projectId: CLIENT_PROJECT,
        deviceLabel: "device-b",
      });

      // Device A applies a preference and syncs.
      await applyLocal(storeA, "spec-a1", 3, 1);
      const resultA = await managerA.syncNow();
      expect(resultA.accepted).toContain(CHOOSER_IDENTITY);
      // The authoritative response uses the SAME identifier the client sent.
      expect(resultA.authoritative.projectId).toBe(CLIENT_PROJECT);
      for (const preference of resultA.authoritative.preferences) {
        expect(preference.key.projectId).toBe(CLIENT_PROJECT);
      }

      // Device B syncs and MUST receive A's preference.
      const resultB = await managerB.syncNow();
      expect(resultB.authoritative.preferences).toHaveLength(1);
      const applied = await storeB.getPreference(CHOOSER_KEY);
      expect(applied).not.toBeNull();
      expect(applied?.activeSpecificationDigest).toBe("spec-a1");
      expect(applied?.revision).toBe(1);
      expect(applied?.key.projectId).toBe(CLIENT_PROJECT);

      // B edits and re-syncs (convergence): the server takes B's revision.
      await applyLocal(storeB, "spec-b1", 4, 2);
      const resultB2 = await managerB.syncNow();
      expect(resultB2.accepted).toContain(CHOOSER_IDENTITY);

      // A syncs again: local rev 1 and server rev 2 both moved past A's last
      // observed server state -> DIVERGENT: A retains its draft and adopts
      // the server record (conflict report carries the identity).
      const resultA2 = await managerA.syncNow();
      expect(resultA2.retainedAsDraft).toContain(CHOOSER_IDENTITY);
      const converged = await storeA.getPreference(CHOOSER_KEY);
      expect(converged?.activeSpecificationDigest).toBe("spec-b1");
      expect(converged?.revision).toBe(2);

      // Drafts survive manager recreation (reload simulation).
      const managerA2 = new SyncManager(storeA, httpTransport(app), {
        profileId: PROFILE,
        projectId: CLIENT_PROJECT,
        deviceLabel: "device-a-recreated",
      });
      await managerA2.restore();
      const draft = managerA2.drafts.get(CHOOSER_IDENTITY);
      expect(draft?.digest).toBe("spec-a1");

      // Namespace assertions: BOTH stores live entirely in the client
      // namespace; the SERVER rows stay canonical.
      for (const store of [storeA, storeB]) {
        const exported = await store.exportBundle(PROFILE, CLIENT_PROJECT);
        for (const preference of exported.preferences) {
          expect(preference.key.projectId).toBe(CLIENT_PROJECT);
          expect(preference.key.profileId).toBe(PROFILE);
        }
      }
      const rowProjects = app.db
        .prepare("SELECT DISTINCT project_id FROM synced_preferences")
        .all() as Array<{ project_id: string }>;
      expect(rowProjects.map((r) => r.project_id)).toEqual([CANONICAL_PROJECT]);
    } finally {
      cleanup();
    }
  });

  it("never leaks records from other projects into the authoritative bundle", async () => {
    const { app, cleanup } = await makeApp();
    try {
      const storeA = new MemoryPreferenceStore();
      const managerA = new SyncManager(storeA, httpTransport(app), {
        profileId: PROFILE,
        projectId: CLIENT_PROJECT,
        deviceLabel: "device-a",
      });
      await applyLocal(storeA, "spec-a1", 3, 1);
      await managerA.syncNow();

      // A second project's row for the SAME profile must not leak.
      const other = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
        payload: { name: "other-closure-app", repository: "https://example.com/other" },
      });
      expect(other.statusCode).toBe(201);
      const otherId = (JSON.parse(other.body) as { project: { id: string } }).project.id;
      app.db
        .prepare(
          `INSERT INTO synced_preferences (profile_id, project_id, scope, scope_key, revision, active_spec_digest, spec_json, updated_at)
           VALUES (?, ?, 'entity', 'catalog.productChooser', 9, 'foreign-digest', NULL, '2026-04-01T00:00:00.000Z')`,
        )
        .run(PROFILE, otherId);

      const result = await managerA.syncNow();
      expect(result.authoritative.preferences).toHaveLength(1);
      expect(result.authoritative.preferences[0]?.key.projectId).toBe(CLIENT_PROJECT);
      expect(result.authoritative.preferences[0]?.activeSpecificationDigest).toBe("spec-a1");
    } finally {
      cleanup();
    }
  });
});
