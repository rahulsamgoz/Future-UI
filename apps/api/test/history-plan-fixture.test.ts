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
import { buildTestApp, post, type FastifyInstanceLike } from "./helpers.js";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const PROJECT = "proj_reference_app";

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

  it("reconstructs the selected commit through the real worker path (captures carry that commit sha)", { timeout: 300_000 }, async () => {
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
