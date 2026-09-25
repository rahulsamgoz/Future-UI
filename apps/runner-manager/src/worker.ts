/**
 * Worker-side run execution loop (R2 stream D). Registers with the manager,
 * claims queued runs, heartbeats every 10s while executing, and completes
 * with per-scenario results. The executor is injectable so tests (and the
 * embedded pool mode) never spawn browsers; production workers spawned by
 * runPool run the same protocol against the real capture path inside the
 * capture-runner process (apps/capture-runner/src/managed.ts, duplicated
 * locally by design — no cross-app imports).
 */
import type { RunExecutor } from "./executor.js";
import type { UploadApi } from "@ui-intelligence/capture";

export type WorkerLoopOptions = {
  managerUrl: string;
  token?: string;
  executor: RunExecutor;
  /** App URL the executor captures against (env APP_URL in production). */
  appUrl: string;
  /** History API for durable publication (passed through to the executor). */
  historyApi?: UploadApi;
  pollMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
};

const DEFAULT_POLL_MS = 2000;
const DEFAULT_HEARTBEAT_MS = 10_000;

type FetchResult = { status: number; ok: boolean; body: unknown };

async function managerFetch(
  baseUrl: string,
  token: string,
  method: string,
  apiPath: string,
  body?: unknown
): Promise<FetchResult> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${apiPath}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, ok: response.ok, body: text ? JSON.parse(text) : null };
}

export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const token = options.token ?? process.env.RUNNER_TOKEN ?? "dev-token";
  const log = options.onLog ?? (() => undefined);
  const signal = options.signal;

  const registered = await managerFetch(options.managerUrl, token, "POST", "/v1/workers/register", { kind: "process" });
  if (!registered.ok) {
    throw new Error(`worker registration failed (${registered.status})`);
  }
  const workerId = (registered.body as { workerId: string }).workerId;
  log(`worker ${workerId} registered with ${options.managerUrl}`);

  let currentRunId: string | null = null;
  const heartbeat = setInterval(() => {
    void managerFetch(options.managerUrl, token, "POST", `/v1/workers/${workerId}/heartbeat`).catch(() => undefined);
  }, heartbeatMs);

  const shutdown = async () => {
    clearInterval(heartbeat);
    log(`worker ${workerId} stopped`);
  };
  if (signal) {
    signal.addEventListener("abort", () => void shutdown(), { once: true });
  }

  try {
    while (!signal?.aborted) {
      let claimed: FetchResult;
      try {
        claimed = await managerFetch(options.managerUrl, token, "POST", `/v1/workers/${workerId}/claim`);
      } catch (error) {
        log(`claim failed: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      const body = claimed.body as { claimed: boolean; runId?: string; leaseToken?: string; run?: { projectId: string; repoUrl: string; commitSha: string; scenarios: string[] } } | null;
      if (!claimed.ok || !body?.claimed || !body.runId || !body.leaseToken || !body.run) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      currentRunId = body.runId;
      log(`worker ${workerId} claimed run ${currentRunId} (${body.run.scenarios.length} scenarios)`);
      let execution;
      try {
        execution = await options.executor({
          runId: body.runId,
          projectId: body.run.projectId,
          repoUrl: body.run.repoUrl,
          commitSha: body.run.commitSha,
          scenarios: body.run.scenarios,
          appUrl: options.appUrl,
          historyApi: options.historyApi,
        });
        await managerFetch(options.managerUrl, token, "POST", `/v1/runs/${body.runId}/complete`, {
          workerId,
          leaseToken: body.leaseToken,
          result: execution,
        });
        log(`run ${body.runId} completed: ${execution.results.map((r) => `${r.scenarioId}=${r.status}`).join(", ")}`);
      } catch (error) {
        // Executor crash: report the run as failed with the error; the
        // manager re-queues it while attempts remain.
        await managerFetch(options.managerUrl, token, "POST", `/v1/runs/${body.runId}/complete`, {
          workerId,
          leaseToken: body.leaseToken,
          error: (error as Error).message,
        }).catch(() => undefined);
        log(`run ${body.runId} failed: ${(error as Error).message}`);
      } finally {
        currentRunId = null;
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
}
