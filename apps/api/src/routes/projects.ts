/**
 * Project + history-plan + commit sync routes.
 */
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { enqueueJob, insertOutbox } from "../jobs.js";
import { planHistory, resolveFixtureRepo } from "../planner.js";
import { getHistoryPlan, getProject, listProjects } from "../store.js";

const historyPlanInputSchema = z.object({
  repository: z.string().min(1),
  branches: z.array(z.string().min(1)).min(1),
  windowStart: z.string().min(1),
  windowEnd: z.string().min(1),
  scenarioIds: z.array(z.string().min(1)).default([]),
  maxBuilds: z.number().int().positive(),
  renderBudgetMs: z.number().nonnegative(),
  timezone: z.string().min(1),
  // Audit finding 3a: the reconstructable source repo travels with the plan
  // (validated + persisted) instead of being stripped, so run submission can
  // hand it to the history_scan job and reconstruction can actually run.
  fixtureRepo: z.string().min(1).optional(),
});

const commitSyncSchema = z.object({
  commits: z
    .array(
      z.object({
        sha: z.string().min(1),
        committedAt: z.string().min(1),
        parents: z.array(z.string()).default([]),
      })
    )
    .min(1),
});

export async function projectRoutes(app: FastifyInstance, deps: { db: Db }): Promise<void> {
  const { db } = deps;

  app.post("/v1/projects", async (request, reply) => {
    // Creating a project requires an operator-level principal in the dev
    // profile (role assignment happens at creation via the users API).
    if (!request.principal?.operator) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "project creation is operator-only" } });
    }
    const body = request.body as { name?: string; repository?: string };
    if (!body.name || !body.repository) {
      return reply.code(422).send({ error: { code: "SCHEMA_INVALID", message: "name and repository are required" } });
    }
    const existing = db.prepare("SELECT id FROM projects WHERE name = ?").get(body.name);
    if (existing) {
      return reply.code(409).send({ error: { code: "SCHEMA_INVALID", message: `project ${body.name} already exists` } });
    }
    const id = `proj_${body.name.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
    db.prepare(
      "INSERT INTO projects (id, name, repository, policy_revision, meta_json, created_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).run(id, body.name, body.repository, JSON.stringify({ scenarios: [] }), new Date().toISOString());
    return reply.code(201).send({ project: { id, name: body.name, repository: body.repository } });
  });

  app.get("/v1/projects", async (request) => {
    const principal = request.principal;
    // Listing is membership-filtered (audit fix, finding 1): the operator
    // sees every project; a user sees only projects they hold a membership in.
    const rowToProject = (row: Record<string, unknown>) => ({
      id: row.id as string,
      name: row.name as string,
      repository: row.repository as string,
      policyRevision: row.policy_revision as number,
      meta: row.meta_json ? (JSON.parse(row.meta_json as string) as Record<string, unknown>) : null,
    });
    const projects = principal?.operator
      ? listProjects(db)
      : (db
          .prepare(
            `SELECT p.* FROM projects p
             JOIN project_members m ON m.project_id = p.id
             WHERE m.user_id = ?
             ORDER BY p.created_at`
          )
          .all(principal?.userId ?? "") as Array<Record<string, unknown>>).map(rowToProject);
    return {
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        repository: p.repository,
        policyRevision: p.policyRevision,
        declaredScenarios: (p.meta?.declaredScenarios as string[] | undefined) ?? [],
      })),
    };
  });

  app.get("/v1/projects/:p", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const project = getProject(db, projectId);
    if (!project) throw new UiIntelligenceError("NOT_FOUND", `project ${projectId} not found`, { httpStatus: 404 });
    return {
      id: project.id,
      name: project.name,
      repository: project.repository,
      policyRevision: project.policyRevision,
      declaredScenarios: (project.meta?.declaredScenarios as string[] | undefined) ?? [],
      createdAt: project.createdAt,
    };
  });
}

export async function historyPlanRoutes(app: FastifyInstance, deps: { db: Db }): Promise<void> {
  const { db } = deps;

  app.post("/v1/projects/:p/history-plans", async (request, reply) => {
    const projectId = (request.params as { p: string }).p;
    if (!getProject(db, projectId)) {
      throw new UiIntelligenceError("NOT_FOUND", `project ${projectId} not found`, { httpStatus: 404 });
    }
    const parsed = historyPlanInputSchema.safeParse((request.body as { input?: unknown })?.input ?? request.body);
    if (!parsed.success) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "invalid history plan input", {
        httpStatus: 422,
        details: parsed.error.issues,
      });
    }
    // Audit finding 3a: validate + resolve fixtureRepo at plan time (existing
    // directory, inside the configured reconstruct roots) and persist the
    // resolved absolute path with the plan input.
    const input = parsed.data.fixtureRepo
      ? { ...parsed.data, fixtureRepo: resolveFixtureRepo(parsed.data.fixtureRepo) }
      : parsed.data;
    const record = planHistory(db, projectId, input);
    return reply.code(201).send(record);
  });

  app.post("/v1/projects/:p/history-plans/:id/runs", async (request, reply) => {
    const projectId = (request.params as { p: string }).p;
    const planId = (request.params as { id: string }).id;
    const plan = getHistoryPlan(db, projectId, planId);
    if (!plan) {
      throw new UiIntelligenceError("NOT_FOUND", `history plan ${planId} not found`, { httpStatus: 404 });
    }
    // Audit finding 3a: run submission copies the plan's fixtureRepo into the
    // job payload so the history_scan worker sees a repo path and can actually
    // reconstruct the selected commits (worker handleHistoryScan reads it from
    // the payload first, then from the plan input).
    // GAP A fix: also carry scenarioIds so the worker uses exactly the selected set.
    const jobId = enqueueJob(db, {
      projectId,
      kind: "history_scan",
      payload: {
        planId,
        projectId,
        ...(plan.input.fixtureRepo ? { fixtureRepo: plan.input.fixtureRepo } : {}),
        ...(plan.input.scenarioIds && plan.input.scenarioIds.length > 0 ? { scenarioIds: plan.input.scenarioIds } : {}),
      },
      dedupKey: `history_scan:${planId}`,
      stage: "planning",
    });
    insertOutbox(db, projectId, jobId);
    return reply.code(202).send({ jobId });
  });

  app.get("/v1/projects/:p/history-plans/:id", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const planId = (request.params as { id: string }).id;
    const plan = getHistoryPlan(db, projectId, planId);
    if (!plan) throw new UiIntelligenceError("NOT_FOUND", `history plan ${planId} not found`, { httpStatus: 404 });
    return plan;
  });
}

export async function commitRoutes(app: FastifyInstance, deps: { db: Db }): Promise<void> {
  const { db } = deps;

  app.post("/v1/projects/:p/commits:sync", async (request) => {
    const projectId = (request.params as { p: string }).p;
    if (!getProject(db, projectId)) {
      throw new UiIntelligenceError("NOT_FOUND", `project ${projectId} not found`, { httpStatus: 404 });
    }
    const parsed = commitSyncSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "invalid commit sync payload", {
        httpStatus: 422,
        details: parsed.error.issues,
      });
    }
    const insert = db.prepare(
      "INSERT OR REPLACE INTO commits (sha, project_id, committed_at, parents_json) VALUES (?, ?, ?, ?)"
    );
    const tx = db.transaction(() => {
      for (const commit of parsed.data.commits) {
        insert.run(commit.sha, projectId, commit.committedAt, JSON.stringify(commit.parents));
      }
    });
    tx();
    return { stored: parsed.data.commits.length };
  });
}
