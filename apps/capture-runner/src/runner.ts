/**
 * Capture job execution with injected dependencies (architecture section 11).
 * Kept separate from main.ts so unit tests can use fakes.
 */
import type { ScenarioRecipe } from "@ui-intelligence/capture";
import type {
  CaptureEnvironment,
  CaptureManifest,
  JobRecord,
} from "@ui-intelligence/protocol";

export type CaptureJobPayload = {
  baseUrl: string;
  recipe: ScenarioRecipe;
  commitSha: string;
  buildArtifactDigest: string;
  environment: CaptureEnvironment;
  projectId?: string;
};

export type CaptureJobDeps = {
  apiBaseUrl: string;
  token: string;
  projectId: string;
  /** Returns manifest plus raw screenshot bytes for upload. */
  runner: {
    run(
      recipe: ScenarioRecipe,
      opts: {
        baseUrl: string;
        projectId: string;
        commitSha: string;
        buildArtifactDigest: string;
        environment: CaptureEnvironment;
      }
    ): Promise<{ manifest: CaptureManifest; screenshotBytes: Uint8Array }>;
  };
  uploader: {
    upload(
      manifest: CaptureManifest,
      screenshotBytes: Uint8Array,
      api: { baseUrl: string; token: string; projectId: string }
    ): Promise<{ captureId: string }>;
  };
  api: {
    claim(jobId: string): Promise<{ leaseToken: string }>;
    heartbeat(jobId: string, leaseToken: string): Promise<void>;
    /** leaseToken must travel with the completion (the API rejects otherwise). */
    complete(jobId: string, leaseToken: string, result: { result: { captureId: string } }): Promise<void>;
    cancelled(jobId: string, body: { reason: string }): Promise<void>;
    /** Fresh job record for pre-claim cancellation checks; optional for tests. */
    getJob?(jobId: string): Promise<JobRecord | null>;
  };
  /** Returns true when a shutdown signal was received. */
  isCancelling?: () => boolean;
};

export type CaptureJobOutcome =
  | { status: "completed"; captureId: string }
  | { status: "cancelled"; captureId: string }
  /** Job already terminal before claiming (e.g. cancelled while queued). */
  | { status: "skipped"; captureId: null };

const HEARTBEAT_INTERVAL_MS = 10_000;

/** Terminal job statuses (protocol jobStatusSchema). */
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

/** Execute one claimed capture job: claim -> capture -> upload -> complete. */
export async function executeCaptureJob(job: JobRecord, deps: CaptureJobDeps): Promise<CaptureJobOutcome> {
  // Pre-claim checkpoint: a job that reached a terminal state (most notably a
  // cancellation while queued) must not be claimed or published.
  if (deps.api.getJob) {
    const current = await deps.api.getJob(job.jobId);
    if (current && TERMINAL_STATUSES.has(current.status)) {
      return { status: "skipped", captureId: null };
    }
  }
  const { leaseToken } = await deps.api.claim(job.jobId);
  const heartbeat = setInterval(() => {
    void deps.api.heartbeat(job.jobId, leaseToken).catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  try {
    const payload = job.payload as CaptureJobPayload;
    const projectId = payload.projectId ?? deps.projectId;
    const { manifest, screenshotBytes } = await deps.runner.run(payload.recipe, {
      baseUrl: payload.baseUrl,
      projectId,
      commitSha: payload.commitSha,
      buildArtifactDigest: payload.buildArtifactDigest,
      environment: payload.environment,
    });
    const { captureId } = await deps.uploader.upload(manifest, screenshotBytes, {
      baseUrl: deps.apiBaseUrl,
      token: deps.token,
      projectId,
    });
    if (deps.isCancelling?.()) {
      await deps.api.cancelled(job.jobId, { reason: "worker received shutdown signal during capture" });
      return { status: "cancelled", captureId };
    }
    await deps.api.complete(job.jobId, leaseToken, { result: { captureId } });
    return { status: "completed", captureId };
  } finally {
    clearInterval(heartbeat);
  }
}
