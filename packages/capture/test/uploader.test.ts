/**
 * CaptureUploader retry behavior (review capture#11): transient failures
 * (network errors, 5xx, 429) are retried with backoff; other 4xx fail
 * immediately; PUT retries reuse the same slot URL; a manifest with zero
 * artifacts fails fast before any request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureUploader } from "../src/uploader.js";
import type { CaptureManifest } from "@ui-intelligence/protocol";
import { UiIntelligenceError } from "@ui-intelligence/protocol";

const api = { baseUrl: "https://api.test", token: "tok", projectId: "proj_1" };
const bytes = new Uint8Array([1, 2, 3, 4]);

const manifest: CaptureManifest = {
  captureId: "cap_1",
  spec: {
    protocolVersion: 1,
    projectId: "proj_1",
    commitSha: "c0ffee",
    buildArtifactDigest: "sha256:build",
    scenario: {
      id: "s1",
      recipeDigest: "sha256:recipe",
      route: "/",
      fixtureDigest: "sha256:fixture",
      role: "visitor",
      featureFlagsDigest: "sha256:flags",
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      locale: "en-US",
      timeZone: "UTC",
      colorScheme: "light",
      reducedMotion: false,
    },
    environment: {
      runnerImageDigest: "local",
      browserRevision: "chromium-1",
      fontsDigest: "fonts-1",
      adapterVersion: "1.0.0",
      captureToolVersion: "1.0.0",
      redactionPolicyDigest: "placeholder",
    },
  },
  capturedAt: "2026-09-24T00:00:00.000Z",
  gitParents: [],
  observations: [],
  artifacts: [
    { artifactId: "art_shot", kind: "screenshot-png", digest: "sha256:shot", byteSize: 4, mimeType: "image/png" },
  ],
  buildOutcome: "succeeded",
  redactionMasks: [],
  scrollOffsets: { x: 0, y: 0 },
  idempotencyKey: "idem_1",
};

type RecordedCall = { url: string; init: RequestInit };

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const urlString = typeof url === "string" ? url : url.toString();
      calls.push({ url: urlString, init });
      return handler(urlString, init);
    }),
  );
  return calls;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SLOT_URL = "https://api.test/v1/projects/proj_1/artifact-uploads";
const CAPTURE_URL = "https://api.test/v1/projects/proj_1/captures";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CaptureUploader retry", () => {
  it("retries a 503 PUT on the same slot URL and succeeds", async () => {
    const calls = stubFetch((url) => {
      if (url === SLOT_URL) return jsonResponse({ slotId: "slot_1", uploadUrl: "https://api.test/slots/slot_1" }, 201);
      if (url === "https://api.test/slots/slot_1") {
        if (calls.filter((c) => c.url === url).length === 1) return new Response(null, { status: 503 });
        return new Response(null, { status: 204 });
      }
      if (url === CAPTURE_URL) return jsonResponse({ captureId: "cap_1" }, 200);
      throw new Error(`unexpected url ${url}`);
    });

    const result = await new CaptureUploader().upload(manifest, bytes, api);
    expect(result).toEqual({ captureId: "cap_1" });

    // Exactly one slot allocation, retried PUTs reuse the same URL.
    expect(calls.filter((c) => c.url === SLOT_URL)).toHaveLength(1);
    const putCalls = calls.filter((c) => c.url === "https://api.test/slots/slot_1");
    expect(putCalls).toHaveLength(2);
    for (const call of putCalls) {
      expect(call.init.method).toBe("PUT");
      expect(call.init.body).toBe(bytes);
    }
  });

  it("fails immediately on a 400 PUT without retry", async () => {
    const calls = stubFetch((url) => {
      if (url === SLOT_URL) return jsonResponse({ slotId: "slot_1", uploadUrl: "https://api.test/slots/slot_1" }, 201);
      if (url === "https://api.test/slots/slot_1") return jsonResponse({ error: "bad digest" }, 400);
      throw new Error(`unexpected url ${url}`);
    });

    await expect(new CaptureUploader().upload(manifest, bytes, api)).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringContaining("status 400"),
    });
    expect(calls.filter((c) => c.url === "https://api.test/slots/slot_1")).toHaveLength(1);
  });

  it("retries a failing slot POST but never exceeds 3 attempts", async () => {
    const calls = stubFetch((url) => {
      if (url === SLOT_URL) {
        const attempts = calls.filter((c) => c.url === url).length;
        if (attempts < 3) return new Response(null, { status: 503 });
        return jsonResponse({ slotId: "slot_1", uploadUrl: "https://api.test/slots/slot_1" }, 201);
      }
      if (url === "https://api.test/slots/slot_1") return new Response(null, { status: 204 });
      if (url === CAPTURE_URL) return jsonResponse({ captureId: "cap_1" }, 200);
      throw new Error(`unexpected url ${url}`);
    });

    const result = await new CaptureUploader().upload(manifest, bytes, api);
    expect(result).toEqual({ captureId: "cap_1" });
    const slotPosts = calls.filter((c) => c.url === SLOT_URL);
    expect(slotPosts.length).toBe(3);
    expect(slotPosts.length).toBeLessThanOrEqual(3);
    // The successful slot POST is the one whose response is used — no
    // additional allocation after success.
    expect(calls.filter((c) => c.url === "https://api.test/slots/slot_1").length).toBe(1);
  });

  it("gives up after 3 attempts when every capture POST returns 503", async () => {
    const calls = stubFetch((url) => {
      if (url === SLOT_URL) return jsonResponse({ slotId: "slot_1", uploadUrl: "https://api.test/slots/slot_1" }, 201);
      if (url === "https://api.test/slots/slot_1") return new Response(null, { status: 204 });
      if (url === CAPTURE_URL) return new Response(null, { status: 503 });
      throw new Error(`unexpected url ${url}`);
    });

    await expect(new CaptureUploader().upload(manifest, bytes, api)).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringContaining("captures failed with status 503"),
    });
    expect(calls.filter((c) => c.url === CAPTURE_URL)).toHaveLength(3);
  });

  it("fails fast when the manifest has zero artifacts", async () => {
    const calls = stubFetch(() => {
      throw new Error("fetch must not be called");
    });
    const empty: CaptureManifest = { ...manifest, artifacts: [] };
    await expect(new CaptureUploader().upload(empty, bytes, api)).rejects.toBeInstanceOf(UiIntelligenceError);
    await expect(new CaptureUploader().upload(empty, bytes, api)).rejects.toMatchObject({
      message: expect.stringContaining("no artifacts"),
    });
    expect(calls).toHaveLength(0);
  });
});
