/**
 * Regression test for audit finding 3a: a history plan's fixtureRepo must
 * survive the WHOLE normal plan path:
 *   1. POST /v1/projects/:p/history-plans persists fixtureRepo in the plan
 *      input (validated: existing directory inside the configured reconstruct
 *      roots — arbitrary absolute paths are rejected);
 *   2. POST .../history-plans/:id/runs copies it into the job payload;
 *   3. the history_scan worker (real handleHistoryScan) then actually
 *      RECONSTRUCTS the selected commit from the fixture corpus and published,
 *      verified captures exist for that commit sha.
 *
 * Uses a fresh temp DB via buildTestApp and the REAL fixture generator.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserGate, probeChromium } from "@ui-intelligence/capture";
import { buildTestApp, post, type FastifyInstanceLike } from "./helpers.js";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const PROJECT = "proj_reference_app";

// Browser gate (closure review): the end-to-end reconstruction test launches
// real Chromium via the worker path. Fail loudly when it is missing (never a
// silent skip); UI_INTEL_ALLOW_NO_BROWSER=1 opts out explicitly.
const browserDecision = browserGate(await probeChromium());
if (browserDecision.action === "fail") throw new Error(browserDecision.message);
const browserIt = it.skipIf(browserDecision.action === "skip");

describe("history plan fixtureRepo end to end (audit finding 3a)", () => {
  let dir: string;
  let corpusDir: string;
  let app: FastifyInstanceLike;
  let baseUrl = "";

  const input = (overrides: Record<string, unknown> = {}) => ({
    repository: "fixture-corpus",
    branches: ["main"],
    windowStart: "2026-07-01T00:00:00.000Z",
    windowEnd: "2026-10-01T00:00:00.000Z",
    scenarioIds: [],
    maxBuilds: 13,
    renderBudgetMs: 60000,
    timezone: "UTC",
    ...overrides,
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ui-intel-plan-fixture-"));
    corpusDir = join(dir, "fixture-corpus");
    execFileSync("node", [join(REPO_ROOT, "fixtures", "history", "generate.mjs"), corpusDir], { encoding: "utf8" });
    const built = await buildTestApp(dir);
    app = built.app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("persists fixtureRepo in the plan input and copies it into the run job payload", async () => {
    const plan = await post(app, `/v1/projects/${PROJECT}/history-plans`, { input: input({ fixtureRepo: corpusDir }) });
    expect(plan.statusCode).toBe(201);
    const planBody = JSON.parse(plan.body);
    // Persisted in the plan input JSON (not stripped by the schema).
    expect(planBody.input.fixtureRepo).toBe(corpusDir);

    const run = await post(app, `/v1/projects/${PROJECT}/history-plans/${planBody.planId}/runs`, {});
    expect(run.statusCode).toBe(202);
    const { jobId } = JSON.parse(run.body) as { jobId: string };
    const jobRow = app.db.prepare("SELECT payload_json FROM jobs WHERE id = ?").get(jobId) as {
      payload_json: string;
    };
    const payload = JSON.parse(jobRow.payload_json) as { fixtureRepo?: string };
    expect(payload.fixtureRepo).toBe(corpusDir);
  });

  it("rejects fixtureRepo paths outside the reconstruct roots, nonexistent paths, and remote URLs", async () => {
    for (const fixtureRepo of ["/usr", "/etc", join(tmpdir(), "ui-intel-nonexistent-zz"), "https://github.com/example/repo"]) {
      const response = await post(app, `/v1/projects/${PROJECT}/history-plans`, { input: input({ fixtureRepo }) });
      expect(response.statusCode, `fixtureRepo ${fixtureRepo}`).toBe(422);
      expect(JSON.parse(response.body).error.code).toBe("SCHEMA_INVALID");
    }
    // A plan without fixtureRepo is still accepted.
    const without = await post(app, `/v1/projects/${PROJECT}/history-plans`, { input: input() });
    expect(without.statusCode).toBe(201);
  });

  it("rejects unknown scenarioIds with 422 and defaults empty to all standard scenarios", async () => {
    const unknown = await post(app, `/v1/projects/${PROJECT}/history-plans`, {
      input: input({ scenarioIds: ["catalog-desktop-signed-in"] }),
    });
    expect(unknown.statusCode).toBe(422);
    expect(JSON.parse(unknown.body).error.code).toBe("SCHEMA_INVALID");
    expect(JSON.parse(unknown.body).error.message).toContain("unknown scenarioIds");

    // Empty scenarioIds defaults to all 12 standard scenarios.
    const all = await post(app, `/v1/projects/${PROJECT}/history-plans`, { input: input({ scenarioIds: [] }) });
    expect(all.statusCode).toBe(201);
    const allBody = JSON.parse(all.body);
    expect(allBody.input.scenarioIds.length).toBe(12);
    // One capture per (commit, recipe) — ids are viewport-specific (closure-3 audit P3).
    expect(allBody.estimatedCaptures).toBe(allBody.selectedCommits.length * 12);

    // Explicit subset is accepted and estimated correctly.
    const subset = await post(app, `/v1/projects/${PROJECT}/history-plans`, {
      input: input({ scenarioIds: ["catalog-default-desktop", "account-default-desktop"] }),
    });
    expect(subset.statusCode).toBe(201);
    const subsetBody = JSON.parse(subset.body);
    expect(subsetBody.input.scenarioIds).toEqual(["catalog-default-desktop", "account-default-desktop"]);
    expect(subsetBody.estimatedCaptures).toBe(subsetBody.selectedCommits.length * 2);
  });

  it("estimates count each selected viewport-specific recipe once per commit (closure-3 audit P3)", async () => {
    // Register the fixture commits so the plan actually selects one.
    const log = execFileSync("git", ["-C", corpusDir, "log", "--reverse", "--format=%H %cI"], {
      encoding: "utf8",
    }).trim();
    const commits = log.split("\n").map((line) => {
      const [sha, committedAt] = line.split(" ");
      return { sha: sha as string, committedAt: committedAt as string, parents: [] as string[] };
    });
    const sync = await post(app, `/v1/projects/${PROJECT}/commits:sync`, { commits });
    expect(sync.statusCode).toBe(200);

    // One selected recipe: exactly one capture per commit (not two — the old
    // code multiplied by a phantom per-scenario viewport count).
    const single = await post(app, `/v1/projects/${PROJECT}/history-plans`, {
      input: input({ scenarioIds: ["catalog-default-desktop"], maxBuilds: 1 }),
    });
    expect(single.statusCode).toBe(201);
    const singleBody = JSON.parse(single.body);
    expect(singleBody.estimatedCaptures).toBe(1);
    expect(singleBody.uncertaintyRange).toEqual([
      Math.round(1 * 0.7),
      Math.round(1 * 1.3),
    ]);

    // Both viewport-specific recipes of the same scenario: counted separately.
    const bothViewports = await post(app, `/v1/projects/${PROJECT}/history-plans`, {
      input: input({ scenarioIds: ["catalog-default-desktop", "catalog-default-mobile"], maxBuilds: 1 }),
    });
    expect(bothViewports.statusCode).toBe(201);
    expect(JSON.parse(bothViewports.body).estimatedCaptures).toBe(2);

    // Duplicate ids are deduplicated and counted once.
    const duplicates = await post(app, `/v1/projects/${PROJECT}/history-plans`, {
      input: input({ scenarioIds: ["catalog-default-desktop", "catalog-default-desktop"], maxBuilds: 1 }),
    });
    expect(duplicates.statusCode).toBe(201);
    const dupBody = JSON.parse(duplicates.body);
    expect(dupBody.input.scenarioIds).toEqual(["catalog-default-desktop"]);
    expect(dupBody.estimatedCaptures).toBe(1);
  });

  browserIt("reconstructs the selected commit through the real worker path (captures carry that commit sha)", { timeout: 300_000 }, async () => {
    // Register the fixture commits so the plan can select them.
    const log = execFileSync("git", ["-C", corpusDir, "log", "--reverse", "--format=%H %cI"], {
      encoding: "utf8",
    }).trim();
    const commits = log.split("\n").map((line) => {
      const [sha, committedAt] = line.split(" ");
      return { sha: sha as string, committedAt: committedAt as string, parents: [] as string[] };
    });
    const sync = await post(app, `/v1/projects/${PROJECT}/commits:sync`, { commits });
    expect(sync.statusCode).toBe(200);

    // The selected commit: latest in the window ("fix build again", buildable).
    const selectedSha = commits[commits.length - 1]!.sha;
    const plan = await post(app, `/v1/projects/${PROJECT}/history-plans`, {
      input: input({ fixtureRepo: corpusDir, maxBuilds: 1 }),
    });
    expect(plan.statusCode).toBe(201);
    const { planId } = JSON.parse(plan.body) as { planId: string };

    const run = await post(app, `/v1/projects/${PROJECT}/history-plans/${planId}/runs`, {});
    expect(run.statusCode).toBe(202);
    const { jobId } = JSON.parse(run.body) as { jobId: string };

    // Claim the job (real lease), then run the REAL history_scan handler.
    const claim = JSON.parse(
      (await post(app, `/v1/projects/${PROJECT}/jobs/${jobId}/claim`, { workerId: "w-regression" })).body,
    ) as { leaseToken: string };
    const { handleHistoryScan } = await import("../../index-worker/src/worker.js");
    await handleHistoryScan(
      app.db as never,
      {
        jobId,
        projectId: PROJECT,
        kind: "history_scan",
        stage: "planning",
        payload: { planId, projectId: PROJECT, fixtureRepo: corpusDir },
        leaseToken: claim.leaseToken,
        attempt: 1,
      },
      { api: { baseUrl, token: "dev-token", projectId: PROJECT } },
    );

    // Reconstruction actually happened: published captures exist for the
    // selected commit sha and its job succeeded.
    const list = await app.inject({
      method: "GET",
      url: `/v1/projects/${PROJECT}/captures?commit=${selectedSha}`,
      headers: { authorization: "Bearer dev-token" },
    });
    expect(list.statusCode).toBe(200);
    const { captures } = JSON.parse(list.body) as { captures: Array<{ captureId: string; commitSha: string; scenarioId: string }> };
    expect(captures.length).toBeGreaterThan(0);
    for (const capture of captures) {
      expect(capture.commitSha).toBe(selectedSha);
    }
    const scenarios = new Set(captures.map((c) => c.scenarioId));
    expect(scenarios.has("catalog-default-desktop")).toBe(true);
    expect(scenarios.has("account-default-desktop")).toBe(true);

    const jobRow = app.db.prepare("SELECT status, payload_json FROM jobs WHERE id = ?").get(jobId) as {
      status: string;
      payload_json: string;
    };
    expect(jobRow.status).toBe("succeeded");
    const result = JSON.parse(jobRow.payload_json) as { result?: { captured?: number } };
    expect(result.result?.captured).toBe(1);
  }, 300_000);
});
