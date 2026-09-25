/**
 * Managed-worker mode (R2 stream D): when RUNNER_MANAGER_URL is set, this
 * process works against the runner-manager (apps/runner-manager) instead of
 * the capture API — it registers, claims queued runs, heartbeats every 10s,
 * executes the run's scenarios against APP_URL with the real capture path,
 * and completes with per-scenario results. The claim/complete protocol here
 * is intentionally duplicated from the manager package (no cross-app
 * imports); the executor uses @ui-intelligence/capture directly.
 */
import { digestOf } from "@ui-intelligence/protocol";
import type { CaptureEnvironment } from "@ui-intelligence/protocol";
import { ScenarioRunner, standardScenarios } from "@ui-intelligence/capture";
import type { RedactionPolicy } from "@ui-intelligence/capture";

const HEARTBEAT_INTERVAL_MS = 10_000;

export type ManagedWorkerDeps = {
  managerUrl: string;
  token: string;
  appUrl: string;
  /** Injected for tests; defaults to the real capture path. */
  executeScenarios?: (scenarios: string[], input: { runId: string; projectId: string; repoUrl: string; commitSha: string; appUrl: string }) => Promise<{ results: ScenarioResult[] }>;
  pollMs?: number;
  heartbeatMs?: number;
  shouldStop?: () => boolean;
  onLog?: (message: string) => void;
};

export type ScenarioResult = {
  scenarioId: string;
  status: "captured" | "failed";
  captureId?: string;
  error?: string;
};

export async function executeRunScenarios(
  scenarios: string[],
  input: { runId: string; projectId: string; repoUrl: string; commitSha: string; appUrl: string }
): Promise<{ results: ScenarioResult[] }> {
  const all = standardScenarios();
  const redactionPolicy: RedactionPolicy = { version: "1", masks: [] };
  const runner = new ScenarioRunner({ baseUrl: input.appUrl, adapterVersion: "unknown", redactionPolicy });
  const environment: CaptureEnvironment = {
    runnerImageDigest: "local",
    browserRevision: "bundled-playwright",
    fontsDigest: "unknown",
    adapterVersion: "unknown",
    captureToolVersion: "1.0.0",
    redactionPolicyDigest: await digestOf(redactionPolicy),
  };
  const results: ScenarioResult[] = [];
  for (const scenarioId of scenarios) {
    const recipe = all.find((r) => r.id === scenarioId);
    if (!recipe) {
      results.push({ scenarioId, status: "failed", error: `unknown scenario id "${scenarioId}"` });
      continue;
    }
    try {
      const { manifest } = await runner.execute(recipe, {
        projectId: input.projectId,
        commitSha: input.commitSha,
        buildArtifactDigest: "runner-managed",
        environment,
      });
      results.push({ scenarioId, status: "captured", captureId: manifest.captureId });
    } catch (error) {
      results.push({ scenarioId, status: "failed", error: (error as Error).message });
    }
  }
  return { results };
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
