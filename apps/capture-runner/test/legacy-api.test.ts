/**
 * Integration test for legacy (API) mode (audit defect 1): the capture-runner
 * client must match the real API contract in apps/api — claim requires
 * { workerId }, complete requires { leaseToken }, cancellation goes through
 * POST /jobs/:id/cancel. Spins up the real API (buildApp on a temp SQLite DB)
 * and executes the runner's job-processing function against a reachable
 * static page, asserting job claimed → running → succeeded with the capture
 * ingested (occurrences present), plus the cancellation path ending cancelled
 * without publishing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, openDb, migrate, seedDevData, enqueueJob, getJob, REFERENCE_PROJECT_ID } from "@ui-intelligence/api";
import type { Db } from "@ui-intelligence/api";
import { executeCaptureJob } from "../src/runner.js";
import { createLegacyApiDeps, listQueuedCaptureJobs } from "../src/legacy.js";
import type { CaptureEnvironment, ScenarioRecipe } from "@ui-intelligence/capture";

const TOKEN = "dev-token";

const PAGE_HTML = `<!doctype html>
<html>
  <body>
    <main data-ui-entity="app.page">
      <section data-ui-entity="catalog.productChooser" data-ui-instance="primary">
        <h1>Product chooser</h1>
      </section>
    </main>
  </body>
</html>`;

const recipe: ScenarioRecipe = {
  id: "static-page-desktop",
  name: "Static page, desktop",
  route: "/",
  role: "visitor",
  viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
  locale: "en-US",
  timeZone: "UTC",
  colorScheme: "light",
  reducedMotion: false,
  featureFlags: {},
  fixture: "default",
  interactions: [],
  readiness: { selector: "[data-ui-entity='catalog.productChooser']", waitForFonts: false, stableFrames: 1 },
};

const environment: CaptureEnvironment = {
  runnerImageDigest: "local",
  browserRevision: "chromium-test",
  fontsDigest: "fonts-1",
  adapterVersion: "1.0.0",
  captureToolVersion: "1.0.0",
  redactionPolicyDigest: "policy",
};

function jobPayload(baseUrl: string): Record<string, unknown> {
  return {
    baseUrl,
    recipe,
    commitSha: "a".repeat(40),
    buildArtifactDigest: `digest-${Math.random().toString(16).slice(2, 10)}`,
    environment,
  };
}

function inject(app: ReturnType<typeof buildApp> extends Promise<infer A> ? A : never, method: string, url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    ...(payload ? { payload } : {}),
  });
}

describe("capture-runner legacy (API) mode", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: Db;
  let apiBaseUrl: string;
  let pageBaseUrl: string;
  let pageServer: http.Server;
  let workspaceDir: string;

  beforeAll(async () => {
    // Real API on a temp DB.
    workspaceDir = mkdtempSync(join(tmpdir(), "ui-intel-legacy-"));
    db = openDb(join(workspaceDir, "api.sqlite"));
    migrate(db);
    seedDevData(db);
    app = await buildApp({ db, storeDir: join(workspaceDir, "artifacts"), token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    apiBaseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    // Reachable static page for the scenario runner.
    pageServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE_HTML);
    });
    await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
    pageBaseUrl = `http://127.0.0.1:${(pageServer.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    pageServer?.close();
    try {
      db?.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("claims a queued capture job, publishes the capture, and completes with the lease token", async () => {
    const jobId = enqueueJob(db, {
      projectId: REFERENCE_PROJECT_ID,
      kind: "capture",
      stage: "capturing",
      payload: jobPayload(pageBaseUrl),
    });
    const deps = createLegacyApiDeps({ apiBaseUrl, token: TOKEN, projectId: REFERENCE_PROJECT_ID, workerId: "test-runner-1" });

    // The poll path (list endpoint) surfaces the queued capture job.
    const queued = await listQueuedCaptureJobs({ apiBaseUrl, token: TOKEN, projectId: REFERENCE_PROJECT_ID });
    expect(queued.map((j) => j.jobId)).toContain(jobId);

    const job = getJob(db, REFERENCE_PROJECT_ID, jobId)!;
    const outcome = await executeCaptureJob(job, deps);
    expect(outcome.status).toBe("completed");

    const captureId = "captureId" in outcome ? outcome.captureId : null;
    expect(captureId).toBeTruthy();

    // Job record: claimed (attempt 1) and succeeded.
    const jobResponse = await inject(app, "GET", `/v1/projects/${REFERENCE_PROJECT_ID}/jobs/${jobId}`);
    expect(jobResponse.statusCode).toBe(200);
    const jobRecord = jobResponse.json() as { status: string; attempt: number; finishedAt: string | null };
    expect(jobRecord.status).toBe("succeeded");
    expect(jobRecord.attempt).toBe(1);
    expect(jobRecord.finishedAt).not.toBeNull();

    // The capture is visible via GET /captures.
    const capturesResponse = await inject(app, "GET", `/v1/projects/${REFERENCE_PROJECT_ID}/captures`);
    expect(capturesResponse.statusCode).toBe(200);
    const captures = capturesResponse.json() as { captures: Array<{ captureId: string; observationCount: number }> };
    const published = captures.captures.find((c) => c.captureId === captureId);
    expect(published).toBeDefined();
    expect(published!.observationCount).toBeGreaterThan(0);

    // Occurrences were ingested for the capture.
    const occurrences = db
      .prepare("SELECT COUNT(*) AS n FROM occurrences WHERE capture_id = ?")
      .get(captureId) as { n: number };
    expect(occurrences.n).toBeGreaterThan(0);
  }, 120_000);

  it("ignores non-capture and non-queued jobs returned by the list endpoint", async () => {
    enqueueJob(db, {
      projectId: REFERENCE_PROJECT_ID,
      kind: "history_scan",
      stage: "planning",
      payload: { planId: "unused", projectId: REFERENCE_PROJECT_ID },
    });
    const queued = await listQueuedCaptureJobs({ apiBaseUrl, token: TOKEN, projectId: REFERENCE_PROJECT_ID });
    expect(queued.every((j) => j.kind === "capture" && j.status === "queued")).toBe(true);
  });

  it("ends a cancelled job cancelled without publishing a capture", async () => {
    const capturesBefore = (await inject(app, "GET", `/v1/projects/${REFERENCE_PROJECT_ID}/captures`)).json() as {
      captures: unknown[];
    };
    const beforeCount = capturesBefore.captures.length;

    const jobId = enqueueJob(db, {
      projectId: REFERENCE_PROJECT_ID,
      kind: "capture",
      stage: "capturing",
      payload: jobPayload(pageBaseUrl),
    });

    // The real cancel route: a queued job becomes terminal immediately.
    const cancelResponse = await inject(app, "POST", `/v1/projects/${REFERENCE_PROJECT_ID}/jobs/${jobId}/cancel`, {
      reason: "test cancellation",
    });
    expect(cancelResponse.statusCode).toBe(200);
    expect((cancelResponse.json() as { status: string }).status).toBe("cancelled");

    // The runner observes the terminal job through the real API and skips it.
    const job = getJob(db, REFERENCE_PROJECT_ID, jobId)!;
    const outcome = await executeCaptureJob(job, createLegacyApiDeps({ apiBaseUrl, token: TOKEN, projectId: REFERENCE_PROJECT_ID, workerId: "test-runner-2" }));
    expect(outcome.status).toBe("skipped");

    const jobResponse = await inject(app, "GET", `/v1/projects/${REFERENCE_PROJECT_ID}/jobs/${jobId}`);
    expect((jobResponse.json() as { status: string; attempt: number })).toMatchObject({ status: "cancelled", attempt: 0 });

    const capturesAfter = (await inject(app, "GET", `/v1/projects/${REFERENCE_PROJECT_ID}/captures`)).json() as {
      captures: unknown[];
    };
    expect(capturesAfter.captures.length).toBe(beforeCount);
  }, 60_000);
});
