/**
 * Disposable capture worker loop (architecture section 11): claims queued
 * capture jobs, executes them in isolation, uploads artifacts, and renews its
 * lease with heartbeats. Delivery is at least once.
 */
import { CaptureUploader, ScenarioRunner } from "@ui-intelligence/capture";
import type { ScenarioRecipe } from "@ui-intelligence/capture";
import type { CaptureEnvironment, CaptureManifest, JobRecord } from "@ui-intelligence/protocol";
import { executeCaptureJob } from "./runner.js";
import type { CaptureJobDeps } from "./runner.js";

const POLL_MS = Number(process.env.POLL_MS ?? "3000");
const API_BASE_URL = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
const PROJECT_ID = process.env.PROJECT_ID ?? "";
const TOKEN = process.env.UI_INTELLIGENCE_TOKEN ?? "";

let shuttingDown = false;
let currentJobId: string | null = null;

async function apiFetch(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, ok: response.ok, body: text ? JSON.parse(text) : null };
}

function buildDeps(): CaptureJobDeps {
  return {
    apiBaseUrl: API_BASE_URL,
    token: TOKEN,
    projectId: PROJECT_ID,
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
        const result = await apiFetch("POST", `/v1/projects/${PROJECT_ID}/jobs/${jobId}/claim`);
        if (!result.ok) throw new Error(`claim failed (${result.status})`);
        return result.body as { leaseToken: string };
      },
      async heartbeat(jobId: string, leaseToken: string) {
        await apiFetch("POST", `/v1/projects/${PROJECT_ID}/jobs/${jobId}/heartbeat`, { leaseToken });
      },
      async complete(jobId: string, result: { result: { captureId: string } }) {
        const response = await apiFetch("POST", `/v1/projects/${PROJECT_ID}/jobs/${jobId}/complete`, result);
        if (!response.ok) throw new Error(`complete failed (${response.status})`);
      },
      async cancelled(jobId: string, body: { reason: string }) {
        await apiFetch("POST", `/v1/projects/${PROJECT_ID}/jobs/${jobId}/cancelled`, body);
      },
    },
    isCancelling: () => shuttingDown,
  };
}

async function pollQueuedCaptureJobs(): Promise<JobRecord[]> {
  const result = await apiFetch("GET", `/v1/projects/${PROJECT_ID}/jobs?kind=capture&status=queued`);
  if (!result.ok) return [];
  const body = result.body as { jobs?: JobRecord[] } | JobRecord[] | null;
  return Array.isArray(body) ? body : (body?.jobs ?? []);
}

async function loop(): Promise<void> {
  console.log(`capture-runner polling ${API_BASE_URL} every ${POLL_MS}ms (project ${PROJECT_ID})`);
  while (!shuttingDown) {
    try {
      const jobs = await pollQueuedCaptureJobs();
      for (const job of jobs) {
        if (shuttingDown) break;
        currentJobId = job.jobId;
        try {
          const outcome = await executeCaptureJob(job, buildDeps());
          console.log(`job ${job.jobId} ${outcome.status} (capture ${outcome.captureId})`);
        } catch (error) {
          console.error(`job ${job.jobId} failed: ${(error as Error).message}`);
        } finally {
          currentJobId = null;
        }
      }
    } catch (error) {
      console.error(`poll failed: ${(error as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  console.log("capture-runner stopped");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
    console.log(
      currentJobId
        ? `${signal}: finishing current capture for job ${currentJobId}, then posting cancelled`
        : `${signal}: shutting down`
    );
  });
}

if (PROJECT_ID) {
  void loop();
}
