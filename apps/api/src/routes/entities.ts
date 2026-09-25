/**
 * Runtime manifest, resolve, and entity history routes.
 */
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { getProject, getRuntimeManifest } from "../store.js";
import { resolveTarget, type LexicalIndexCache, type ScreenshotGroundingDeps } from "../resolve.js";

export type ManifestDeps = { db: Db };

export async function manifestRoutes(app: FastifyInstance, deps: ManifestDeps): Promise<void> {
  const { db } = deps;

  app.get("/v1/projects/:p/runtime-manifest", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const manifest = getRuntimeManifest(db, projectId);
    if (!manifest) {
      throw new UiIntelligenceError("NOT_FOUND", `no runtime manifest registered for project ${projectId}`, {
        httpStatus: 404,
      });
    }
    return manifest;
  });
}

export type ResolveDeps = { db: Db; indexCache: LexicalIndexCache } & ScreenshotGroundingDeps;

export async function resolveRoutes(app: FastifyInstance, deps: ResolveDeps): Promise<void> {
  const { db, indexCache, store, screenshotCache } = deps;

  app.post("/v1/projects/:p/resolve", async (request) => {
    const projectId = (request.params as { p: string }).p;
    if (!getProject(db, projectId)) {
      throw new UiIntelligenceError("NOT_FOUND", `project ${projectId} not found`, { httpStatus: 404 });
    }
    const target = (request.body as { target?: unknown })?.target ?? request.body;
    return await resolveTarget(db, projectId, indexCache, target as Parameters<typeof resolveTarget>[3], { store, screenshotCache });
  });
}

export type HistoryDeps = { db: Db };

interface CursorParams {
  scenario?: string;
  cursor?: string;
  limit?: string;
}

export async function entityRoutes(app: FastifyInstance, deps: HistoryDeps): Promise<void> {
  const { db } = deps;

  app.get("/v1/projects/:p/entities/:id/history", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const entityId = (request.params as { id: string }).id;
    const params = request.query as CursorParams;

    const entity = db
      .prepare("SELECT id, entity_key FROM ui_entities WHERE project_id = ? AND (id = ? OR entity_key = ?)")
      .get(projectId, entityId, entityId) as { id: string; entity_key: string } | undefined;
    if (!entity) {
      throw new UiIntelligenceError("NOT_FOUND", `entity ${entityId} not found`, { httpStatus: 404 });
    }

    const limit = Math.max(1, Math.min(200, Number(params.limit ?? 50) || 50));
    const offset = params.cursor ? Number(Buffer.from(params.cursor, "base64url").toString("utf8")) || 0 : 0;

    const clauses = ["o.project_id = ?", "(o.anchor = ? OR o.entity_version_id IN (SELECT id FROM entity_versions WHERE project_id = ? AND entity_id = ?))"];
    const queryParams: unknown[] = [projectId, entity.entity_key, projectId, entity.id];
    if (params.scenario) {
      clauses.push("c.scenario_id = ?");
      queryParams.push(params.scenario);
    }

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM occurrences o JOIN captures c ON c.id = o.capture_id WHERE ${clauses.join(" AND ")}`
        )
        .get(...queryParams) as { n: number }
    ).n;

    const rows = db
      .prepare(
        `SELECT o.id AS occurrence_id, o.anchor, o.visible_text, o.bounds_json, o.completeness,
                c.id AS capture_id, c.scenario_id, c.commit_sha, c.evidence_label, c.created_at AS captured_at, c.manifest_json
         FROM occurrences o JOIN captures c ON c.id = o.capture_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY c.created_at DESC, o.id ASC
         LIMIT ? OFFSET ?`
      )
      .all(...queryParams, limit, offset) as Array<Record<string, unknown>>;

    const observations = rows.map((row) => {
      const manifest = JSON.parse(row.manifest_json as string);
      const screenshot = (manifest.artifacts as Array<{ artifactId: string; kind: string }>).find(
        (a) => a.kind === "screenshot-png"
      );
      return {
        occurrenceId: row.occurrence_id,
        captureId: row.capture_id,
        commitSha: row.commit_sha,
        capturedAt: row.captured_at,
        scenarioId: row.scenario_id,
        evidenceLabel: row.evidence_label,
        anchor: row.anchor,
        visibleText: row.visible_text,
        bounds: JSON.parse(row.bounds_json as string),
        completeness: row.completeness,
        screenshotArtifactId: screenshot?.artifactId,
        summary: `${row.anchor ?? "(unanchored)"}: ${row.visible_text ?? "(no text)"}`,
      };
    });

    // Coverage gaps (spec section 13): gaps survive filtering — declared
    // scenarios without captures for this entity, with unbuildable commits
    // reported from failed builds.
    const project = getProject(db, projectId);
    const declaredScenarios = (project?.meta?.declaredScenarios as string[] | undefined) ?? [];
    const capturedScenarios = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT c.scenario_id FROM captures c
             WHERE c.project_id = ? AND c.commit_sha IN (
               SELECT DISTINCT commit_sha FROM occurrences WHERE project_id = ? AND (anchor = ? OR entity_version_id IN (
                 SELECT id FROM entity_versions WHERE project_id = ? AND entity_id = ?)))
             ${params.scenario ? "AND c.scenario_id = ?" : ""}`
          )
          .all(...(params.scenario ? [projectId, projectId, entity.entity_key, projectId, entity.id, params.scenario] : [projectId, projectId, entity.entity_key, projectId, entity.id])) as Array<{ scenario_id: string }>
      ).map((r) => r.scenario_id)
    );
    const failedCommits = (
      db.prepare("SELECT DISTINCT commit_sha FROM builds WHERE project_id = ? AND outcome = 'failed'").all(projectId) as Array<{ commit_sha: string }>
    ).map((r) => r.commit_sha);

    const gaps = declaredScenarios
      .filter((scenarioId) => !params.scenario || scenarioId === params.scenario)
      .filter((scenarioId) => !capturedScenarios.has(scenarioId))
      .map((scenarioId) => {
        const failedHere = failedCommits.filter(
          (sha) => !db.prepare("SELECT 1 FROM captures WHERE project_id = ? AND commit_sha = ? AND scenario_id = ?").get(projectId, sha, scenarioId)
        );
        if (failedHere.length > 0) {
          return {
            scenarioId,
            kind: "unbuildable" as const,
            reason: `build(s) failed for commit(s) ${failedHere.join(", ")}`,
          };
        }
        return { scenarioId, kind: "not_captured" as const, reason: "no captures for this scenario" };
      });

    const nextOffset = offset + observations.length;
    const nextCursor = nextOffset < total ? Buffer.from(String(nextOffset)).toString("base64url") : null;

    return {
      observations,
      gaps,
      nextCursor,
    };
  });
}
