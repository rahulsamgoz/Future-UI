/**
 * Manual retention/GC trigger (R2 stream G). Any authenticated principal in
 * the dev profile may run GC for a project (the :p preHandler enforces the
 * member minimum); retentionDays defaults to the GC_RETENTION_DAYS env when
 * the body omits it.
 */
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { runGc } from "../gc.js";
import type { ObjectStore } from "../objectstore.js";

export type GcRouteDeps = {
  db: Db;
  store: ObjectStore;
};

export async function gcRoutes(app: FastifyInstance, deps: GcRouteDeps): Promise<void> {
  const { db, store } = deps;

  app.post("/v1/projects/:p/gc", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const body = request.body as { retentionDays?: number; dryRun?: boolean; force?: boolean } | undefined;
    const retentionDays = body?.retentionDays ?? Number(process.env.GC_RETENTION_DAYS ?? "");
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      throw new UiIntelligenceError(
        "SCHEMA_INVALID",
        "retentionDays must be a positive number (body or GC_RETENTION_DAYS env)",
        { httpStatus: 422 },
      );
    }
    return runGc(db, store, {
      projectId,
      retentionDays,
      dryRun: body?.dryRun ?? false,
      force: body?.force ?? false,
    });
  });
}
