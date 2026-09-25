/**
 * Durable publication in the managed executor (audit P1: "managed executors
 * don't durably publish"). With an injected runner + uploader: every executed
 * capture is uploaded once and verified before the scenario is reported as
 * captured with the REAL captureId + artifactId; an uploader failure makes
 * the scenario FAILED; no history API makes the scenario FAILED too (never a
 * captured-but-unpublished result).
 */
import { describe, expect, it, vi } from "vitest";
import type { CaptureManifest } from "@ui-intelligence/protocol";
import { executeRunScenarios } from "../src/managed.js";

const API = { baseUrl: "http://history-api.local", token: "test-token", projectId: "proj_test" };

function fakeManifest(scenarioId: string, captureId: string): CaptureManifest {
  return {
    captureId,
    spec: {
      protocolVersion: 1,
      projectId: API.projectId,
      commitSha: "c0ffee0000000000000000000000000000000000",
      buildArtifactDigest: "digest_test",
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
      {
        artifactId: `artifact_${captureId}`,
        kind: "screenshot-png",
        digest: "abc123",
        byteSize: 4,
        mimeType: "image/png",
      },
    ],
    buildOutcome: "succeeded",
    redactionMasks: [],
    scrollOffsets: { x: 0, y: 0 },
    idempotencyKey: `key_${captureId}`,
  };
}

function fakeRunner() {
  let n = 0;
  return {
    execute: vi.fn(async (recipe: { id: string }) => {
      n += 1;
      const captureId = `capture_${recipe.id}_${n}`;
      return {
        manifest: fakeManifest(recipe.id, captureId),
        screenshotBytes: new Uint8Array([1, 2, 3, 4]),
      };
    }),
  };
}

/** fetch stub that answers the two publication-verification GETs. */
function fakeVerifyFetch() {
  return vi.fn(async (url: string | URL) => {
    const href = url.toString();
    if (href.includes("/captures/")) {
      return new Response(JSON.stringify({ manifest: { observations: [{}, {}] } }), { status: 200 });
    }
    if (href.includes("/raw")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

const INPUT = {
  runId: "run_1",
  projectId: API.projectId,
  repoUrl: "https://github.com/example/repo",
  commitSha: "c0ffee0000000000000000000000000000000000",
  appUrl: "http://app.local",
  historyApi: API,
};

describe("managed executor durable publication", () => {
  it("uploads + verifies every capture and reports the real captureId + artifactId", async () => {
    const runner = fakeRunner();
    const fetch = fakeVerifyFetch();
    const uploader = { upload: vi.fn(async (manifest: CaptureManifest) => ({ captureId: manifest.captureId })) };

    const { results } = await executeRunScenarios(
      ["catalog-default-desktop", "catalog-default-mobile"],
      INPUT,
      { runner, uploader, fetch },
    );

    // The runner executed both scenarios; the uploader published both.
    expect(runner.execute).toHaveBeenCalledTimes(2);
    expect(uploader.upload).toHaveBeenCalledTimes(2);
    // Publication verification: capture GET + artifact raw GET, per scenario.
    expect(fetch.mock.calls.filter((c) => String(c[0]).includes("/captures/")).length).toBe(2);
    expect(fetch.mock.calls.filter((c) => String(c[0]).includes("/raw")).length).toBe(2);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("captured");
      expect(result.captureId).toMatch(/^capture_catalog-/);
      expect(result.artifactId).toBe(`artifact_${result.captureId}`);
      expect(result.error).toBeUndefined();
    }
  });

  it("reports the scenario failed when publication (upload) fails", async () => {
    const runner = fakeRunner();
    const fetch = fakeVerifyFetch();
    const uploader = {
      upload: vi.fn(async () => {
        throw new Error("artifact-uploads failed with status 503");
      }),
    };

    const { results } = await executeRunScenarios(["catalog-default-desktop"], INPUT, { runner, uploader, fetch });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toContain("artifact-uploads failed with status 503");
    expect(results[0]?.captureId).toBeUndefined();
    // The uploader was attempted, but nothing is reported as captured.
    expect(uploader.upload).toHaveBeenCalledTimes(1);
  });

  it("reports the scenario failed when publication cannot be verified", async () => {
    const runner = fakeRunner();
    // Verification answers 404 for the capture GET: the capture is not
    // retrievable, so publication failed.
    const fetch = vi.fn(async () => new Response("not found", { status: 404 }));
    const uploader = { upload: vi.fn(async (manifest: CaptureManifest) => ({ captureId: manifest.captureId })) };

    const { results } = await executeRunScenarios(["catalog-default-desktop"], INPUT, { runner, uploader, fetch });

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toContain("publication verification failed");
  });

  it("never reports captured without a configured history API", async () => {
    const runner = fakeRunner();
    const fetch = fakeVerifyFetch();
    const uploader = { upload: vi.fn(async () => ({ captureId: "never_used" })) };

    const { results } = await executeRunScenarios(
      ["catalog-default-desktop"],
      { ...INPUT, historyApi: undefined },
      { runner, uploader, fetch },
    );

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toContain("history API not configured");
    expect(uploader.upload).not.toHaveBeenCalled();
  });
});
