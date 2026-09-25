/**
 * Managed runner journey (R2 stream D), end to end with the REAL capture
 * path. Gated on UI_INTEL_E2E=1 so unit/CI runs stay hermetic:
 *   UI_INTEL_E2E=1 npx vitest run apps/runner-manager/test/manager.e2e.test.ts
 *
 * Requires: the reference app on :5173 (or UI_INTEL_APP_URL) and the built
 * capture-runner entrypoint. A runner-manager is started in-process on an
 * ephemeral port; runPool(2) spawns two capture-runner child processes that
 * claim the run and execute ScenarioRunner against the app. The run must
 * reach succeeded with a captureId per scenario.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrate, openDb, type Db } from "../src/db.js";
import { buildManager } from "../src/server.js";
import { runPool, type PoolHandle } from "../src/pool.js";

const E2E = process.env.UI_INTEL_E2E === "1";
const describeE2E = E2E ? describe : describe.skip;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP_URL = process.env.UI_INTEL_APP_URL ?? "http://localhost:5173";
const MANAGER_TOKEN = process.env.UI_INTEL_RUNNER_TOKEN ?? "dev-token";
const RUNNER_ENTRY = path.join(REPO_ROOT, "apps", "capture-runner", "dist", "main.js");
const SCENARIOS = ["catalog-default-desktop", "catalog-empty-desktop"];

let appAvailable = false;

async function managerFetch(method: string, apiPath: string, body?: unknown, token = MANAGER_TOKEN) {
  const response = await fetch(`${process.env.MANAGER_URL ?? ""}${apiPath}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, ok: response.ok, body: text ? JSON.parse(text) : null };
}

describeE2E("managed runner pool journey (live app + real capture path)", () => {
  let dir: string;
  let db: Db;
  let app: FastifyInstance;
  let pool: PoolHandle | null = null;
  let managerUrl: string;

  beforeAll(async () => {
    // Clear skip reason when prerequisites are missing.
    try {
      const probe = await fetch(APP_URL, { signal: AbortSignal.timeout(3000) });
      appAvailable = probe.ok;
    } catch {
      appAvailable = false;
    }
    if (!appAvailable) {
      console.warn(`[skip reason] reference app not reachable at ${APP_URL}; start it with 'npm run dev:reference-app' and re-run with UI_INTEL_E2E=1`);
      return;
    }
    if (!existsSync(RUNNER_ENTRY)) {
      console.warn(`[skip reason] capture-runner entrypoint missing at ${RUNNER_ENTRY}; run 'npx tsc -b apps/capture-runner' first`);
      return;
    }

    dir = mkdtempSync(path.join(tmpdir(), "runner-manager-e2e-"));
    db = openDb(path.join(dir, "runner.sqlite"));
    migrate(db);
    app = buildManager({ db, token: MANAGER_TOKEN }); // real executor: capture-runner children do the capturing
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.MANAGER_URL = `http://127.0.0.1:${port}`;
    managerUrl = process.env.MANAGER_URL;

    // Durable publication (audit fix): the history API travels with the pool
    // explicitly, so every child publishes and the run result only reports
    // "captured" after publication is verified.
    const historyApi = { baseUrl: HISTORY_API_URL, token: HISTORY_TOKEN, projectId: HISTORY_PROJECT };
    process.env.HISTORY_API_URL = HISTORY_API_URL;
    process.env.HISTORY_API_TOKEN = HISTORY_TOKEN;
    process.env.HISTORY_API_PROJECT = HISTORY_PROJECT;

    pool = runPool(2, {
      managerUrl,
      token: MANAGER_TOKEN,
      appUrl: APP_URL,
      historyApi,
      runnerEntry: RUNNER_ENTRY,
    });
  }, 30_000);

  afterAll(async () => {
    await pool?.stop();
    if (app) await app.close();
    db?.close();
    delete process.env.MANAGER_URL;
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("executes a submitted run with a pool of 2 via the real capture path", async () => {
    if (!appAvailable) {
      console.warn("[skip reason] reference app not reachable; skipping run execution");
      return;
    }
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim();

    const created = await managerFetch("POST", "/v1/runs", {
      projectId: "proj_reference_app",
      repoUrl: "https://github.com/rahulsamgoz/Future-UI",
      commitSha,
      scenarios: SCENARIOS,
    });
    expect(created.status).toBe(202);
    const { runId } = created.body as { runId: string };
    console.log(`submitted run ${runId} for ${commitSha} with ${SCENARIOS.length} scenarios`);

    const deadline = Date.now() + 180_000;
    let run: Record<string, unknown> = {};
    for (;;) {
      const poll = await managerFetch("GET", `/v1/runs/${runId}`);
      expect(poll.ok).toBe(true);
      run = poll.body as Record<string, unknown>;
      const status = run.status as string;
      if (status === "succeeded" || status === "failed") break;
      if (Date.now() > deadline) throw new Error(`run ${runId} did not finish; last=${JSON.stringify(run)}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    expect(run.status).toBe("succeeded");
    const results = run.results as Array<{ scenarioId: string; status: string; captureId?: string; artifactId?: string; error?: string }>;
    expect(results).toHaveLength(SCENARIOS.length);
    const capturedIds: string[] = [];
    for (const scenarioId of SCENARIOS) {
      const entry = results.find((r) => r.scenarioId === scenarioId);
      expect(entry, `missing result for ${scenarioId}`).toBeDefined();
      // "captured" now means durably published + verified (see the executor):
      // without a reachable history API the scenario would honestly fail here.
      expect(entry?.status).toBe("captured");
      expect(entry?.captureId).toMatch(/^capture_/);
      capturedIds.push(entry!.captureId!);
      console.log(`  ${scenarioId}: captured as ${entry?.captureId} (artifact ${entry?.artifactId})`);
    }

    // Publication evidence: every capture is retrievable from the history API.
    const listResponse = await fetch(
      `${HISTORY_API_URL.replace(/\/$/, "")}/v1/projects/${HISTORY_PROJECT}/captures`,
      { headers: { authorization: `Bearer ${HISTORY_TOKEN}` } },
    );
    expect(listResponse.ok).toBe(true);
    const { captures } = (await listResponse.json()) as { captures: Array<{ captureId: string }> };
    for (const captureId of capturedIds) {
      expect(captures.find((c) => c.captureId === captureId), `capture ${captureId} missing from history API`).toBeDefined();
    }
  }, 200_000);
});

/**
 * Historical reconstruction through the managed path (audit P1: the scan path
 * must actually reconstruct, and executors must durably publish). Gated on
 * UI_INTEL_E2E=1 and a reachable history API (HISTORY_API_URL, default the
 * dev API on :8787). The reference app is NOT needed: the runnable fixture
 * corpus is reconstructed from git (worktree + static serve) and captured
 * through the real capture path, with every capture durably published and
 * verified before the scenario counts as captured.
 */
const HISTORY_API_URL = process.env.HISTORY_API_URL ?? "http://localhost:8787";
const HISTORY_TOKEN = process.env.HISTORY_API_TOKEN ?? MANAGER_TOKEN;
const HISTORY_PROJECT = process.env.HISTORY_API_PROJECT ?? "proj_reference_app";

describeE2E("managed historical reconstruction (real publication)", () => {
  let corpusDir = "";
  let historyReachable = false;

  beforeAll(async () => {
    try {
      const health = await fetch(`${HISTORY_API_URL.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(3000) });
      historyReachable = health.ok;
    } catch {
      historyReachable = false;
    }
    if (!historyReachable) {
      console.warn(`[skip reason] history API not reachable at ${HISTORY_API_URL}; start the dev API and re-run with UI_INTEL_E2E=1`);
      return;
    }
    corpusDir = mkdtempSync(path.join(tmpdir(), "history-recon-e2e-"));
    execFileSync("node", [path.join(REPO_ROOT, "fixtures", "history", "generate.mjs"), corpusDir], { encoding: "utf8" });
  });

  afterAll(() => {
    if (corpusDir) {
      try {
        rmSync(corpusDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("reconstructs 2 buildable commits x 2 scenarios and verifies publication in the history API", async () => {
    if (!historyReachable || !corpusDir) {
      console.warn("[skip reason] history API not reachable; skipping reconstruction run");
      return;
    }
    const { reconstructCommit } = await import("@ui-intelligence/capture");
    const shas = execFileSync("git", ["-C", corpusDir, "log", "--reverse", "--format=%H"], { encoding: "utf8" })
      .trim()
      .split("\n");
    const scenarios = ["catalog-default-desktop", "catalog-default-mobile"];

    // Commit 1 (initial carousel) and commit 8 (split: chooser + sort control).
    const capturedIds: string[] = [];
    for (const index of [0, 7]) {
      const result = await reconstructCommit({
        repoDir: corpusDir,
        commitSha: shas[index]!,
        scenarios,
        api: { baseUrl: HISTORY_API_URL, token: HISTORY_TOKEN, projectId: HISTORY_PROJECT },
        onLog: (message) => console.log(`  ${message}`),
      });
      for (const scenario of result.scenarios) {
        expect(scenario.outcome, `${scenario.scenarioId} @ commit ${index + 1}: ${scenario.error ?? ""}`).toBe("captured");
        expect(scenario.captureId).toMatch(/^capture_/);
        expect(scenario.occurrenceCount ?? 0).toBeGreaterThan(0);
        capturedIds.push(scenario.captureId!);
      }
    }

    // Durable publication: every capture is retrievable from the history API
    // (GET /captures lists it, GET /captures/:id returns its manifest).
    const listResponse = await fetch(
      `${HISTORY_API_URL.replace(/\/$/, "")}/v1/projects/${HISTORY_PROJECT}/captures`,
      { headers: { authorization: `Bearer ${HISTORY_TOKEN}` } },
    );
    expect(listResponse.ok).toBe(true);
    const { captures } = (await listResponse.json()) as { captures: Array<{ captureId: string; commitSha: string }> };
    for (const captureId of capturedIds) {
      const stored = captures.find((c) => c.captureId === captureId);
      expect(stored, `capture ${captureId} missing from history API`).toBeDefined();
      const detail = await fetch(
        `${HISTORY_API_URL.replace(/\/$/, "")}/v1/projects/${HISTORY_PROJECT}/captures/${captureId}`,
        { headers: { authorization: `Bearer ${HISTORY_TOKEN}` } },
      );
      expect(detail.ok).toBe(true);
    }
    console.log(`reconstructed captures published and verified: ${capturedIds.join(", ")}`);
  }, 300_000);

  it("records the intentionally unbuildable commit as an expected failure", async () => {
    if (!historyReachable || !corpusDir) {
      console.warn("[skip reason] history API not reachable; skipping unbuildable run");
      return;
    }
    const { reconstructCommit } = await import("@ui-intelligence/capture");
    const shas = execFileSync("git", ["-C", corpusDir, "log", "--reverse", "--format=%H"], { encoding: "utf8" })
      .trim()
      .split("\n");
    const result = await reconstructCommit({
      repoDir: corpusDir,
      commitSha: shas[11]!, // commit 12: INTENTIONALLY_UNBUILDABLE
      scenarios: ["catalog-default-desktop"],
      api: { baseUrl: HISTORY_API_URL, token: HISTORY_TOKEN, projectId: HISTORY_PROJECT },
      onLog: (message) => console.log(`  ${message}`),
    });
    expect(result.intentionallyUnbuildable).toBe(true);
    for (const scenario of result.scenarios) {
      expect(scenario.outcome).toBe("expected_failure");
      expect(scenario.error).toBeTruthy();
      expect(scenario.captureId).toBeUndefined();
    }
    console.log(`unbuildable commit recorded as expected_failure for ${result.scenarios.length} scenario(s)`);
  }, 120_000);
});
