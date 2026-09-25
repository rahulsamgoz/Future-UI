/**
 * R2 stream F: per-user auth — API keys, roles, cross-user denial.
 */
import { describe, expect, it } from "vitest";
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
