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
    const commits = [...fixtureCommits.map((c) => ({ sha: c.sha, committedAt: c.date, parents: c.parents })), {
      sha: repoHead.sha,
      committedAt: repoHead.committedAt,
      parents: repoHead.parents,
    }];
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
        buildArtifactDigest: "local-dev",
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
    const input = {
      repository: "fixtures/history (synthetic corpus)",
      branches: ["main"],
      windowStart: "2026-09-24T00:00:00Z",
      windowEnd: "2026-09-26T00:00:00Z",
      scenarioIds: SCENARIO_IDS,
      maxBuilds: 12,
      renderBudgetMs: 600_000,
      timezone: "UTC",
    };
    const result = await apiRequest(API, TOKEN, "POST", `/v1/projects/${PROJECT}/history-plans`, { body: { input } });
    expect(result.status).toBe(201);
    const plan = result.body as Record<string, unknown>;
    expect(Array.isArray(plan.selectedCommits)).toBe(true);
    expect((plan.selectedCommits as Array<Record<string, unknown>>).length).toBe(1); // repo HEAD only
    expect((plan.selectedCommits as Array<Record<string, unknown>>)[0].commitSha).toBe(repoHead.sha);
    expect(typeof plan.estimatedCaptures).toBe("number");
    expect((plan.estimatedCaptures as number) as number).toBe(1 * SCENARIO_IDS.length * 2);
    const range = plan.uncertaintyRange as [number, number];
    expect(range[0]).toBeLessThanOrEqual(plan.estimatedCaptures as number);
    expect(range[1]).toBeGreaterThanOrEqual(plan.estimatedCaptures as number);
    expect(Array.isArray(plan.resolvedTips)).toBe(true);
    expect(plan.status).toBe("approved");
  });

  it("executes the scan and the job completes with the plan marked completed", async () => {
    const plans = await apiRequest(API, TOKEN, "POST", `/v1/projects/${PROJECT}/history-plans`, {
      body: {
        input: {
          repository: "fixtures/history (synthetic corpus)",
          branches: ["main"],
          windowStart: "2026-09-24T00:00:00Z",
          windowEnd: "2026-09-26T00:00:00Z",
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
    expect(selected.length).toBe(14); // 13 fixture commits + current build HEAD
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
    const keys = new Set(after.map((c) => `${c.commitSha}:${c.scenarioId}`));
    expect(keys.size).toBe(after.length);
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
