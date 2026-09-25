/**
 * Managed executor commit verification (audit finding 3d):
 * - a LOCAL repoUrl triggers REAL commit reconstruction (captures carry that
 *   commit sha and provenance mode is "reconstructed");
 * - an absent/remote repoUrl captures APP_URL with an honest
 *   {mode: "live-app", note: "commit binding asserted, not verified"} and a
 *   buildArtifactDigest derived from the served page's first response HTML;
 * - without a history API nothing is reported as captured.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CaptureManifest } from "@ui-intelligence/protocol";
import { browserGate, digestServedPage, probeChromium } from "@ui-intelligence/capture";
import { defaultExecutor } from "../src/executor.js";
import { buildTestApp, type FastifyInstanceLike } from "../../api/test/helpers.js";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const PROJECT = "proj_reference_app";

// Browser gate (closure review): both describes execute the REAL capture
// path, so they need Playwright's Chromium. Fail loudly when it is missing
// (never a silent skip); UI_INTEL_ALLOW_NO_BROWSER=1 opts out explicitly.
const browserDecision = browserGate(await probeChromium());
if (browserDecision.action === "fail") throw new Error(browserDecision.message);
const browserDescribe = describe.skipIf(browserDecision.action === "skip");

browserDescribe("managed executor commit verification", () => {
  describe("local repoUrl reconstructs the actual commit (real capture path)", () => {
    let dir: string;
    let corpusDir: string;
    let app: FastifyInstanceLike;
    let baseUrl = "";
    let commitSha = "";

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "ui-intel-executor-"));
      corpusDir = join(dir, "fixture-corpus");
      execFileSync("node", [join(REPO_ROOT, "fixtures", "history", "generate.mjs"), corpusDir], { encoding: "utf8" });
      commitSha = execFileSync("git", ["-C", corpusDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
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

    it("takes the reconstruction path and publishes captures bound to the requested commit sha", { timeout: 180_000 }, async () => {
      const execution = await defaultExecutor({
        runId: "run_reconstruction",
        projectId: PROJECT,
        repoUrl: corpusDir, // LOCAL path -> reconstruction
        commitSha,
        scenarios: ["catalog-default-desktop"],
        appUrl: "http://localhost:5173", // ignored on the reconstruction path
        historyApi: { baseUrl, token: "dev-token", projectId: PROJECT },
      });

      expect(execution.provenance?.mode).toBe("reconstructed");
      expect(execution.provenance?.commitSha).toBe(commitSha);
      expect(execution.results).toHaveLength(1);
      expect(execution.results[0]?.status).toBe("captured");
      expect(execution.results[0]?.captureId).toMatch(/^capture_/);

      // The capture is bound to the reconstructed commit sha in the API.
      const list = await app.inject({
        method: "GET",
        url: `/v1/projects/${PROJECT}/captures?commit=${commitSha}`,
        headers: { authorization: "Bearer dev-token" },
      });
      expect(list.statusCode).toBe(200);
      const { captures } = JSON.parse(list.body) as { captures: Array<{ captureId: string; commitSha: string }> };
      expect(captures.some((c) => c.captureId === execution.results[0]?.captureId)).toBe(true);
    }, 180_000);
  });

  describe("remote/absent repoUrl: live-app capture with honest provenance", () => {
    const API = { baseUrl: "http://history-api.local", token: "test-token", projectId: PROJECT };

    function fakeManifest(scenarioId: string, captureId: string, buildArtifactDigest: string): CaptureManifest {
      return {
        captureId,
        spec: {
          protocolVersion: 1,
          projectId: PROJECT,
          commitSha: "c0ffee0000000000000000000000000000000000",
          buildArtifactDigest,
          scenario: {
            id: scenarioId,
            recipeDigest: "rd",
            route: "/",
            fixtureDigest: "fd",
            role: "visitor",
            featureFlagsDigest: "ff",
            viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
            locale: "en-US",
            timeZone: "UTC",
            colorScheme: "light",
            reducedMotion: false,
          },
          environment: {
            runnerImageDigest: "local",
            browserRevision: "bundled-playwright",
            fontsDigest: "unknown",
            adapterVersion: "unknown",
            captureToolVersion: "1.0.0",
            redactionPolicyDigest: "rpd",
          },
        },
        capturedAt: new Date().toISOString(),
        gitParents: [],
        observations: [
          {
            occurrenceId: "occ_1",
            captureId,
            explicitAnchor: "catalog.productChooser",
            bounds: [{ x: 0, y: 0, width: 10, height: 10 }],
            coordinateSpace: "document-css-pixels",
            sourceLinks: [],
            completeness: "complete-for-scenario",
            limitations: [],
          },
        ],
        artifacts: [
          { artifactId: `artifact_${captureId}`, kind: "screenshot-png", digest: "abc123", byteSize: 4, mimeType: "image/png" },
        ],
        buildOutcome: "succeeded",
        redactionMasks: [],
        scrollOffsets: { x: 0, y: 0 },
        idempotencyKey: `key_${captureId}`,
      };
    }

    function stubDeps(appHtml: string) {
      const runner = {
        execute: vi.fn(async (recipe: { id: string }, spec: { buildArtifactDigest: string }) => ({
          manifest: fakeManifest(recipe.id, `capture_${recipe.id}`, spec.buildArtifactDigest),
          screenshotBytes: new Uint8Array([1, 2, 3, 4]),
        })),
      };
      const uploader = { upload: vi.fn(async (manifest: CaptureManifest) => ({ captureId: manifest.captureId })) };
      const fetch = vi.fn(async (url: string | URL) => {
        const href = url.toString();
        if (href.startsWith("http://app.local")) return new Response(appHtml, { status: 200 });
        if (href.includes("/captures/")) {
          return new Response(JSON.stringify({ manifest: { observations: [{}] } }), { status: 200 });
        }
        if (href.includes("/raw")) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
        return new Response("not found", { status: 404 });
      });
      return { runner, uploader, fetch };
    }

    it("with NO repoUrl: captures APP_URL, digests the served HTML, and records the honest provenance note", async () => {
      const appHtml = "<html><body>live app v7</body></html>";
      const deps = stubDeps(appHtml);

      const execution = await defaultExecutor(
        {
          runId: "run_live",
          projectId: PROJECT,
          repoUrl: "", // absent
          commitSha: "c0ffee0000000000000000000000000000000000",
          scenarios: ["catalog-default-desktop"],
          appUrl: "http://app.local",
          historyApi: API,
        },
        deps,
      );

      expect(execution.provenance?.mode).toBe("live-app");
      expect(execution.provenance?.note).toBe("commit binding asserted, not verified — remote/absent repoUrl");
      expect(execution.results[0]?.status).toBe("captured");
      // The build digest is the hash of the served page's first response HTML.
      const spec = deps.runner.execute.mock.calls[0]?.[1] as { buildArtifactDigest: string };
      expect(spec.buildArtifactDigest).toBe(await digestServedPage("http://app.local", deps.fetch));
    });

    it("with a REMOTE repoUrl: same honest live-app provenance", async () => {
      const deps = stubDeps("<html>live app v7</html>");
      const execution = await defaultExecutor(
        {
          runId: "run_remote",
          projectId: PROJECT,
          repoUrl: "https://github.com/example/repo",
          commitSha: "c0ffee0000000000000000000000000000000000",
          scenarios: ["catalog-default-desktop"],
          appUrl: "http://app.local",
          historyApi: API,
        },
        deps,
      );
      expect(execution.provenance?.mode).toBe("live-app");
      expect(execution.provenance?.note).toContain("asserted, not verified");
      expect(execution.results[0]?.status).toBe("captured");
    });

    it("local repoUrl without a history API: nothing is reported as captured", async () => {
      const corpusDir = mkdtempSync(join(tmpdir(), "ui-intel-executor-noapi-"));
      try {
        execFileSync("node", [join(REPO_ROOT, "fixtures", "history", "generate.mjs"), corpusDir], { encoding: "utf8" });
        const commitSha = execFileSync("git", ["-C", corpusDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        const execution = await defaultExecutor({
          runId: "run_noapi",
          projectId: PROJECT,
          repoUrl: corpusDir,
          commitSha,
          scenarios: ["catalog-default-desktop"],
          appUrl: "http://localhost:5173",
          historyApi: undefined,
        });
        expect(execution.provenance?.mode).toBe("reconstructed");
        expect(execution.results[0]?.status).toBe("failed");
        expect(execution.results[0]?.error).toContain("history API not configured");
      } finally {
        rmSync(corpusDir, { recursive: true, force: true });
      }
    });
  });
});
