/**
 * Job routes: durable records, cancellation, leases, heartbeats, completion.
 */
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { cancelJob, claimJob, completeJob, heartbeatJob } from "../jobs.js";
import { getJob, listJobs } from "../store.js";

export type JobDeps = { db: Db };

export async function jobRoutes(app: FastifyInstance, deps: JobDeps): Promise<void> {
  const { db } = deps;

  app.get("/v1/projects/:p/jobs", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const query = request.query as { limit?: string; kind?: string; status?: string };
    return {
      jobs: listJobs(db, projectId, Math.min(200, Number(query.limit) || 100), {
        kind: query.kind,
        status: query.status,
      }),
    };
  });

  app.get("/v1/projects/:p/jobs/:id", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const jobId = (request.params as { id: string }).id;
    const job = getJob(db, projectId, jobId);
    if (!job) throw new UiIntelligenceError("NOT_FOUND", `job ${jobId} not found`, { httpStatus: 404 });
    return job;
  });

  app.post("/v1/projects/:p/jobs/:id/cancel", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const jobId = (request.params as { id: string }).id;
    return cancelJob(db, projectId, jobId);
  });

  app.post("/v1/projects/:p/jobs/:id/claim", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const jobId = (request.params as { id: string }).id;
    const workerId = (request.body as { workerId?: string })?.workerId;
    if (!workerId) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "workerId is required", { httpStatus: 422 });
    }
    return claimJob(db, projectId, jobId, workerId);
  });

  app.post("/v1/projects/:p/jobs/:id/heartbeat", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const jobId = (request.params as { id: string }).id;
    const leaseToken = (request.body as { leaseToken?: string })?.leaseToken;
    if (!leaseToken) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "leaseToken is required", { httpStatus: 422 });
    }
    return heartbeatJob(db, projectId, jobId, leaseToken);
  });

  app.post("/v1/projects/:p/jobs/:id/complete", async (request) => {
    const projectId = (request.params as { p: string }).p;
    const jobId = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as { leaseToken?: string; result?: unknown; error?: string };
    if (!body.leaseToken) {
      throw new UiIntelligenceError("SCHEMA_INVALID", "leaseToken is required", { httpStatus: 422 });
    }
    completeJob(db, projectId, jobId, body.leaseToken, {
      succeeded: !body.error,
      result: body.result,
      error: body.error,
      stage: "done",
    });
    const job = getJob(db, projectId, jobId);
    if (!job) throw new UiIntelligenceError("NOT_FOUND", `job ${jobId} not found`, { httpStatus: 404 });
    return job;
  });
}
