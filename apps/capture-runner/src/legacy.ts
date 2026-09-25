/**
 * Legacy (API) mode: this process works against the capture API's durable job
 * queue (apps/api/src/routes/jobs.ts). The client calls below match the real
 * API contract exactly:
 * - claim:     POST /v1/projects/:p/jobs/:id/claim      body { workerId } → LeaseClaim
 * - heartbeat: POST /v1/projects/:p/jobs/:id/heartbeat  body { leaseToken } → LeaseClaim
 * - complete:  POST /v1/projects/:p/jobs/:id/complete   body { leaseToken, result } → JobRecord
 * - cancel:    POST /v1/projects/:p/jobs/:id/cancel     body { reason } (queued → cancelled;
 *              running → cancel_requested, honored at the worker's next checkpoint)
 * - job:       GET  /v1/projects/:p/jobs/:id → JobRecord
 * Auth is the shared bearer token on every call.
 */
import { newId } from "@ui-intelligence/protocol";
import type { CaptureEnvironment, CaptureManifest, JobRecord } from "@ui-intelligence/protocol";
import { CaptureUploader, ScenarioRunner } from "@ui-intelligence/capture";
import type { ScenarioRecipe } from "@ui-intelligence/capture";
import type { CaptureJobDeps } from "./runner.js";

export type LegacyClientOptions = {
  apiBaseUrl: string;
  token: string;
  projectId: string;
  /** Stable identity for lease attribution; defaults to a fresh id. */
  workerId?: string;
  /** Shutdown signal observed at the runner's cancellation checkpoint. */
  isCancelling?: () => boolean;
};

type ApiResponse = { status: number; ok: boolean; body: unknown };

async function apiFetch(
  options: LegacyClientOptions,
  method: string,
  path: string,
  body?: unknown
): Promise<ApiResponse> {
  const base = options.apiBaseUrl.replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, ok: response.ok, body: text ? JSON.parse(text) : null };
}

function projectPath(options: LegacyClientOptions): string {
  return `/v1/projects/${encodeURIComponent(options.projectId)}`;
}

/** Job-processing dependencies backed by the real capture API. */
export function createLegacyApiDeps(options: LegacyClientOptions): CaptureJobDeps {
  const workerId = options.workerId ?? newId("worker");
  return {
    apiBaseUrl: options.apiBaseUrl,
    token: options.token,
    projectId: options.projectId,
    ...(options.isCancelling ? { isCancelling: options.isCancelling } : {}),
    runner: {
      async run(
        recipe: ScenarioRecipe,
        opts: { baseUrl: string; projectId: string; commitSha: string; buildArtifactDigest: string; environment: CaptureEnvironment }
      ): Promise<{ manifest: CaptureManifest; screenshotBytes: Uint8Array }> {
        const runner = new ScenarioRunner({
          baseUrl: opts.baseUrl,
          adapterVersion: opts.environment.adapterVersion,
          redactionPolicy: { version: "1", masks: [] },
        });
        return runner.execute(recipe, {
          projectId: opts.projectId,
          commitSha: opts.commitSha,
          buildArtifactDigest: opts.buildArtifactDigest,
          environment: opts.environment,
        });
      },
    },
    uploader: new CaptureUploader(),
    api: {
      async claim(jobId: string) {
        const result = await apiFetch(options, "POST", `${projectPath(options)}/jobs/${jobId}/claim`, { workerId });
        if (!result.ok) throw new Error(`claim failed (${result.status})`);
        return result.body as { leaseToken: string };
      },
      async heartbeat(jobId: string, leaseToken: string) {
        const result = await apiFetch(options, "POST", `${projectPath(options)}/jobs/${jobId}/heartbeat`, { leaseToken });
        if (!result.ok) throw new Error(`heartbeat failed (${result.status})`);
      },
      async complete(jobId: string, leaseToken: string, result: { result: { captureId: string } }) {
        const response = await apiFetch(options, "POST", `${projectPath(options)}/jobs/${jobId}/complete`, {
          leaseToken,
          ...result,
        });
        if (!response.ok) throw new Error(`complete failed (${response.status})`);
      },
      async cancelled(jobId: string, body: { reason: string }) {
        // The API exposes POST .../cancel (there is no /cancelled route).
        await apiFetch(options, "POST", `${projectPath(options)}/jobs/${jobId}/cancel`, body);
      },
      async getJob(jobId: string) {
        const result = await apiFetch(options, "GET", `${projectPath(options)}/jobs/${jobId}`);
        if (result.status === 404) return null;
        if (!result.ok) throw new Error(`get job failed (${result.status})`);
        return result.body as JobRecord;
      },
    },
  };
}

/**
 * Poll queued capture jobs. The list endpoint returns recent jobs for the
 * project; the kind/status query params are filters, and the result is
 * filtered client-side as well so an API that ignores them can never hand us
 * non-capture or non-queued work.
 */
export async function listQueuedCaptureJobs(options: LegacyClientOptions): Promise<JobRecord[]> {
  const result = await apiFetch(options, "GET", `${projectPath(options)}/jobs?limit=200`);
  if (!result.ok) return [];
  const body = result.body as { jobs?: JobRecord[] } | JobRecord[] | null;
  const jobs = Array.isArray(body) ? body : (body?.jobs ?? []);
  return jobs.filter((job) => job.kind === "capture" && job.status === "queued");
}
