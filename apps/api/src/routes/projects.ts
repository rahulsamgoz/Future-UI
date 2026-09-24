/**
 * Project + history-plan + commit sync routes.
 */
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { enqueueJob, insertOutbox } from "../jobs.js";
import { planHistory } from "../planner.js";
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

  app.get("/v1/projects", async () => {
    const projects = listProjects(db);
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
    const record = planHistory(db, projectId, parsed.data);
    return reply.code(201).send(record);
  });

  app.post("/v1/projects/:p/history-plans/:id/runs", async (request, reply) => {
    const projectId = (request.params as { p: string }).p;
    const planId = (request.params as { id: string }).id;
    if (!getHistoryPlan(db, projectId, planId)) {
      throw new UiIntelligenceError("NOT_FOUND", `history plan ${planId} not found`, { httpStatus: 404 });
    }
    const jobId = enqueueJob(db, {
      projectId,
      kind: "history_scan",
      payload: { planId, projectId },
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
