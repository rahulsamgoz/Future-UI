/**
 * R2 stream F: per-user auth — API keys, roles, cross-user denial.
 * Audit fix (finding 1) regressions: artifact metadata/raw/PUT-slot routes
 * and the profile sync route enforce per-user authorization; project listing
 * is membership-filtered.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestApp } from "./helpers.js";

const OPERATOR = "dev-token";

async function makeApp(): Promise<{ app: FastifyInstance; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "auth-test-"));
  return buildTestApp(dir);
}

async function provisionUser(
  app: FastifyInstance,
  memberships: Array<{ projectId: string; role: string }>
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
    payload: { displayName: "Test User", keyLabel: "test", memberships },
  });
  expect(res.statusCode).toBe(201);
  return (JSON.parse(res.body) as { apiKey: string }).apiKey;
}

describe("per-user auth (R2 stream F)", () => {
  it("rejects unknown API keys", async () => {
    const { app, cleanup } = await makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/v1/projects", headers: { authorization: "Bearer uik_totally_bogus" } });
      expect(res.statusCode).toBe(401);
    } finally {
      cleanup();
    }
  });

  it("viewer can read but not write", async () => {
    const { app, cleanup } = await makeApp();
    try {
      const key = await provisionUser(app, [{ projectId: "proj_reference_app", role: "viewer" }]);
      const read = await app.inject({ method: "GET", url: "/v1/projects/proj_reference_app/captures", headers: { authorization: `Bearer ${key}` } });
      expect(read.statusCode).toBe(200);
      const write = await app.inject({
        method: "POST",
        url: "/v1/projects/proj_reference_app/proposals",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        payload: { request: { requestId: "r", operation: "propose_change", target: { kind: "selection", entityId: "catalog.productChooser", runtimeInstanceId: "x" }, references: [], instruction: "", appBuildId: "b", requestedCandidateCount: 2 } },
      });
      expect(write.statusCode).toBe(403);
      expect((JSON.parse(write.body) as { error: { message: string } }).error.message).toContain("below required member");
    } finally {
      cleanup();
    }
  });

  it("member can write project data but not provision users", async () => {
    const { app, cleanup } = await makeApp();
    try {
      const key = await provisionUser(app, [{ projectId: "proj_reference_app", role: "member" }]);
      const write = await app.inject({
        method: "POST",
        url: "/v1/projects/proj_reference_app/commits:sync",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        payload: { commits: [{ sha: "aa", committedAt: "2026-01-01T00:00:00Z", parents: [] }] },
      });
      expect(write.statusCode).toBe(200);
      const provision = await app.inject({
        method: "POST",
        url: "/v1/users",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        payload: { displayName: "X", keyLabel: "x" },
      });
      expect(provision.statusCode).toBe(403);
    } finally {
      cleanup();
    }
  });

  it("user with no membership in a project is denied (cross-user denial)", async () => {
    const { app, cleanup } = await makeApp();
    try {
      // Create a second project the user has NO membership in.
      const other = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
        payload: { name: "other-app", repository: "https://example.com/other" },
      });
      const otherId = (JSON.parse(other.body) as { project: { id: string } }).project.id;

      const key = await provisionUser(app, [{ projectId: "proj_reference_app", role: "owner" }]);
      const own = await app.inject({ method: "GET", url: "/v1/projects/proj_reference_app/captures", headers: { authorization: `Bearer ${key}` } });
      expect(own.statusCode).toBe(200);
      const foreign = await app.inject({ method: "GET", url: `/v1/projects/${otherId}/captures`, headers: { authorization: `Bearer ${key}` } });
      expect(foreign.statusCode).toBe(403);
      expect((JSON.parse(foreign.body) as { error: { message: string } }).error.message).toContain("no membership");
    } finally {
      cleanup();
    }
  });

  it("operator token remains a full owner (back-compat)", async () => {
    const { app, cleanup } = await makeApp();
    try {
      const read = await app.inject({ method: "GET", url: "/v1/projects", headers: { authorization: `Bearer ${OPERATOR}` } });
      expect(read.statusCode).toBe(200);
    } finally {
      cleanup();
    }
  });

  it("lists provisioned users with memberships", async () => {
    const { app, cleanup } = await makeApp();
    try {
      await provisionUser(app, [{ projectId: "proj_reference_app", role: "viewer" }]);
      const list = await app.inject({ method: "GET", url: "/v1/users", headers: { authorization: `Bearer ${OPERATOR}` } });
      expect(list.statusCode).toBe(200);
      const body = JSON.parse(list.body) as { users: Array<{ memberships: Array<{ role: string }> }> };
      expect(body.users.some((u) => u.memberships.some((m) => m.role === "viewer"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Audit fix (finding 1): artifact routes, profile sync ownership, project list
// ---------------------------------------------------------------------------

async function createOtherProject(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
    payload: { name: "other-app", repository: "https://example.com/other" },
  });
  expect(res.statusCode).toBe(201);
  return (JSON.parse(res.body) as { project: { id: string } }).project.id;
}

/** Operator allocates an upload slot (with a reserved artifact id) in a project. */
async function allocateSlot(
  app: FastifyInstance,
  projectId: string,
  bytes: Buffer
): Promise<{ slotId: string; digest: string; artifactId: string }> {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const artifactId = `artifact_${digest.slice(0, 16)}`;
  const res = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/artifact-uploads`,
    headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
    payload: { mediaType: "application/json", byteSize: bytes.byteLength, digest, artifactId },
  });
  expect(res.statusCode).toBe(201);
  return { slotId: (JSON.parse(res.body) as { slotId: string }).slotId, digest, artifactId };
}

function syncBundle(profileId: string, projectId: string, withPreference: boolean): unknown {
  return {
    profileId,
    projectId,
    deviceLabel: "audit-test-device",
    pushedAt: "2026-03-01T00:00:00.000Z",
    preferences: withPreference
      ? [
          {
            key: { profileId, projectId, scope: "entity", scopeKey: "catalog.productChooser" },
            activeSpecificationDigest: null,
            revision: 1,
            contractVersion: 1,
            updatedAt: "2026-03-01T00:00:00.000Z",
          },
        ]
      : [],
    specifications: [],
  };
}

async function sync(
  app: FastifyInstance,
  token: string,
  profileId: string,
  projectId: string,
  withPreference: boolean
): Promise<{ statusCode: number; body: string }> {
  return app.inject({
    method: "POST",
    url: `/v1/profiles/${profileId}/sync`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: syncBundle(profileId, projectId, withPreference),
  });
}

describe("finding 1: artifact routes require project membership", () => {
  it("a zero-membership user gets 403 on artifact metadata, raw bytes, PUT slot, and sync", async () => {
    const { app, cleanup } = await makeApp();
    try {
      const otherId = await createOtherProject(app);
      const bytes = Buffer.from("audit-artifact-bytes");
      const { slotId, artifactId } = await allocateSlot(app, otherId, bytes);
      // Operator fills the slot so the artifact exists with bytes.
      const fill = await app.inject({
        method: "PUT",
        url: `/v1/artifacts/${slotId}`,
        headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/octet-stream" },
        payload: bytes,
      });
      expect(fill.statusCode).toBe(200);

      // A user with NO membership in other-app (only in proj_reference_app).
      const key = await provisionUser(app, [{ projectId: "proj_reference_app", role: "member" }]);

      const meta = await app.inject({ method: "GET", url: `/v1/artifacts/${artifactId}`, headers: { authorization: `Bearer ${key}` } });
      expect(meta.statusCode).toBe(403);

      const raw = await app.inject({ method: "GET", url: `/v1/artifacts/${artifactId}/raw?projectId=other-app`, headers: { authorization: `Bearer ${key}` } });
      expect(raw.statusCode).toBe(403);

      const secondSlot = await allocateSlot(app, otherId, Buffer.from("second-payload"));
      const put = await app.inject({
        method: "PUT",
        url: `/v1/artifacts/${secondSlot.slotId}`,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/octet-stream" },
        payload: Buffer.from("second-payload"),
      });
      expect(put.statusCode).toBe(403);

      const write = await sync(app, key, "profile_zero_membership", otherId, true);
      expect(write.statusCode).toBe(403);
      const read = await sync(app, key, "profile_zero_membership", otherId, false);
      expect(read.statusCode).toBe(403);
    } finally {
      cleanup();
    }
  });

  it("a viewer can read artifact metadata and bytes but cannot upload or push a sync write", async () => {
    const { app, cleanup } = await makeApp();
    try {
      const bytes = Buffer.from("viewer-readable-bytes");
      const { slotId, artifactId } = await allocateSlot(app, "proj_reference_app", bytes);
      const fill = await app.inject({
        method: "PUT",
        url: `/v1/artifacts/${slotId}`,
        headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/octet-stream" },
        payload: bytes,
      });
      expect(fill.statusCode).toBe(200);

      const key = await provisionUser(app, [{ projectId: "proj_reference_app", role: "viewer" }]);

      const meta = await app.inject({ method: "GET", url: `/v1/artifacts/${artifactId}`, headers: { authorization: `Bearer ${key}` } });
      expect(meta.statusCode).toBe(200);

      const raw = await app.inject({ method: "GET", url: `/v1/artifacts/${artifactId}/raw?projectId=proj_reference_app`, headers: { authorization: `Bearer ${key}` } });
      expect(raw.statusCode).toBe(200);
      expect(raw.body).toEqual(bytes.toString());

      const put = await app.inject({
        method: "PUT",
        url: `/v1/artifacts/${slotId}`,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/octet-stream" },
        payload: bytes,
      });
      expect(put.statusCode).toBe(403); // already filled AND below member

      // Viewer owns the profile (auto-registered) but the project write needs member.
      const write = await sync(app, key, "profile_viewer", "proj_reference_app", true);
      expect(write.statusCode).toBe(403);
      // A pull (no pushed preferences) stays allowed for viewers.
      const read = await sync(app, key, "profile_viewer", "proj_reference_app", false);
      expect(read.statusCode).toBe(200);
    } finally {
      cleanup();
    }
  });

  it("profiles are bound to their principal: foreign sync (write and pull) is 403; operator may access any profile", async () => {
    const { app, cleanup } = await makeApp();
    try {
      const keyA = await provisionUser(app, [{ projectId: "proj_reference_app", role: "member" }]);
      const keyB = await provisionUser(app, [{ projectId: "proj_reference_app", role: "member" }]);

      // User A registers and pushes profile-a.
      const first = await sync(app, keyA, "profile-a", "proj_reference_app", true);
      expect(first.statusCode).toBe(200);

      // User B cannot write OR read profile-a.
      const foreignWrite = await sync(app, keyB, "profile-a", "proj_reference_app", true);
      expect(foreignWrite.statusCode).toBe(403);
      const foreignRead = await sync(app, keyB, "profile-a", "proj_reference_app", false);
      expect(foreignRead.statusCode).toBe(403);

      // The operator principal may access any profile (dev profile).
      const operator = await sync(app, OPERATOR, "profile-a", "proj_reference_app", false);
      expect(operator.statusCode).toBe(200);
    } finally {
      cleanup();
    }
  });

  it("GET /v1/projects is filtered to memberships (operator sees all)", async () => {
    const { app, cleanup } = await makeApp();
    try {
      const otherId = await createOtherProject(app);
      const key = await provisionUser(app, [{ projectId: "proj_reference_app", role: "viewer" }]);

      const asUser = await app.inject({ method: "GET", url: "/v1/projects", headers: { authorization: `Bearer ${key}` } });
      expect(asUser.statusCode).toBe(200);
      const userList = JSON.parse(asUser.body) as { projects: Array<{ id: string }> };
      expect(userList.projects.map((p) => p.id)).toEqual(["proj_reference_app"]);
      expect(userList.projects.map((p) => p.id)).not.toContain(otherId);

      const asOperator = await app.inject({ method: "GET", url: "/v1/projects", headers: { authorization: `Bearer ${OPERATOR}` } });
      const operatorList = JSON.parse(asOperator.body) as { projects: Array<{ id: string }> };
      expect(operatorList.projects.map((p) => p.id)).toContain("proj_reference_app");
      expect(operatorList.projects.map((p) => p.id)).toContain(otherId);
    } finally {
      cleanup();
    }
  });
});
