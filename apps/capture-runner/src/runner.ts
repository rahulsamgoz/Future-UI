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
    complete(jobId: string, result: { result: { captureId: string } }): Promise<void>;
    cancelled(jobId: string, body: { reason: string }): Promise<void>;
  };
  /** Returns true when a shutdown signal was received. */
  isCancelling?: () => boolean;
};

export type CaptureJobOutcome =
  | { status: "completed"; captureId: string }
  | { status: "cancelled"; captureId: string };

const HEARTBEAT_INTERVAL_MS = 10_000;

/** Execute one claimed capture job: claim -> capture -> upload -> complete. */
export async function executeCaptureJob(job: JobRecord, deps: CaptureJobDeps): Promise<CaptureJobOutcome> {
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
    await deps.api.complete(job.jobId, { result: { captureId } });
    return { status: "completed", captureId };
  } finally {
    clearInterval(heartbeat);
  }
}
