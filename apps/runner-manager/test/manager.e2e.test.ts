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

    pool = runPool(2, {
      managerUrl,
      token: MANAGER_TOKEN,
      appUrl: APP_URL,
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
    const results = run.results as Array<{ scenarioId: string; status: string; captureId?: string; error?: string }>;
    expect(results).toHaveLength(SCENARIOS.length);
    for (const scenarioId of SCENARIOS) {
      const entry = results.find((r) => r.scenarioId === scenarioId);
      expect(entry, `missing result for ${scenarioId}`).toBeDefined();
      expect(entry?.status).toBe("captured");
      expect(entry?.captureId).toMatch(/^capture_/);
      console.log(`  ${scenarioId}: captured as ${entry?.captureId}`);
    }
  }, 200_000);
});
