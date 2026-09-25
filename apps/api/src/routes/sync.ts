/**
 * Device preference sync endpoint (R2 stream B, architecture section 9).
 * Auth: the project is derived from the body projectId (id or name); every
 * authenticated principal is allowed in the dev profile (single-token dev
 * auth verifies the caller; the opaque profileId is never an authorization
 * input).
 */
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import type { SpecificationRecord, SyncBundle } from "@ui-intelligence/protocol";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { mergeSyncBundle, syncBundleSchema } from "../sync.js";

export async function syncRoutes(app: FastifyInstance, deps: { db: Db }): Promise<void> {
  const { db } = deps;

  app.post("/v1/profiles/:profileId/sync", async (request) => {
    const profileId = (request.params as { profileId: string }).profileId;
    if (!profileId || profileId.length > 500) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "profileId is required", { httpStatus: 422 });
    }
    const parsed = syncBundleSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "invalid sync bundle", {
        httpStatus: 422,
        details: parsed.error.flatten(),
      });
    }
    const bundle: SyncBundle = {
      profileId,
      projectId: parsed.data.projectId,
      deviceLabel: parsed.data.deviceLabel,
      pushedAt: parsed.data.pushedAt,
      preferences: parsed.data.preferences,
      // zod types `proposal` as optional (unknown); the runtime shape is
      // guaranteed by the parse above.
      specifications: parsed.data.specifications as unknown as SpecificationRecord[],
    };

    // Project derived from the BODY (not the profile): accept the stored id
    // or the project name, consistent with every :p route.
    const project = db
      .prepare("SELECT id FROM projects WHERE id = ? OR name = ?")
      .get(bundle.projectId, bundle.projectId) as { id: string } | undefined;
    if (!project) {
      throw new UiIntelligenceError("NOT_FOUND", `project ${bundle.projectId} not found`, { httpStatus: 404 });
    }
    bundle.projectId = project.id;

    // Dev profile membership: the auth hook already verified the principal;
    // all authenticated principals may sync their own profile namespace.
    return mergeSyncBundle(db, profileId, bundle);
  });
}
