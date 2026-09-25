/**
 * Device preference sync endpoint (R2 stream B, architecture section 9).
 * Auth (audit fix, finding 1): profiles are bound to the principal that first
 * synced them. A `sync_profiles` row records ownership at first use; a
 * DIFFERENT principal gets 403 FORBIDDEN. The dev operator principal may
 * access any profile. The project derived from the body still requires
 * membership: ≥ viewer for a pull (no pushed preference records), ≥ member
 * for a write (any pushed preference records).
 */
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import type { SpecificationRecord, SyncBundle } from "@ui-intelligence/protocol";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { nowIso } from "../db.js";
import { requireRole } from "../authz.js";
import { mergeSyncBundle, syncBundleSchema } from "../sync.js";

export async function syncRoutes(app: FastifyInstance, deps: { db: Db }): Promise<void> {
  const { db } = deps;

  app.post("/v1/profiles/:profileId/sync", async (request) => {
    const profileId = (request.params as { profileId: string }).profileId;
    if (!profileId || profileId.length > 500) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "profileId is required", { httpStatus: 422 });
    }
    const principal = request.principal;
    if (!principal) {
      throw new UiIntelligenceError("UNAUTHORIZED", "missing principal", { httpStatus: 401 });
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

    // Profile ownership: the first principal to sync a profile registers it;
    // other (non-operator) principals are denied — profiles are never shared
    // namespace across users.
    if (!principal.operator) {
      const owner = db
        .prepare("SELECT owner_user_id FROM sync_profiles WHERE profile_id = ?")
        .get(profileId) as { owner_user_id: string } | undefined;
      if (!owner) {
        db.prepare(
          "INSERT OR IGNORE INTO sync_profiles (profile_id, owner_user_id, created_at) VALUES (?, ?, ?)"
        ).run(profileId, principal.userId, nowIso());
      } else if (owner.owner_user_id !== principal.userId) {
        throw new UiIntelligenceError(
          "FORBIDDEN",
          `profile ${profileId} belongs to another principal`,
          { httpStatus: 403 },
        );
      }
    }

    // Project derived from the BODY (not the profile): accept the stored id
    // or the project name, consistent with every :p route.
    const project = db
      .prepare("SELECT id FROM projects WHERE id = ? OR name = ?")
      .get(bundle.projectId, bundle.projectId) as { id: string } | undefined;
    if (!project) {
      throw new UiIntelligenceError("NOT_FOUND", `project ${bundle.projectId} not found`, { httpStatus: 404 });
    }
    bundle.projectId = project.id;

    // Project membership from the ROW's project: a pull (no pushed records)
    // needs viewer; any pushed record is a write and needs member.
    const minimum = bundle.preferences.length > 0 ? "member" : "viewer";
    const check = requireRole(principal, project.id, minimum);
    if (!check.ok) {
      throw new UiIntelligenceError("FORBIDDEN", check.reason, { httpStatus: 403 });
    }

    return mergeSyncBundle(db, profileId, bundle);
  });
}
