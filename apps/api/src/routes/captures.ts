/**
 * Capture ingestion (spec sections 5, 11, 12). Verifies all referenced
 * artifacts, then commits capture + occurrences + build + job + outbox in one
 * SQLite transaction. Idempotent by the idempotency-key header.
 */
import { captureManifestSchema, digestOf, UiIntelligenceError } from "@ui-intelligence/protocol";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { enqueueJob, insertOutbox } from "../jobs.js";
import { getArtifact, getCaptureByRequestKey, listCaptures } from "../store.js";
import type { LexicalIndexCache } from "../resolve.js";

export type CaptureDeps = {
  db: Db;
  indexCache: LexicalIndexCache;
};

export async function captureRoutes(app: FastifyInstance, deps: CaptureDeps): Promise<void> {
  const { db, indexCache } = deps;

  app.post("/v1/projects/:p/captures", async (request, reply) => {
    const projectId = (request.params as { p: string }).p;
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "idempotency-key header is required", { httpStatus: 400 });
    }

    // Accept the manifest directly or wrapped as { manifest } (capture
    // package envelope shape).
    const rawBody = request.body as { manifest?: unknown } | unknown;
    const manifestCandidate =
      rawBody && typeof rawBody === "object" && "manifest" in rawBody && rawBody.manifest
        ? (rawBody as { manifest: unknown }).manifest
        : rawBody;
    const parsed = captureManifestSchema.safeParse(manifestCandidate);
    if (!parsed.success) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "invalid capture manifest", {
        httpStatus: 422,
        details: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      });
    }
    const manifest = parsed.data;
    const manifestDigest = await digestOf(manifest);

    const existing = getCaptureByRequestKey(db, projectId, idempotencyKey);
    if (existing) {
      if (existing.manifestDigest === manifestDigest) {
        return reply.code(200).send({ captureId: existing.id, replay: true });
      }
      throw new UiIntelligenceError("IDEMPOTENCY_MISMATCH", "idempotency key already used with a different manifest", {
        httpStatus: 409,
      });
    }

    // Verify every referenced artifact exists in this project with matching digest/size.
    for (const artifactRef of manifest.artifacts) {
      const artifact = getArtifact(db, projectId, artifactRef.artifactId);
      if (!artifact) {
        throw new UiIntelligenceError("SCHEMA_INVALID", `referenced artifact ${artifactRef.artifactId} not found in project`, {
          httpStatus: 422,
        });
      }
      if (artifact.digest !== artifactRef.digest || artifact.byte_size !== artifactRef.byteSize) {
        throw new UiIntelligenceError("SCHEMA_INVALID", `artifact ${artifactRef.artifactId} digest or size mismatch`, {
          httpStatus: 422,
        });
      }
    }

    const capturedAt = manifest.capturedAt;
    const ingest = db.transaction(() => {
      // Build (deduped by commit + artifact digest).
      let build = db
        .prepare("SELECT id FROM builds WHERE project_id = ? AND commit_sha = ? AND artifact_digest = ?")
        .get(projectId, manifest.spec.commitSha, manifest.spec.buildArtifactDigest) as { id: string } | undefined;
      if (!build) {
        const buildId = `build_${manifest.spec.commitSha.slice(0, 8)}_${manifest.spec.buildArtifactDigest.slice(0, 8)}`;
        db.prepare(
          "INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(buildId, projectId, manifest.spec.commitSha, manifest.spec.buildArtifactDigest, manifest.buildOutcome, capturedAt);
        build = (db
          .prepare("SELECT id FROM builds WHERE id = ?")
          .get(buildId) as { id: string }) ?? undefined;
        if (!build) {
          build = db
            .prepare("SELECT id FROM builds WHERE project_id = ? AND commit_sha = ? AND artifact_digest = ?")
            .get(projectId, manifest.spec.commitSha, manifest.spec.buildArtifactDigest) as { id: string };
        }
      }

      // Commit registration (parents recorded for lineage).
      db.prepare(
        "INSERT OR IGNORE INTO commits (sha, project_id, committed_at, parents_json) VALUES (?, ?, ?, ?)"
      ).run(manifest.spec.commitSha, projectId, capturedAt, JSON.stringify(manifest.gitParents));

      // Capture row.
      db.prepare(
        "INSERT INTO captures (id, project_id, build_id, scenario_id, commit_sha, evidence_label, manifest_json, manifest_digest, request_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        manifest.captureId,
        projectId,
        build.id,
        manifest.spec.scenario.id,
        manifest.spec.commitSha,
        manifest.buildOutcome === "succeeded" ? "captured_at_build" : "unavailable",
        JSON.stringify(manifest),
        manifestDigest,
        idempotencyKey,
        capturedAt
      );

      // Occurrences.
      const insertOccurrence = db.prepare(
        "INSERT OR REPLACE INTO occurrences (id, project_id, capture_id, entity_version_id, anchor, parent_id, visible_text, bounds_json, completeness, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const obs of manifest.observations) {
        insertOccurrence.run(
          obs.occurrenceId,
          projectId,
          manifest.captureId,
          obs.entityVersionId ?? null,
          obs.explicitAnchor ?? null,
          obs.parentOccurrenceId ?? null,
          obs.visibleText ?? null,
          JSON.stringify(obs.bounds),
          obs.completeness,
          capturedAt
        );
      }

      // Downstream indexing job + outbox entry in the same transaction.
      const jobId = enqueueJob(db, {
        projectId,
        kind: "index_capture",
        payload: { captureId: manifest.captureId, projectId },
        dedupKey: `index_capture:${manifest.captureId}`,
        stage: "indexing",
      });
      insertOutbox(db, projectId, jobId);
    });
    ingest();

    indexCache.invalidate(projectId);
    return reply.code(201).send({ captureId: manifest.captureId });
  });

  app.get("/v1/projects/:p/captures", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const query = request.query as { scenario?: string; commit?: string };
    return { captures: listCaptures(db, projectId, query) };
  });

  app.get("/v1/projects/:p/captures/:captureId", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const captureId = (request.params as { captureId: string }).captureId;
    const manifest = db
      .prepare("SELECT manifest_json, created_at FROM captures WHERE project_id = ? AND id = ?")
      .get(projectId, captureId) as { manifest_json: string; created_at: string } | undefined;
    if (!manifest) {
      throw new UiIntelligenceError("NOT_FOUND", `capture ${captureId} not found`, { httpStatus: 404 });
    }
    return { captureId, manifest: JSON.parse(manifest.manifest_json), createdAt: manifest.created_at };
  });
}
