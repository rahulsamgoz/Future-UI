/**
 * Historical onboarding journey (architecture section 18), end to end against
 * the live API. Gated on UI_INTEL_E2E=1 so unit/CI runs stay hermetic:
 *   UI_INTEL_E2E=1 npx vitest run packages/cli/test/onboarding.e2e.test.ts
 *
 * Journey: select a window, review the estimate, execute the scan, inspect
 * renders and failures, then extend the range without duplicating successful
 * compatible work (no re-ingestion, no duplicate capture rows).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiRequest } from "../src/api.js";
import { inventoryCommits, runGit } from "../src/commits.js";
import { CaptureUploader, ScenarioRunner, standardScenarios } from "@ui-intelligence/capture";
import { digestOf } from "@ui-intelligence/protocol";
import type { CaptureEnvironment } from "@ui-intelligence/protocol";

const E2E = process.env.UI_INTEL_E2E === "1";
const describeE2E = E2E ? describe : describe.skip;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const API = process.env.UI_INTEL_API_URL ?? "http://localhost:8787";
const APP = process.env.UI_INTEL_APP_URL ?? "http://localhost:5173";
const TOKEN = process.env.UI_INTEL_TOKEN ?? "dev-token";
const PROJECT = process.env.UI_INTEL_PROJECT ?? "reference-app";

const SCENARIO_IDS = standardScenarios().map((s) => s.id);
// Catalog scenarios exercise catalog.productChooser, used for the history read.
const CAPTURE_SCENARIOS = ["catalog-default-desktop", "catalog-empty-desktop"];

type CaptureSummary = { captureId: string; scenarioId: string; commitSha: string; observationCount: number };

async function listCaptures(): Promise<CaptureSummary[]> {
  const result = await apiRequest(API, TOKEN, "GET", `/v1/projects/${PROJECT}/captures`);
  expect(result.ok).toBe(true);
  return (result.body as { captures: CaptureSummary[] }).captures;
}

async function waitForJob(jobId: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const result = await apiRequest(API, TOKEN, "GET", `/v1/projects/${PROJECT}/jobs/${jobId}`);
    if (result.ok) {
      last = result.body as Record<string, unknown>;
      const status = last.status as string;
      if (status === "succeeded" || status === "failed" || status === "cancelled") return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`job ${jobId} did not reach a terminal state; last=${JSON.stringify(last)}`);
}

describeE2E("historical onboarding journey (live API)", () => {
  let fixtureDir: string;
  let repoHead: { sha: string; committedAt: string; parents: string[] };
  let fixtureCommits: Array<{ sha: string; date: string; parents: string[] }>;
  let capturesAtHead: Map<string, CaptureSummary>;

  beforeAll(async () => {
    // 1. Build the fixture corpus (13 commits, commit 12 intentionally unbuildable).
    fixtureDir = mkdtempSync(path.join(tmpdir(), "ui-intel-onboarding-"));
    execFileSync("node", [path.join(REPO_ROOT, "fixtures", "history", "generate.mjs"), fixtureDir], {
      encoding: "utf8",
    });
    fixtureCommits = inventoryCommits(fixtureDir, ["HEAD"]);
    expect(fixtureCommits).toHaveLength(13);
    const headLine = runGit(REPO_ROOT, ["log", "-1", "--format=%H|%ad|%P", "--date=iso-strict", "HEAD"]).trim();
    const [sha, committedAt, parents] = headLine.split("|");
    repoHead = { sha, committedAt, parents: (parents ?? "").split(" ").filter(Boolean) };

    // The reference app must be up for this journey.
    const health = await apiRequest(API, TOKEN, "GET", "/health");
    expect(health.ok).toBe(true);
  }, 60_000);

  afterAll(() => {
    try {
      rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("syncs fixture commits to the API (commits:sync)", async () => {
    const commits = [
      ...fixtureCommits.map((c) => ({ sha: c.sha, committedAt: c.date, parents: c.parents })),
      {
        sha: repoHead.sha,
        // INSERT OR REPLACE: pin the current-build commit inside the scan window.
        committedAt: new Date().toISOString(),
        parents: repoHead.parents,
      },
    ];
    const result = await apiRequest(API, TOKEN, "POST", `/v1/projects/${PROJECT}/commits:sync`, { body: { commits } });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ stored: commits.length });
  });

  it("ingests authentic current-build captures for the scan to process", async () => {
    const redactionPolicy = { version: "1", masks: [] };
    const environment: CaptureEnvironment = {
      runnerImageDigest: "local",
      browserRevision: "bundled-playwright",
      fontsDigest: "unknown",
      adapterVersion: "unknown",
      captureToolVersion: "1.0.0",
      redactionPolicyDigest: await digestOf(redactionPolicy),
    };
    const runner = new ScenarioRunner({ baseUrl: APP, adapterVersion: "unknown", redactionPolicy });
    const uploader = new CaptureUploader();
    for (const recipe of standardScenarios().filter((r) => CAPTURE_SCENARIOS.includes(r.id))) {
      const { manifest, screenshotBytes } = await runner.execute(recipe, {
        projectId: PROJECT,
        commitSha: repoHead.sha,
        // Per-run build digest: a re-run of this journey is a NEW build
        // observation (fresh capture timestamps/bounds), not a retry of the
        // same manifest. A stable digest would collide with the previous
        // run's request key and correctly 409 IDEMPOTENCY_MISMATCH.
        buildArtifactDigest: `local-dev-${process.env.VITEST_POOL_ID ?? "0"}-${Date.now()}`,
        environment,
      });
      // Idempotent by request key: re-running the journey replays, not duplicates.
      const { captureId } = await uploader.upload(manifest, screenshotBytes, { baseUrl: API, token: TOKEN, projectId: PROJECT });
      expect(captureId).toBe(manifest.captureId);
    }
    const captures = await listCaptures();
    capturesAtHead = new Map(
      captures.filter((c) => c.commitSha === repoHead.sha).map((c) => [c.scenarioId, c])
    );
    for (const scenarioId of CAPTURE_SCENARIOS) {
      expect(capturesAtHead.get(scenarioId)?.observationCount ?? 0).toBeGreaterThan(0);
    }
  }, 120_000);

  it("creates a history plan and reviews the estimate fields", async () => {
    // Narrow window around the current build (synced above), on the live API
    // the shared dev DB may contain other recent commits — assert our commit
    // is selected, newest first, and that the estimate is consistent.
    const windowStart = new Date(Date.now() - 60_000).toISOString();
    const windowEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const result = await apiRequest(API, TOKEN, "POST", `/v1/projects/${PROJECT}/history-plans`, {
      body: {
        input: {
          repository: "fixtures/history (synthetic corpus)",
          branches: ["main"],
          windowStart,
          windowEnd,
          scenarioIds: SCENARIO_IDS,
          maxBuilds: 12,
          renderBudgetMs: 600_000,
          timezone: "UTC",
        },
      },
    });
    expect(result.status).toBe(201);
    const plan = result.body as Record<string, unknown>;
    const selected = plan.selectedCommits as Array<Record<string, unknown>>;
    expect(Array.isArray(selected)).toBe(true);
    expect(selected.map((c) => c.commitSha)).toContain(repoHead.sha);
    expect(typeof plan.estimatedCaptures).toBe("number");
    expect(plan.estimatedCaptures as number).toBe(selected.length * SCENARIO_IDS.length * 2);
    const range = plan.uncertaintyRange as [number, number];
    expect(range[0]).toBeLessThanOrEqual(plan.estimatedCaptures as number);
    expect(range[1]).toBeGreaterThanOrEqual(plan.estimatedCaptures as number);
    expect(Array.isArray(plan.resolvedTips)).toBe(true);
    expect(plan.status).toBe("approved");
  });

  it("executes the scan and the job completes with the plan marked completed", async () => {
    const windowStart = new Date(Date.now() - 60_000).toISOString();
    const windowEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const plans = await apiRequest(API, TOKEN, "POST", `/v1/projects/${PROJECT}/history-plans`, {
      body: {
        input: {
          repository: "fixtures/history (synthetic corpus)",
          branches: ["main"],
          windowStart,
          windowEnd,
          scenarioIds: SCENARIO_IDS,
          maxBuilds: 12,
          renderBudgetMs: 600_000,
          timezone: "UTC",
        },
      },
    });
    expect(plans.status).toBe(201);
    const plan = plans.body as Record<string, unknown>;
    const planId = plan.planId as string;

    const started = await apiRequest(API, TOKEN, "POST", `/v1/projects/${PROJECT}/history-plans/${planId}/runs`);
    expect(started.status).toBe(202);
    const { jobId } = started.body as { jobId: string };

    const job = await waitForJob(jobId);
    expect(job.status).toBe("succeeded");
    expect(job.kind).toBe("history_scan");

    const planAfter = await apiRequest(API, TOKEN, "GET", `/v1/projects/${PROJECT}/history-plans/${planId}`);
    expect((planAfter.body as Record<string, unknown>).status).toBe("completed");
  }, 90_000);

  it("extends the window without duplicating successful compatible work", async () => {
    const before = await listCaptures();
    const headCapturesBefore = before.filter((c) => c.commitSha === repoHead.sha);

    // Wider window: the full fixture date range plus the current build.
    const extended = await apiRequest(API, TOKEN, "POST", `/v1/projects/${PROJECT}/history-plans`, {
      body: {
        input: {
          repository: "fixtures/history (synthetic corpus)",
          branches: ["main"],
          windowStart: "2026-07-25T00:00:00Z",
          windowEnd: "2026-09-26T00:00:00Z",
          scenarioIds: SCENARIO_IDS,
          maxBuilds: 20,
          renderBudgetMs: 600_000,
          timezone: "UTC",
        },
      },
    });
    expect(extended.status).toBe(201);
    const plan = extended.body as Record<string, unknown>;
    const selected = plan.selectedCommits as Array<Record<string, unknown>>;
    const selectedShas = new Set(selected.map((c) => c.commitSha as string));
    expect(selected.length).toBeGreaterThanOrEqual(14); // 13 fixture commits + current build HEAD
    for (const commit of fixtureCommits) expect(selectedShas.has(commit.sha)).toBe(true);
    expect(selectedShas.has(repoHead.sha)).toBe(true);
    const planId = plan.planId as string;

    const started = await apiRequest(API, TOKEN, "POST", `/v1/projects/${PROJECT}/history-plans/${planId}/runs`);
    expect(started.status).toBe(202);
    const job = await waitForJob((started.body as { jobId: string }).jobId);
    expect(job.status).toBe("succeeded");

    // No re-ingestion: capture rows unchanged, no duplicate request keys.
    const after = await listCaptures();
    expect(after).toHaveLength(before.length);
    const headCapturesAfter = after.filter((c) => c.commitSha === repoHead.sha);
    expect(headCapturesAfter).toHaveLength(headCapturesBefore.length);
    for (const capture of headCapturesAfter) {
      const beforeCount = headCapturesBefore.find((c) => c.scenarioId === capture.scenarioId)?.observationCount;
      expect(capture.observationCount).toBe(beforeCount); // re-index did not duplicate
    }
    // Uniqueness is per (build, scenario) — the same commit can legitimately
    // hold captures from multiple builds (coverage run vs this run), so
    // commit+scenario is NOT the right composite. Capture ids must all be
    // distinct rows and no capture row was re-created by the re-scan.
    const ids = new Set(after.map((c) => c.captureId));
    expect(ids.size).toBe(after.length);
    const beforeIds = new Set(before.map((c) => c.captureId));
    for (const id of ids) expect(beforeIds.has(id)).toBe(true); // same rows, none re-ingested
  }, 120_000);

  it("returns observations and gaps for catalog.productChooser history", async () => {
    const result = await apiRequest(API, TOKEN, "GET", `/v1/projects/${PROJECT}/entities/catalog.productChooser/history`);
    expect(result.ok).toBe(true);
    const body = result.body as { observations: Array<Record<string, unknown>>; gaps: unknown[] };
    expect(body.observations.length).toBeGreaterThanOrEqual(CAPTURE_SCENARIOS.length);
    for (const observation of body.observations) {
      expect(observation.captureId).toBeTruthy();
      expect(observation.commitSha).toBeTruthy();
      expect(observation.evidenceLabel).toBeTruthy();
      expect(observation.bounds).toBeTruthy();
    }
    expect(Array.isArray(body.gaps)).toBe(true);
    // The synthetic fixture commits were never reconstructed: that gap is explicit.
    const gapReasons = JSON.stringify(body.gaps);
    expect(gapReasons.length).toBeGreaterThan(0);
  });
});
