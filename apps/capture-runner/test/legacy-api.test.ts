/**
 * Integration test for legacy (API) mode (audit defect 1): the capture-runner
 * client must match the real API contract in apps/api — claim requires
 * { workerId }, complete requires { leaseToken }, cancellation goes through
 * POST /jobs/:id/cancel. Spins up the real API (buildApp on a temp SQLite DB)
 * and executes the runner's job-processing function against a reachable
 * static page, asserting job claimed → running → succeeded with the capture
 * ingested (occurrences present), plus the cancellation path ending cancelled
 * without publishing.
 *
 * Browser gating (audit finding 6): the capture path launches real Chromium.
 * The suite probes browser availability up front and FAILS LOUDLY when
 * Chromium is missing (e.g. a CI image that forgot `npx playwright install
 * --with-deps chromium`) — it never silently skips the regression. Constrained
 * environments without a browser may set UI_INTEL_ALLOW_NO_BROWSER=1 to
 * explicitly skip the browser-dependent test with a visible reason.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "vitest";
import { buildApp, openDb, migrate, seedDevData, enqueueJob, getJob, REFERENCE_PROJECT_ID } from "@ui-intelligence/api";
import type { Db } from "@ui-intelligence/api";
import { executeCaptureJob } from "../src/runner.js";
import { createLegacyApiDeps, listQueuedCaptureJobs } from "../src/legacy.js";
import type { CaptureEnvironment, ScenarioRecipe } from "@ui-intelligence/capture";

const TOKEN = "dev-token";

/** Env var documented for constrained environments: explicit no-browser opt-out. */
export const ALLOW_NO_BROWSER_ENV = "UI_INTEL_ALLOW_NO_BROWSER";

/** A pluggable browser probe: resolves when a headless Chromium can launch. */
export type BrowserProbe = () => Promise<void>;

/** The real probe used in beforeAll: launch + close through Playwright. */
export async function launchHeadlessChromium(): Promise<void> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  await browser.close();
}

export type BrowserAvailability = { available: boolean; detail: string };

/**
 * Probe browser availability by attempting a real headless launch (the same
 * code path the capture runner uses, so it catches e.g. a missing
 * chromium_headless_shell even when the headed build exists).
 */
export async function probeChromium(probe: BrowserProbe = launchHeadlessChromium): Promise<BrowserAvailability> {
  try {
    await probe();
    return { available: true, detail: "headless chromium launch succeeded" };
  } catch (error) {
    return { available: false, detail: (error as Error)?.message ?? String(error) };
  }
}

export type BrowserGateDecision = { action: "run" | "skip" | "fail"; message: string };

/**
 * Gate decision for browser-dependent tests:
 * - available → run;
 * - missing + ALLOW_NO_BROWSER_ENV=1 → skip with an explicit visible reason;
 * - missing otherwise → FAIL loudly, pointing at the missing install step
 *   (the default must never be a silent skip).
 */
export function browserGate(availability: BrowserAvailability, env: NodeJS.ProcessEnv = process.env): BrowserGateDecision {
  if (availability.available) {
    return { action: "run", message: availability.detail };
  }
  if (env[ALLOW_NO_BROWSER_ENV] === "1") {
    return { action: "skip", message: "browser not installed (UI_INTEL_ALLOW_NO_BROWSER=1)" };
  }
  return {
    action: "fail",
    message:
      "Chromium is not installed for Playwright — the capture regression test cannot run. " +
      "Fix the environment: run `npx playwright install --with-deps chromium` (the CI workflow " +
      "does this before tests; see .github/workflows/ci.yml). This test fails loudly instead of " +
      `silently skipping. To explicitly opt out in a constrained environment set ${ALLOW_NO_BROWSER_ENV}=1. ` +
      `Probe detail: ${availability.detail}`,
  };
}

/** Shared skip handling for browser-dependent tests: visible reason + hard skip. */
function skipWithoutBrowser(ctx: TestContext, reason: string | null): void {
  if (reason !== null) {
    // eslint-disable-next-line no-console
    console.warn(`[legacy-api] SKIPPED: ${reason}`);
    ctx.skip();
  }
}

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
  /** Non-null → browser-dependent tests are skipped with this visible reason. */
  let browserSkipReason: string | null = null;

  beforeAll(async () => {
    // Browser gate (audit finding 6): fail loudly when Chromium is missing,
    // unless UI_INTEL_ALLOW_NO_BROWSER=1 opts this environment out explicitly.
    const gate = browserGate(await probeChromium());
    if (gate.action === "fail") throw new Error(gate.message);
    if (gate.action === "skip") {
      browserSkipReason = gate.message;
      // eslint-disable-next-line no-console
      console.warn(`[legacy-api] ${gate.message} — browser-dependent tests will be skipped`);
    }

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

  it("claims a queued capture job, publishes the capture, and completes with the lease token", async (ctx: TestContext) => {
    skipWithoutBrowser(ctx, browserSkipReason);
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

describe("browser availability gate (audit finding 6)", () => {
  it("runs when the probe launch succeeds", () => {
    const decision = browserGate({ available: true, detail: "launch ok" }, {});
    expect(decision).toMatchObject({ action: "run" });
  });

  it("fails loudly and points at the missing install step when Chromium is missing (no env override)", () => {
    const decision = browserGate(
      {
        available: false,
        detail: "browserType.launch: Executable doesn't exist at ... chromium_headless_shell-1243",
      },
      {}
    );
    expect(decision.action).toBe("fail");
    expect(decision.message).toMatch(/playwright install --with-deps chromium/);
    expect(decision.message).toMatch(/ci\.yml/);
    expect(decision.message).toMatch(/chromium_headless_shell-1243/);
  });

  it("skips with an explicit visible reason only under UI_INTEL_ALLOW_NO_BROWSER=1", () => {
    const decision = browserGate(
      { available: false, detail: "browserType.launch: Executable doesn't exist" },
      { UI_INTEL_ALLOW_NO_BROWSER: "1" }
    );
    expect(decision).toEqual({
      action: "skip",
      message: "browser not installed (UI_INTEL_ALLOW_NO_BROWSER=1)",
    });
  });

  it("treats values other than '1' as no opt-out (default stays fail-loud)", () => {
    const decision = browserGate({ available: false, detail: "missing" }, { UI_INTEL_ALLOW_NO_BROWSER: "true" });
    expect(decision.action).toBe("fail");
  });

  it("the real Playwright probe launches Chromium in this environment when a browser is present", async (ctx: TestContext) => {
    const gate = browserGate(await probeChromium());
    if (gate.action !== "run") {
      // eslint-disable-next-line no-console
      console.warn(`[legacy-api] probe sanity test SKIPPED: ${gate.message}`);
      ctx.skip();
    }
    expect(gate.action).toBe("run");
  });
});
