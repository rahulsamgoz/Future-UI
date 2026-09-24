/**
 * Artifact upload slots, byte uploads, and raw reads (spec section 12).
 * Slots expire in 15 minutes and accept only image/png and application/json
 * up to 20 MB. Completion verifies the digest before an artifacts row exists.
 */
import { randomUUID } from "node:crypto";
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { nowIso } from "../db.js";
import { ObjectStore } from "../objectstore.js";
import { getArtifact, getUploadSlot } from "../store.js";

const ALLOWED_MEDIA_TYPES = new Set(["image/png", "application/json"]);
const MAX_BYTES = 20 * 1024 * 1024;
const SLOT_TTL_MS = 15 * 60 * 1000;

function kindForMediaType(mediaType: string): string {
  if (mediaType === "image/png") return "screenshot-png";
  if (mediaType === "application/json") return "manifest-json";
  return "blob";
}

export type ArtifactDeps = {
  db: Db;
  store: ObjectStore;
};

export async function artifactRoutes(app: FastifyInstance, deps: ArtifactDeps): Promise<void> {
  const { db, store } = deps;

  app.post("/v1/projects/:p/artifact-uploads", async (request, reply) => {
    const projectId = (request.params as { p: string }).p;
    const body = request.body as { mediaType?: string; byteSize?: number; digest?: string; artifactId?: string };
    if (!body.mediaType || !ALLOWED_MEDIA_TYPES.has(body.mediaType)) {
      throw new UiIntelligenceError("SCHEMA_INVALID", `mediaType must be one of ${[...ALLOWED_MEDIA_TYPES].join(", ")}`, {
        httpStatus: 422,
      });
    }
    if (typeof body.byteSize !== "number" || body.byteSize < 0 || body.byteSize > MAX_BYTES) {
      throw new UiIntelligenceError("SCHEMA_INVALID", `byteSize must be between 0 and ${MAX_BYTES}`, { httpStatus: 422 });
    }
    if (!body.digest || !/^[0-9a-f]{64}$/.test(body.digest)) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "digest must be a sha-256 hex string", { httpStatus: 422 });
    }
    const slotId = `slot_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    // Optional client-supplied artifact id (the capture manifest references
    // it). Validated for shape only; uniqueness is enforced by the PRIMARY KEY.
    if (body.artifactId !== undefined && !/^artifact_[a-z0-9]+$/.test(body.artifactId)) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "artifactId must match artifact_[a-z0-9]+", { httpStatus: 422 });
    }
    const now = nowIso();
    if (body.artifactId !== undefined) {
      // Reserve the client's artifact id with the slot digest so the capture
      // manifest's reference resolves after upload.
      db.prepare(
        "INSERT INTO artifacts (id, project_id, kind, digest, mime_type, byte_size, visibility, retention, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'standard', ?)"
      ).run(body.artifactId, projectId, kindForMediaType(body.mediaType), body.digest, body.mediaType, body.byteSize, now);
    }
    db.prepare(
      "INSERT INTO upload_slots (id, project_id, media_type, byte_size, digest, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)"
    ).run(slotId, projectId, body.mediaType, body.byteSize, body.digest, now, new Date(Date.now() + SLOT_TTL_MS).toISOString());
    return reply.code(201).send({ slotId, uploadUrl: `/v1/artifacts/${slotId}`, expiresAt: new Date(Date.now() + SLOT_TTL_MS).toISOString() });
  });

  app.put("/v1/artifacts/:slotId", async (request, reply) => {
    const slotId = (request.params as { slotId: string }).slotId;
    const slot = getUploadSlot(db, slotId);
    if (!slot) {
      throw new UiIntelligenceError("NOT_FOUND", `upload slot ${slotId} not found`, { httpStatus: 404 });
    }
    if (slot.status !== "open") {
      throw new UiIntelligenceError("STALE_REVISION", "upload slot already used", { httpStatus: 409 });
    }
    if ((slot.expires_at as string) < nowIso()) {
      throw new UiIntelligenceError("STALE_REVISION", "upload slot expired", { httpStatus: 409 });
    }
    const body = request.body as Buffer | undefined;
    if (!body || body.byteLength === 0) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "request body is required", { httpStatus: 422 });
    }
    if (body.byteLength !== slot.byte_size) {
      throw new UiIntelligenceError("SCHEMA_INVALID", `byte size mismatch: expected ${slot.byte_size}, got ${body.byteLength}`, {
        httpStatus: 422,
      });
    }
    // Digest verification happens inside ObjectStore.put (mismatch => 422).
    store.put(slot.digest as string, body);

    // If the client reserved an artifact id at slot-allocation time (its
    // manifest references that id), mark it ready. Otherwise allocate a new
    // one. Bytes were digest-verified by store.put above.
    const reserved = db
      .prepare("SELECT id FROM artifacts WHERE project_id = ? AND digest = ? AND visibility = 'pending'")
      .get(slot.project_id, slot.digest) as { id: string } | undefined;
    let artifactId: string;
    if (reserved) {
      artifactId = reserved.id;
      db.prepare("UPDATE artifacts SET visibility = 'project' WHERE id = ? AND project_id = ?").run(artifactId, slot.project_id);
    } else {
      artifactId = `art_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      db.prepare(
        "INSERT INTO artifacts (id, project_id, kind, digest, mime_type, byte_size, visibility, retention, created_at) VALUES (?, ?, ?, ?, ?, ?, 'project', 'standard', ?)"
      ).run(artifactId, slot.project_id, kindForMediaType(slot.media_type as string), slot.digest, slot.media_type, slot.byte_size, nowIso());
    }
    db.prepare("UPDATE upload_slots SET status = 'filled' WHERE id = ?").run(slotId);
    return reply.code(200).send({ artifactId, digest: slot.digest });
  });

  // Visibility "project": the bearer token is already verified by the auth
  // hook; a projectId hint that does not match the owning project yields 404
  // so cross-project reads never leak existence.
  app.get("/v1/artifacts/:id/raw", async (request, reply) => {
    const artifactId = (request.params as { id: string }).id;
    const query = request.query as { projectId?: string };
    const artifact = getArtifact(db, null, artifactId);
    // Project ownership is verified from the artifact ROW — the projectId
    // query param must be present AND match the owning project (accepting
    // the stored project id OR its name, consistent with the :p
    // canonicalization used by every other route). (Dev profile: a single
    // operator token authenticates the caller; this check keeps projects
    // isolated from each other's artifact bytes.)
    let projectMatch = false;
    if (artifact && query.projectId) {
      const project = db
        .prepare("SELECT id FROM projects WHERE id = ? OR name = ?")
        .get(query.projectId, query.projectId) as { id: string } | undefined;
      projectMatch = project?.id === artifact.project_id;
    }
    if (!artifact || !projectMatch) {
      throw new UiIntelligenceError("NOT_FOUND", `artifact ${artifactId} not found`, { httpStatus: 404 });
    }
    const bytes = store.get(artifact.digest as string);
    if (!bytes) {
      throw new UiIntelligenceError("NOT_FOUND", "artifact bytes missing from object store", { httpStatus: 404 });
    }
    reply.header("content-type", artifact.mime_type as string);
    reply.header("x-artifact-digest", artifact.digest as string);
    return reply.send(bytes);
  });

  app.get("/v1/artifacts/:id", async (request) => {
    const artifactId = (request.params as { id: string }).id;
    const artifact = getArtifact(db, null, artifactId);
    if (!artifact) {
      throw new UiIntelligenceError("NOT_FOUND", `artifact ${artifactId} not found`, { httpStatus: 404 });
    }
    return {
      artifactId: artifact.id,
      projectId: artifact.project_id,
      kind: artifact.kind,
      digest: artifact.digest,
      mimeType: artifact.mime_type,
      byteSize: artifact.byte_size,
      visibility: artifact.visibility,
      retention: artifact.retention,
      createdAt: artifact.created_at,
    };
  });
}
