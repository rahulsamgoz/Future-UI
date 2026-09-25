/**
 * GAP B acceptance test: React+Vite build adapter end-to-end.
 *
 * The fixture repo is generated per run into a temp dir by
 * fixtures/history/react-vite/generate.mjs: a minimal real React+Vite app
 * with 3 buildable commits (lockfile included, so the manifest's `npm ci`
 * works). Each commit changes visible header text so captures are
 * attributable to the commit sha. The repo carries a ui-intel.history.json
 * manifest declaring the build adapter configuration.
 *
 * This test runs the normal API plan → run → reconstruction path against the
 * fixture and asserts:
 * - the build adapter is detected and npm ci + npm run build execute;
 * - published captures are bound to the selected commit sha;
 * - capture visible text contains the per-commit header (proves BUILD ran).
 *
 * Guarded by browserGate (Chromium required) and an env flag for constrained
 * environments where npm network access is unavailable.
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
// Generated per run into a temp dir (the gitignored default location does not
// exist on fresh CI checkouts — merge-commit CI run 36198097535 failed on
// exactly that). tmpdir is inside the default UI_INTEL_RECONSTRUCT_ROOTS
// allowlist.
const FIXTURE_REPO = mkdtempSync(join(tmpdir(), "ui-intel-react-vite-fixture-"));
execFileSync("node", [join(REPO_ROOT, "fixtures", "history", "react-vite", "generate.mjs"), FIXTURE_REPO], {
  stdio: "pipe",
});

const browserDecision = browserGate(await probeChromium());
if (browserDecision.action === "fail") throw new Error(browserDecision.message);

const networkDecision = (() => {
  if (process.env.UI_INTEL_SKIP_NETWORK_TESTS === "1") {
    return { action: "skip" as const, message: "network tests skipped (UI_INTEL_SKIP_NETWORK_TESTS=1)" };
  }
  return { action: "run" as const, message: "network tests enabled" };
})();

const heavyIt = it.skipIf(browserDecision.action === "skip" || networkDecision.action === "skip");

function historyInput(overrides: Record<string, unknown> = {}) {
  return {
    repository: "react-vite-fixture",
    branches: ["main"],
    windowStart: "2026-07-01T00:00:00.000Z",
    windowEnd: "2026-10-01T00:00:00.000Z",
    scenarioIds: ["catalog-default-desktop"],
    maxBuilds: 1,
    renderBudgetMs: 120_000,
    timezone: "UTC",
    ...overrides,
  };
}

describe("history plan React+Vite build adapter (GAP B)", () => {
  let dir: string;
  let app: FastifyInstanceLike;
  let baseUrl = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ui-intel-react-vite-"));
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

  it("rejects unknown scenarioIds at plan creation", async () => {
    const response = await post(app, `/v1/projects/${PROJECT}/history-plans`, {
      input: historyInput({ scenarioIds: ["unknown-scenario"] }),
    });
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body).error.code).toBe("SCHEMA_INVALID");
  });

  heavyIt(
    "reconstructs React+Vite commit via build adapter, captures carry commit sha and per-commit text",
    { timeout: 300_000 },
    async () => {
      // Register the fixture commits.
      const log = execFileSync("git", ["-C", FIXTURE_REPO, "log", "--reverse", "--format=%H %cI"], {
        encoding: "utf8",
      }).trim();
      const commits = log.split("\n").map((line) => {
        const [sha, committedAt] = line.split(" ");
        return { sha: sha as string, committedAt: committedAt as string, parents: [] as string[] };
      });
      const selectedSha = commits[commits.length - 1]!.sha;
      const sync = await post(app, `/v1/projects/${PROJECT}/commits:sync`, { commits });
      expect(sync.statusCode).toBe(200);

      const plan = await post(app, `/v1/projects/${PROJECT}/history-plans`, {
        input: historyInput({ fixtureRepo: FIXTURE_REPO, maxBuilds: 1 }),
      });
      expect(plan.statusCode).toBe(201);
      const { planId } = JSON.parse(plan.body) as { planId: string };
      expect(JSON.parse(plan.body).input.scenarioIds).toEqual(["catalog-default-desktop"]);

      const run = await post(app, `/v1/projects/${PROJECT}/history-plans/${planId}/runs`, {});
      expect(run.statusCode).toBe(202);
      const { jobId } = JSON.parse(run.body) as { jobId: string };

      // Claim and run the REAL history_scan handler.
      const claim = JSON.parse(
        (await post(app, `/v1/projects/${PROJECT}/jobs/${jobId}/claim`, { workerId: "w-react-vite" })).body,
      ) as { leaseToken: string };
      const { handleHistoryScan } = await import("../../index-worker/src/worker.js");
      await handleHistoryScan(
        app.db as never,
        {
          jobId,
          projectId: PROJECT,
          kind: "history_scan",
          stage: "planning",
          payload: { planId, projectId: PROJECT, fixtureRepo: FIXTURE_REPO },
          leaseToken: claim.leaseToken,
          attempt: 1,
        },
        { api: { baseUrl, token: "dev-token", projectId: PROJECT } },
      );

      // Job succeeded.
      const jobRow = app.db.prepare("SELECT status, payload_json FROM jobs WHERE id = ?").get(jobId) as {
        status: string;
        payload_json: string;
      };
      expect(jobRow.status).toBe("succeeded");
      const result = JSON.parse(jobRow.payload_json) as {
        result?: { captured?: number; commits?: Array<{ commitSha: string; outcome: string }> };
      };
      expect(result.result?.captured).toBe(1);
      expect(result.result?.commits?.[0]?.outcome).toBe("captured");
      expect(result.result?.commits?.[0]?.commitSha).toBe(selectedSha);

      // Capture exists for the selected commit sha.
      const list = await app.inject({
        method: "GET",
        url: `/v1/projects/${PROJECT}/captures?commit=${selectedSha}&scenario=catalog-default-desktop`,
        headers: { authorization: "Bearer dev-token" },
      });
      expect(list.statusCode).toBe(200);
      const { captures } = JSON.parse(list.body) as {
        captures: Array<{ captureId: string; commitSha: string; manifestJson: string }>;
      };
      expect(captures.length).toBeGreaterThanOrEqual(1);
      expect(captures[0].commitSha).toBe(selectedSha);

      // Fetch the capture manifest to verify occurrences contain per-commit text.
      const captureDetail = await app.inject({
        method: "GET",
        url: `/v1/projects/${PROJECT}/captures/${captures[0].captureId}`,
        headers: { authorization: "Bearer dev-token" },
      });
      expect(captureDetail.statusCode).toBe(200);
      const { manifest } = JSON.parse(captureDetail.body) as {
        manifest: { observations: Array<{ visibleText: string }> };
      };
      const allText = manifest.observations.map((o) => o.visibleText).join(" ");
      // The latest commit header is "Step 3: update button label".
      expect(allText).toContain("Step 3");
      expect(allText).toContain("update button label");
    },
    300_000,
  );
});
