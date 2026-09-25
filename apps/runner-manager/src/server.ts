/**
 * Runner-manager Fastify service (R2 stream D). buildManager(options) is
 * exported for tests (fastify.inject + temp sqlite); the listen main runs
 * when executed directly.
 *
 * Endpoints (Bearer auth via RUNNER_TOKEN, default dev-token; /health open):
 *   POST /v1/runs                    {projectId, repoUrl, commitSha, scenarios} → 202 {runId}
 *   GET  /v1/runs/:id                status + per-scenario results
 *   POST /v1/workers/register        {kind} → {workerId}
 *   POST /v1/workers/:id/heartbeat   extends worker liveness + run lease
 *   POST /v1/workers/:id/claim       leases the next queued run to the worker
 *   POST /v1/runs/:id/complete       {workerId, leaseToken, result|error}
 */
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import fastify, { type FastifyInstance, FastifyReply } from "fastify";
import type { ErrorCode } from "@ui-intelligence/protocol";
import type { Db } from "./db.js";
import { migrate, nowIso, openDb } from "./db.js";
import { defaultExecutor, type RunExecutor } from "./executor.js";
import { runPool, type PoolHandle } from "./pool.js";
import {
  claimNextRun,
  completeRun,
  createRun,
  getRun,
  heartbeatWorker,
  registerWorker,
  type RunClaim,
  type WorkerKind,
} from "./store.js";

export type ManagerOptions = {
  db: Db;
  token?: string;
  /** Injected in tests to avoid spawning browsers; defaults to the real one. */
  executor?: RunExecutor;
  leaseMs?: number;
};

declare module "fastify" {
  interface FastifyInstance {
    executor: RunExecutor;
  }
  interface FastifyRequest {
    traceId: string;
  }
}

function sendError(reply: FastifyReply, traceId: string, status: number, code: ErrorCode, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message }, traceId });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function buildManager(options: ManagerOptions): FastifyInstance {
  const { db } = options;
  const token = options.token ?? process.env.RUNNER_TOKEN ?? "dev-token";
  const executor = options.executor ?? defaultExecutor;
  const leaseMs = options.leaseMs ?? 30_000;

  const app = fastify({ logger: false });

  app.decorate("executor", executor);

  app.addHook("onRequest", async (request, reply) => {
    request.traceId = randomUUID();
    if (request.url === "/health") return; // liveness probe stays unauthenticated
    const header = request.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!presented || !safeEqual(presented, token)) {
      sendError(reply, request.traceId, 401, "UNAUTHORIZED", "missing or invalid credentials");
      return reply;
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const err = error as { statusCode?: number; httpStatus?: number; code?: ErrorCode };
    const status =
      typeof err.httpStatus === "number"
        ? err.httpStatus
        : typeof err.statusCode === "number" && err.statusCode >= 400
          ? err.statusCode
          : 500;
    sendError(reply, request.traceId, status, err.code ?? (status >= 500 ? "INTERNAL" : "SCHEMA_INVALID"), error.message);
  });

  app.get("/health", async () => ({ ok: true, service: "runner-manager", traceId: randomUUID() }));

  app.post("/v1/runs", async (request, reply) => {
    const body = request.body as {
      projectId?: unknown;
      repoUrl?: unknown;
      commitSha?: unknown;
      scenarios?: unknown;
    };
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl.trim() : "";
    const commitSha = typeof body.commitSha === "string" ? body.commitSha.trim() : "";
    const scenarios = Array.isArray(body.scenarios) ? body.scenarios.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];
    if (!projectId || !repoUrl || !commitSha) {
      return sendError(reply, request.traceId, 400, "SCHEMA_INVALID", "projectId, repoUrl, and commitSha are required");
    }
    if (scenarios.length === 0) {
      return sendError(reply, request.traceId, 400, "SCHEMA_INVALID", "scenarios must be a non-empty array of scenario ids");
    }
    const runId = createRun(db, { projectId, repoUrl, commitSha, scenarios });
    return reply.code(202).send({ runId });
  });

  app.get("/v1/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = getRun(db, id);
    if (!run) {
      return sendError(reply, request.traceId, 404, "NOT_FOUND", `run ${id} not found`);
    }
    return {
      runId: run.runId,
      projectId: run.projectId,
      repoUrl: run.repoUrl,
      commitSha: run.commitSha,
      scenarios: run.scenarios,
      status: run.status,
      workerId: run.workerId,
      attempt: run.attempt,
      maxAttempts: run.maxAttempts,
      error: run.error,
      results: run.results,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  });

  app.post("/v1/workers/register", async (request, reply) => {
    const body = request.body as { kind?: unknown };
    const kind = body.kind === "docker" ? "docker" : body.kind === "process" ? "process" : null;
    if (!kind) {
      return sendError(reply, request.traceId, 400, "SCHEMA_INVALID", 'kind must be "docker" or "process"');
    }
    const workerId = registerWorker(db, kind as WorkerKind);
    return reply.code(201).send({ workerId, kind, registeredAt: nowIso() });
  });

  app.post("/v1/workers/:id/heartbeat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { leaseExpiresAt } = heartbeatWorker(db, id, leaseMs);
    return { ok: true, leaseExpiresAt };
  });

  app.post("/v1/workers/:id/claim", async (request, reply) => {
    const { id } = request.params as { id: string };
    const claim: RunClaim | null = claimNextRun(db, id, leaseMs);
    if (!claim) return { claimed: false };
    return {
      claimed: true,
      runId: claim.runId,
      leaseToken: claim.leaseToken,
      leaseExpiresAt: claim.leaseExpiresAt,
      run: claim.run,
    };
  });

  app.post("/v1/runs/:id/complete", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      workerId?: unknown;
      leaseToken?: unknown;
      result?: { results?: unknown };
      error?: unknown;
    };
    const workerId = typeof body.workerId === "string" ? body.workerId : "";
    const leaseToken = typeof body.leaseToken === "string" ? body.leaseToken : "";
    if (!workerId || !leaseToken) {
      return sendError(reply, request.traceId, 400, "SCHEMA_INVALID", "workerId and leaseToken are required");
    }
    const rawResults = body.result?.results;
    const results = Array.isArray(rawResults)
      ? rawResults.filter((r): r is { scenarioId: string; status: "captured" | "failed"; captureId?: string; error?: string } => {
          const rec = r as Record<string, unknown> | null;
          return (
            !!rec &&
            typeof rec.scenarioId === "string" &&
            (rec.status === "captured" || rec.status === "failed")
          );
        })
      : undefined;
    const outcome = completeRun(db, id, {
      workerId,
      leaseToken,
      succeeded: !body.error,
      results,
      error: typeof body.error === "string" ? body.error : undefined,
    });
    return { ok: true, status: outcome.status };
  });

  return app;
}

export async function main(): Promise<void> {
  const dbPath = process.env.RUNNER_DB ?? "./data/runner.sqlite";
  const port = Number(process.env.PORT ?? 8900);
  const db = openDb(dbPath);
  migrate(db);
  const app = buildManager({ db });
  await app.listen({ port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`runner-manager listening on http://localhost:${port} (db: ${dbPath})`);

  // Optional embedded pool: workers usually join externally (capture-runner
  // processes or containers); set RUNNER_POOL_COUNT to spawn child workers
  // from this process (needs playwright + chromium available locally).
  const poolCount = Number(process.env.RUNNER_POOL_COUNT ?? "0");
  let pool: PoolHandle | null = null;
  if (poolCount > 0) {
    pool = runPool(poolCount, {
      managerUrl: `http://localhost:${port}`,
      appUrl: process.env.APP_URL ?? "http://localhost:5173",
    });
  }

  const shutdown = (signal: string) => {
    void pool?.stop().then(() => {
      db.close();
      // eslint-disable-next-line no-console
      console.log(`runner-manager stopped (${signal})`);
      process.exit(0);
    });
    if (!pool) {
      db.close();
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const invokedDirectly =
  typeof process !== "undefined" && process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
