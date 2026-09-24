import { describe, expect, it } from "vitest";
import { executeCaptureJob } from "../src/runner.js";
import type { CaptureJobDeps } from "../src/runner.js";
import type { CaptureEnvironment, CaptureManifest, JobRecord, ScenarioRecipe } from "@ui-intelligence/capture";

const recipe: ScenarioRecipe = {
  id: "catalog-default-desktop",
  name: "Catalog default, desktop",
  route: "/",
  role: "visitor",
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  locale: "en-US",
  timeZone: "UTC",
  colorScheme: "light",
  reducedMotion: false,
  featureFlags: {},
  fixture: "default",
  interactions: [],
  readiness: { waitForFonts: true, stableFrames: 2 },
};

const environment: CaptureEnvironment = {
  runnerImageDigest: "local",
  browserRevision: "chromium-1",
  fontsDigest: "fonts-1",
  adapterVersion: "1.0.0",
  captureToolVersion: "1.0.0",
  redactionPolicyDigest: "policy",
};

const manifest: CaptureManifest = {
  captureId: "capture_local_1",
  spec: {
    protocolVersion: 1,
    projectId: "proj-1",
    commitSha: "a".repeat(40),
    buildArtifactDigest: "digest-1",
    scenario: {
      id: "catalog-default-desktop",
      recipeDigest: "r",
      route: "/",
      fixtureDigest: "f",
      role: "visitor",
      featureFlagsDigest: "ff",
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      locale: "en-US",
      timeZone: "UTC",
      colorScheme: "light",
      reducedMotion: false,
    },
    environment,
  },
  capturedAt: "2026-09-23T00:00:00.000Z",
  gitParents: [],
  observations: [],
  artifacts: [],
  buildOutcome: "succeeded",
  redactionMasks: [],
  scrollOffsets: { x: 0, y: 0 },
  idempotencyKey: "key-1",
};

const job: JobRecord = {
  jobId: "job-1",
  projectId: "proj-1",
  kind: "capture",
  status: "queued",
  stage: "capturing",
  payload: {
    baseUrl: "http://app:5173",
    recipe,
    commitSha: "a".repeat(40),
    buildArtifactDigest: "digest-1",
    environment,
    projectId: "proj-1",
  },
  deduplicationKey: null,
  attempt: 1,
  maxAttempts: 3,
  leaseToken: null,
  leaseExpiresAt: null,
  lastError: null,
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
  finishedAt: null,
};

type Recorder = {
  calls: string[];
  deps: CaptureJobDeps;
};

function makeDeps(isCancelling: () => boolean = () => false): Recorder {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      apiBaseUrl: "http://api:4000",
      token: "t",
      projectId: "proj-1",
      runner: {
        async run(r, opts) {
          calls.push(`run:${r.id}:${opts.baseUrl}`);
          return { manifest, screenshotBytes: new Uint8Array([1, 2, 3]) };
        },
      },
      uploader: {
        async upload(m, bytes, api) {
          calls.push(`upload:${m.captureId}:${bytes.byteLength}:${api.projectId}`);
          return { captureId: "capture_server_1" };
        },
      },
      api: {
        async claim(jobId) {
          calls.push(`claim:${jobId}`);
          return { leaseToken: "lease-1" };
        },
        async heartbeat(jobId, leaseToken) {
          calls.push(`heartbeat:${jobId}:${leaseToken}`);
        },
        async complete(jobId, result) {
          calls.push(`complete:${jobId}:${result.result.captureId}`);
        },
        async cancelled(jobId, body) {
          calls.push(`cancelled:${jobId}:${body.reason}`);
        },
      },
      isCancelling,
    },
  };
}

describe("executeCaptureJob", () => {
  it("claims the job, uploads the manifest, and completes", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await executeCaptureJob(job, deps);
    expect(outcome).toEqual({ status: "completed", captureId: "capture_server_1" });
    expect(calls[0]).toBe("claim:job-1");
    expect(calls[1]).toBe("run:catalog-default-desktop:http://app:5173");
    expect(calls[2]).toBe("upload:capture_local_1:3:proj-1");
    expect(calls[3]).toBe("complete:job-1:capture_server_1");
  });

  it("posts cancelled when a shutdown signal arrived during capture", async () => {
    let cancelling = false;
    const { deps, calls } = makeDeps(() => cancelling);
    cancelling = true;
    const outcome = await executeCaptureJob(job, deps);
    expect(outcome.status).toBe("cancelled");
    expect(calls.some((c) => c.startsWith("cancelled:job-1:"))).toBe(true);
    expect(calls.some((c) => c.startsWith("complete:"))).toBe(false);
  });
});
