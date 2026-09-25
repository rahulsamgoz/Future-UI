/**
 * Managed-worker mode (R2 stream D): when RUNNER_MANAGER_URL is set, this
 * process works against the runner-manager (apps/runner-manager) instead of
 * the capture API — it registers, claims queued runs, heartbeats every 10s,
 * executes the run's scenarios, DURABLY PUBLISHES each capture to the history
 * API (CaptureUploader + publication verification — audit fix: managed
 * executors no longer report capture ids without uploading artifacts or
 * ingesting), and completes with per-scenario results + honest provenance.
 *
 * Commit binding (audit finding 3d): execution delegates to the shared
 * executeManagedRun in @ui-intelligence/capture — a LOCAL repoUrl triggers
 * REAL commit reconstruction (worktree -> serve -> capture -> publish ->
 * verify); a remote/absent repoUrl captures APP_URL with a build digest from
 * the served page's HTML and the note "commit binding asserted, not
 * verified". The claim/complete protocol here is intentionally duplicated
 * from the manager package (no cross-app imports).
 */
import type { ManagedRunArgs, ManagedRunOutcome } from "@ui-intelligence/capture";
import { executeManagedRun } from "@ui-intelligence/capture";
import type { CaptureUploader, ScenarioRunner, UploadApi } from "@ui-intelligence/capture";

const HEARTBEAT_INTERVAL_MS = 10_000;

export type ManagedWorkerDeps = {
  managerUrl: string;
  token: string;
  appUrl: string;
  /**
   * History API for durable publication (audit finding: managed executors must
   * not just report capture ids — they must publish them). Defaults to the
   * HISTORY_API_URL / HISTORY_API_TOKEN / HISTORY_API_PROJECT env vars.
   */
  historyApi?: UploadApi;
  /** Injected for tests; defaults to the real capture path. */
  executeScenarios?: (
    scenarios: string[],
    input: { runId: string; projectId: string; repoUrl: string; commitSha: string; appUrl: string }
  ) => Promise<ManagedRunOutcome>;
  pollMs?: number;
  heartbeatMs?: number;
  shouldStop?: () => boolean;
  onLog?: (message: string) => void;
};

export type ScenarioResult = {
  scenarioId: string;
  status: "captured" | "failed";
  captureId?: string;
  artifactId?: string;
  error?: string;
};

export async function executeRunScenarios(
  scenarios: string[],
  input: { runId: string; projectId: string; repoUrl: string; commitSha: string; appUrl: string; historyApi?: UploadApi },
  deps?: {
    uploader?: Pick<InstanceType<typeof CaptureUploader>, "upload">;
    runner?: Pick<ScenarioRunner, "execute">;
    fetch?: typeof fetch;
    reconstruct?: NonNullable<ManagedRunArgs["deps"]>["reconstruct"];
  }
): Promise<ManagedRunOutcome> {
  // Durable publication + honest commit binding (audit findings): a local
  // repoUrl reconstructs the actual commit; remote/absent captures APP_URL
  // with a served-page digest and the honest "asserted, not verified"
  // provenance. Without a history API nothing is reported as captured.
  return executeManagedRun({
    projectId: input.projectId,
    repoUrl: input.repoUrl || undefined,
    commitSha: input.commitSha,
    scenarios,
    appUrl: input.appUrl,
    api: input.historyApi,
    deps,
  });
}

async function managerFetch(
  baseUrl: string,
  token: string,
  method: string,
  apiPath: string,
  body?: unknown
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${apiPath}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, ok: response.ok, body: text ? JSON.parse(text) : null };
}

export async function runManagedWorker(deps: ManagedWorkerDeps): Promise<void> {
  const pollMs = deps.pollMs ?? 2000;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const log = deps.onLog ?? (() => undefined);
  const execute = deps.executeScenarios ?? executeRunScenarios;

  const registered = await managerFetch(deps.managerUrl, deps.token, "POST", "/v1/workers/register", { kind: "process" });
  if (!registered.ok) throw new Error(`worker registration failed (${registered.status})`);
  const workerId = (registered.body as { workerId: string }).workerId;
  log(`managed worker ${workerId} registered with ${deps.managerUrl}`);

  const heartbeat = setInterval(() => {
    void managerFetch(deps.managerUrl, deps.token, "POST", `/v1/workers/${workerId}/heartbeat`).catch(() => undefined);
  }, heartbeatMs);

  try {
    while (!deps.shouldStop?.()) {
      let claim: { status: number; ok: boolean; body: unknown };
      try {
        claim = await managerFetch(deps.managerUrl, deps.token, "POST", `/v1/workers/${workerId}/claim`);
      } catch (error) {
        log(`claim failed: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      const body = claim.body as
        | { claimed: boolean; runId?: string; leaseToken?: string; run?: { projectId: string; repoUrl: string; commitSha: string; scenarios: string[] } }
        | null;
      if (!claim.ok || !body?.claimed || !body.runId || !body.leaseToken || !body.run) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      const { runId, leaseToken, run } = body as { runId: string; leaseToken: string; run: NonNullable<typeof body.run> };
      log(`claimed run ${runId} (${run.scenarios.length} scenarios)`);
      try {
        const execution = await execute(run.scenarios, {
          runId,
          projectId: run.projectId,
          repoUrl: run.repoUrl,
          commitSha: run.commitSha,
          appUrl: deps.appUrl,
          historyApi: deps.historyApi,
        });
        await managerFetch(deps.managerUrl, deps.token, "POST", `/v1/runs/${runId}/complete`, {
          workerId,
          leaseToken,
          result: execution,
        });
        log(`run ${runId} completed: ${execution.results.map((r) => `${r.scenarioId}=${r.status}`).join(", ")}`);
      } catch (error) {
        await managerFetch(deps.managerUrl, deps.token, "POST", `/v1/runs/${runId}/complete`, {
          workerId,
          leaseToken,
          error: (error as Error).message,
        }).catch(() => undefined);
        log(`run ${runId} failed: ${(error as Error).message}`);
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
}

/** Entry used by main.ts when RUNNER_MANAGER_URL is configured. */
export function managedWorkerFromEnv(): { started: boolean } {
  const managerUrl = process.env.RUNNER_MANAGER_URL;
  if (!managerUrl) return { started: false };
  const appUrl = process.env.APP_URL ?? "http://localhost:5173";
  let shuttingDown = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      shuttingDown = true;
      console.log(`${signal}: managed worker draining (finishes the current scenario batch)`);
    });
  }
  void runManagedWorker({
    managerUrl,
    token: process.env.RUNNER_TOKEN ?? "dev-token",
    appUrl,
    shouldStop: () => shuttingDown,
    onLog: (message) => console.log(message),
  }).catch((error) => {
    console.error(`managed worker crashed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
  return { started: true };
}
