/**
 * User + API key provisioning (R2 stream F). Operator-only: in the dev
 * profile the operator token provisions users; per-user self-service is a
 * later concern behind a real identity provider.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { createUserWithKey, type Role } from "../authz.js";

export async function userRoutes(app: FastifyInstance, deps: { db: Db }): Promise<void> {
  const { db } = deps;

  app.post("/v1/users", async (request, reply) => {
    if (!request.principal?.operator) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "user provisioning is operator-only" } });
    }
    const body = request.body as {
      displayName?: string;
      keyLabel?: string;
      memberships?: Array<{ projectId: string; role: Role }>;
    };
    if (!body.displayName || !body.keyLabel) {
      return reply.code(422).send({ error: { code: "SCHEMA_INVALID", message: "displayName and keyLabel are required" } });
    }
    for (const m of body.memberships ?? []) {
      if (!["owner", "member", "viewer"].includes(m.role)) {
        return reply.code(422).send({ error: { code: "SCHEMA_INVALID", message: `invalid role ${m.role}` } });
      }
      const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(m.projectId);
      if (!project) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: `project ${m.projectId} not found` } });
      }
    }
    const created = createUserWithKey(db, {
      displayName: body.displayName,
      keyLabel: body.keyLabel,
      memberships: body.memberships ?? [],
    });
    // The plaintext key is returned exactly once.
    return reply.code(201).send({
      userId: created.userId,
      keyId: created.keyId,
      apiKey: created.apiKey,
      memberships: body.memberships ?? [],
    });
  });

  app.get("/v1/users", async (request, reply) => {
    if (!request.principal?.operator) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "operator-only" } });
    }
    const users = db
      .prepare(
        `SELECT u.id, u.display_name, u.created_at,
                (SELECT group_concat(pm.project_id || ':' || pm.role) FROM project_members pm WHERE pm.user_id = u.id) AS memberships
         FROM users u ORDER BY u.created_at`
      )
      .all() as Array<{ id: string; display_name: string; created_at: string; memberships: string | null }>;
    return {
      users: users.map((u) => ({
        userId: u.id,
        displayName: u.display_name,
        createdAt: u.created_at,
        memberships: u.memberships ? u.memberships.split(",").map((m) => {
          const [projectId, role] = m.split(":");
          return { projectId, role };
        }) : [],
      })),
    };
  });
}
