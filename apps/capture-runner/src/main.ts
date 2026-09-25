/**
 * Disposable capture worker loop (architecture section 11): claims queued
 * capture jobs, executes them in isolation, uploads artifacts, and renews its
 * lease with heartbeats. Delivery is at least once.
 *
 * Legacy (API) mode client details live in ./legacy.ts — claim/heartbeat/
 * complete/cancel payloads and paths match apps/api/src/routes/jobs.ts.
 */
import { executeCaptureJob } from "./runner.js";
import type { CaptureJobDeps } from "./runner.js";
import { createLegacyApiDeps, listQueuedCaptureJobs } from "./legacy.js";
import { managedWorkerFromEnv } from "./managed.js";

const POLL_MS = Number(process.env.POLL_MS ?? "3000");
const API_BASE_URL = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
const PROJECT_ID = process.env.PROJECT_ID ?? "";
const TOKEN = process.env.UI_INTELLIGENCE_TOKEN ?? "";
const WORKER_ID = process.env.WORKER_ID;

let shuttingDown = false;
let currentJobId: string | null = null;

function legacyOptions(): {
  apiBaseUrl: string;
  token: string;
  projectId: string;
  workerId?: string;
  isCancelling: () => boolean;
} {
  return { apiBaseUrl: API_BASE_URL, token: TOKEN, projectId: PROJECT_ID, workerId: WORKER_ID, isCancelling: () => shuttingDown };
}

function buildDeps(): CaptureJobDeps {
  return createLegacyApiDeps(legacyOptions());
}

async function loop(): Promise<void> {
  console.log(`capture-runner polling ${API_BASE_URL} every ${POLL_MS}ms (project ${PROJECT_ID})`);
  const deps = buildDeps();
  while (!shuttingDown) {
    try {
      const jobs = await listQueuedCaptureJobs(legacyOptions());
      for (const job of jobs) {
        if (shuttingDown) break;
        currentJobId = job.jobId;
        try {
          const outcome = await executeCaptureJob(job, deps);
          if (outcome.status === "skipped") {
            console.log(`job ${job.jobId} skipped (${job.status})`);
          } else {
            console.log(`job ${job.jobId} ${outcome.status} (capture ${outcome.captureId})`);
          }
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

// Managed-worker mode (R2 stream D): RUNNER_MANAGER_URL points this process
// at the runner-manager instead of the capture API. When set, the run
// protocol (register/claim/heartbeat/complete) drives execution and the
// scenarios are captured against APP_URL.
if (managedWorkerFromEnv().started) {
  // managed worker started; nothing else to do
} else if (PROJECT_ID) {
  void loop();
}
