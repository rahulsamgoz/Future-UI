/**
 * Runner-manager unit tests (R2 stream D). fastify.inject + a temp SQLite
 * file; the executor is a stub so no browsers are spawned.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrate, openDb, type Db } from "../src/db.js";
import { buildManager } from "../src/server.js";
import type { RunExecutor } from "../src/executor.js";
import { runPool, type PoolHandle } from "../src/pool.js";

let dir: string;
let db: Db;
let app: FastifyInstance;
const pools: PoolHandle[] = [];

function authed(app: FastifyInstance, method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { "content-type": "application/json", authorization: "Bearer dev-token" },
    payload: payload ?? {},
  });
}

const STUB_EXECUTOR: RunExecutor = async (input) => ({
  results: input.scenarios.map((scenarioId, index) =>
    index % 2 === 0
      ? { scenarioId, status: "captured" as const, captureId: `cap_${scenarioId}` }
      : { scenarioId, status: "failed" as const, error: "scenario setup failed" }
  ),
});

async function buildTestManager(executor: RunExecutor = STUB_EXECUTOR) {
  const testDir = mkdtempSync(join(tmpdir(), "runner-manager-"));
  const testDb = openDb(join(testDir, "runner.sqlite"));
  migrate(testDb);
  const testApp = buildManager({ db: testDb, token: "dev-token", executor });
  return { testDir, testDb, testApp };
}

beforeAll(async () => {
  const built = await buildTestManager();
  dir = built.testDir;
  db = built.testDb;
  app = built.testApp;
});

afterAll(async () => {
  for (const pool of pools) await pool.stop();
  await app.close();
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("runner-manager endpoints", () => {
  it("keeps /health unauthenticated and rejects unauthenticated /v1 calls", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const denied = await app.inject({ method: "POST", url: "/v1/runs", payload: {} });
    expect(denied.statusCode).toBe(401);
    const wrong = await authed(app, "POST", "/v1/runs", { projectId: "p" }).then((r) => r);
    expect(wrong.statusCode).toBe(400); // authenticated but invalid body
  });

  it("create run → worker registers + claims → completes with per-scenario results", async () => {
    const created = await authed(app, "POST", "/v1/runs", {
      projectId: "proj_reference_app",
      repoUrl: "https://github.com/example/app",
      commitSha: "abc123",
      scenarios: ["scenario-a", "scenario-b"],
    });
    expect(created.statusCode).toBe(202);
    const { runId } = created.json() as { runId: string };
    expect(runId).toMatch(/^run_/);

    const queued = await authed(app, "GET", `/v1/runs/${runId}`);
    expect((queued.json() as { status: string }).status).toBe("queued");

    const registered = await authed(app, "POST", "/v1/workers/register", { kind: "process" });
    expect(registered.statusCode).toBe(201);
    const { workerId } = registered.json() as { workerId: string };

    const beat = await authed(app, "POST", `/v1/workers/${workerId}/heartbeat`);
    expect(beat.statusCode).toBe(200);

    const claim = await authed(app, "POST", `/v1/workers/${workerId}/claim`);
    expect(claim.statusCode).toBe(200);
    const claimed = claim.json() as {
      claimed: boolean;
      runId: string;
      leaseToken: string;
      leaseExpiresAt: string;
      run: { scenarios: string[]; projectId: string; commitSha: string; repoUrl: string };
    };
    expect(claimed.claimed).toBe(true);
    expect(claimed.runId).toBe(runId);
    expect(claimed.leaseToken).toMatch(/^lease_/);
    expect(claimed.run.scenarios).toEqual(["scenario-a", "scenario-b"]);

    // Fake execution through the injected stub executor (no browsers).
    const execution = await app.executor({
      runId,
      projectId: claimed.run.projectId,
      repoUrl: claimed.run.repoUrl,
      commitSha: claimed.run.commitSha,
      scenarios: claimed.run.scenarios,
      appUrl: "http://localhost:5173",
    });
    expect(execution.results).toHaveLength(2);
    expect(execution.results[0]).toMatchObject({ scenarioId: "scenario-a", status: "captured" });

    const done = await authed(app, "POST", `/v1/runs/${runId}/complete`, {
      workerId,
      leaseToken: claimed.leaseToken,
      result: execution,
    });
    expect(done.statusCode).toBe(200);
    expect((done.json() as { status: string }).status).toBe("succeeded");

    const finished = await authed(app, "GET", `/v1/runs/${runId}`);
    const run = finished.json() as {
      status: string;
      results: Array<{ scenarioId: string; status: string; captureId?: string; error?: string }>;
    };
    expect(run.status).toBe("succeeded");
    expect(run.results).toHaveLength(2);
    expect(run.results[0]).toMatchObject({ scenarioId: "scenario-a", status: "captured", captureId: "cap_scenario-a" });
    expect(run.results[1]).toMatchObject({ scenarioId: "scenario-b", status: "failed", error: "scenario setup failed" });

    // Idempotent replay with the same lease is a no-op; a different lease is rejected.
    const replay = await authed(app, "POST", `/v1/runs/${runId}/complete`, {
      workerId,
      leaseToken: claimed.leaseToken,
      result: execution,
    });
    expect(replay.statusCode).toBe(200);
    const stale = await authed(app, "POST", `/v1/runs/${runId}/complete`, {
      workerId,
      leaseToken: "lease_someone_else",
      result: execution,
    });
    expect(stale.statusCode).toBe(409);
  });

  it("rejects complete with a lease that does not match the current lease", async () => {
    const { runId } = (
      await authed(app, "POST", "/v1/runs", {
        projectId: "p",
        repoUrl: "https://example.test/app",
        commitSha: "c1",
        scenarios: ["s1"],
      })
    ).json() as { runId: string };
    const { workerId } = (await authed(app, "POST", "/v1/workers/register", { kind: "docker" })).json() as { workerId: string };
    const claim = (await authed(app, "POST", `/v1/workers/${workerId}/claim`)).json() as { claimed: boolean; leaseToken: string };
    expect(claim.claimed).toBe(true);
    const wrongWorker = await authed(app, "POST", `/v1/runs/${runId}/complete`, {
      workerId: "worker_other",
      leaseToken: claim.leaseToken,
      result: { results: [] },
    });
    expect(wrongWorker.statusCode).toBe(409);
  });

  it("lease expiry allows another worker to re-claim the same run", async () => {
    const { runId } = (
      await authed(app, "POST", "/v1/runs", {
        projectId: "p",
        repoUrl: "https://example.test/app",
        commitSha: "c2",
        scenarios: ["s1"],
      })
    ).json() as { runId: string };
    const { workerId: w1 } = (await authed(app, "POST", "/v1/workers/register", { kind: "process" })).json() as { workerId: string };
    const first = (await authed(app, "POST", `/v1/workers/${w1}/claim`)).json() as { claimed: boolean; runId: string };
    expect(first.runId).toBe(runId);

    // Simulate lease expiry without waiting 30s.
    db.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), runId);

    const { workerId: w2 } = (await authed(app, "POST", "/v1/workers/register", { kind: "process" })).json() as { workerId: string };
    const second = (await authed(app, "POST", `/v1/workers/${w2}/claim`)).json() as { claimed: boolean; runId: string };
    expect(second.claimed).toBe(true);
    expect(second.runId).toBe(runId);

    const run = (await authed(app, "GET", `/v1/runs/${runId}`)).json() as { attempt: number; workerId: string };
    expect(run.attempt).toBe(2);
    expect(run.workerId).toBe(w2);
  });

  it("a second queued run waits until a worker frees (1 worker), and runs concurrently with 2", async () => {
    const mk = async (sha: string) =>
      (
        await authed(app, "POST", "/v1/runs", {
          projectId: "p",
          repoUrl: "https://example.test/app",
          commitSha: sha,
          scenarios: ["s1"],
        })
      ).json() as { runId: string };

    const runA = await mk("c-a");
    const runB = await mk("c-b");
    const { workerId: w1 } = (await authed(app, "POST", "/v1/workers/register", { kind: "process" })).json() as { workerId: string };

    const first = (await authed(app, "POST", `/v1/workers/${w1}/claim`)).json() as { claimed: boolean; runId: string };
    expect(first.claimed).toBe(true);
    expect([runA.runId, runB.runId]).toContain(first.runId);

    // One run per worker at a time: the busy worker gets nothing.
    const busy = (await authed(app, "POST", `/v1/workers/${w1}/claim`)).json() as { claimed: boolean };
    expect(busy.claimed).toBe(false);

    const other = first.runId === runA.runId ? runB.runId : runA.runId;
    // A second worker picks up the still-queued run while the first is busy.
    const { workerId: w2 } = (await authed(app, "POST", "/v1/workers/register", { kind: "process" })).json() as { workerId: string };
    const second = (await authed(app, "POST", `/v1/workers/${w2}/claim`)).json() as { claimed: boolean; runId: string };
    expect(second.claimed).toBe(true);
    expect(second.runId).toBe(other);
  });

  it("worker death (no heartbeat past expiry) marks the worker dead and re-queues its run", async () => {
    const { runId } = (
      await authed(app, "POST", "/v1/runs", {
        projectId: "p",
        repoUrl: "https://example.test/app",
        commitSha: "c3",
        scenarios: ["s1", "s2"],
      })
    ).json() as { runId: string };
    const { workerId: w1 } = (await authed(app, "POST", "/v1/workers/register", { kind: "process" })).json() as { workerId: string };
    const claim = (await authed(app, "POST", `/v1/workers/${w1}/claim`)).json() as { claimed: boolean; leaseToken: string };
    expect(claim.claimed).toBe(true);

    // The worker stopped heartbeating: backdate it past the 60s expiry.
    db.prepare("UPDATE workers SET last_heartbeat = ? WHERE id = ?").run(new Date(Date.now() - 61_000).toISOString(), w1);

    const { workerId: w2 } = (await authed(app, "POST", "/v1/workers/register", { kind: "process" })).json() as { workerId: string };
    const reclaim = (await authed(app, "POST", `/v1/workers/${w2}/claim`)).json() as { claimed: boolean; runId: string };
    expect(reclaim.claimed).toBe(true);
    expect(reclaim.runId).toBe(runId);

    const deadStatus = db.prepare("SELECT status FROM workers WHERE id = ?").get(w1) as { status: string };
    expect(deadStatus.status).toBe("dead");
    const deadBeat = await authed(app, "POST", `/v1/workers/${w1}/heartbeat`);
    expect(deadBeat.statusCode).toBe(409);

    const run = (await authed(app, "GET", `/v1/runs/${runId}`)).json() as { status: string; attempt: number };
    expect(run.status).toBe("running");
    expect(run.attempt).toBe(2);
  });

  it("retries a failed run with a bounded attempt count, then fails terminally", async () => {
    const { runId } = (
      await authed(app, "POST", "/v1/runs", {
        projectId: "p",
        repoUrl: "https://example.test/app",
        commitSha: "c4",
        scenarios: ["s1"],
      })
    ).json() as { runId: string };
    const reg = await authed(app, "POST", "/v1/workers/register", { kind: "process" });
    const { workerId } = reg.json() as { workerId: string };

    // Attempt 1: fails → back to queued.
    const c1 = (await authed(app, "POST", `/v1/workers/${workerId}/claim`)).json() as { claimed: boolean; leaseToken: string };
    const f1 = await authed(app, "POST", `/v1/runs/${runId}/complete`, { workerId, leaseToken: c1.leaseToken, error: "browser crashed" });
    expect((f1.json() as { status: string }).status).toBe("queued");

    // Attempt 2: fails → terminal failed (maxAttempts 3).
    const c2 = (await authed(app, "POST", `/v1/workers/${workerId}/claim`)).json() as { claimed: boolean; leaseToken: string };
    const f2 = await authed(app, "POST", `/v1/runs/${runId}/complete`, { workerId, leaseToken: c2.leaseToken, error: "browser crashed" });
    expect((f2.json() as { status: string }).status).toBe("queued");

    const c3 = (await authed(app, "POST", `/v1/workers/${workerId}/claim`)).json() as { claimed: boolean; leaseToken: string };
    const f3 = await authed(app, "POST", `/v1/runs/${runId}/complete`, { workerId, leaseToken: c3.leaseToken, error: "browser crashed" });
    expect((f3.json() as { status: string }).status).toBe("failed");
    const run = (await authed(app, "GET", `/v1/runs/${runId}`)).json() as { status: string; error: string; attempt: number };
    expect(run.status).toBe("failed");
    expect(run.error).toBe("browser crashed");
    expect(run.attempt).toBe(3);
  });

  it("completing a run frees the worker to claim the next queued run", async () => {
    const mk = async (sha: string) =>
      (
        await authed(app, "POST", "/v1/runs", {
          projectId: "p",
          repoUrl: "https://example.test/app",
          commitSha: sha,
          scenarios: ["s1"],
        })
      ).json() as { runId: string };
    const runA = await mk("c-free-1");
    const { workerId } = (await authed(app, "POST", "/v1/workers/register", { kind: "process" })).json() as { workerId: string };
    const c1 = (await authed(app, "POST", `/v1/workers/${workerId}/claim`)).json() as { claimed: boolean; leaseToken: string };
    expect(c1.claimed).toBe(true);

    const runB = await mk("c-free-2");
    const busy = (await authed(app, "POST", `/v1/workers/${workerId}/claim`)).json() as { claimed: boolean };
    expect(busy.claimed).toBe(false);

    await authed(app, "POST", `/v1/runs/${runA.runId}/complete`, {
      workerId,
      leaseToken: c1.leaseToken,
      result: { results: [{ scenarioId: "s1", status: "captured", captureId: "cap_x" }] },
    });
    const c2 = (await authed(app, "POST", `/v1/workers/${workerId}/claim`)).json() as { claimed: boolean; runId: string };
    expect(c2.claimed).toBe(true);
    expect(c2.runId).toBe(runB.runId);
  });
});

describe("embedded worker pool (runPool with injected executor)", () => {
  it("drains two queued runs with two embedded workers", async () => {
    const built = await buildTestManager();
    const { testDb: poolDb, testApp: poolApp, testDir: poolDir } = built;
    try {
      await poolApp.listen({ port: 0, host: "127.0.0.1" });
      const address = poolApp.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const managerUrl = `http://127.0.0.1:${port}`;

      const pool = runPool(2, {
        managerUrl,
        token: "dev-token",
        appUrl: "http://localhost:5173",
        executor: STUB_EXECUTOR,
        pollMs: 50,
        heartbeatMs: 200,
      });
      pools.push(pool);

      const mk = async (sha: string) =>
        (
          await authed(poolApp, "POST", "/v1/runs", {
            projectId: "p",
            repoUrl: "https://example.test/app",
            commitSha: sha,
            scenarios: ["s1", "s2"],
          })
        ).json() as { runId: string };
      const runA = await mk("pool-a");
      const runB = await mk("pool-b");

      const deadline = Date.now() + 15_000;
      for (;;) {
        const a = (await authed(poolApp, "GET", `/v1/runs/${runA.runId}`)).json() as { status: string };
        const b = (await authed(poolApp, "GET", `/v1/runs/${runB.runId}`)).json() as { status: string };
        if (a.status === "succeeded" && b.status === "succeeded") break;
        if (a.status === "failed" || b.status === "failed") throw new Error(`pool run failed: ${JSON.stringify({ a, b })}`);
        if (Date.now() > deadline) throw new Error(`pool did not drain runs: ${JSON.stringify({ a, b })}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const results = (await authed(poolApp, "GET", `/v1/runs/${runA.runId}`)).json() as {
        results: Array<{ captureId?: string }>;
      };
      expect(results.results[0].captureId).toBe("cap_s1");
      await pool.stop();
      await poolApp.close();
      poolDb.close();
      rmSync(poolDir, { recursive: true, force: true });
    } finally {
      await poolApp.close().catch(() => undefined);
      poolDb.close();
      try {
        rmSync(poolDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });
});
