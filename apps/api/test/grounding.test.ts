/**
 * Screenshot grounding end-to-end tests (spec section 13 journey). Real PNGs
 * are generated in-test with pngjs, uploaded through the artifact slot flow,
 * and ingested as captures before resolving.
 */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { buildTestApp, post, put, type FastifyInstanceLike } from "./helpers.js";

const PROJECT = "proj_reference_app";

let app: FastifyInstanceLike;
let cleanup: () => void;

function sha256(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makePng(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const c = fill(x, y);
      png.data[idx] = c[0];
      png.data[idx + 1] = c[1];
      png.data[idx + 2] = c[2];
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function cropPng(source: Buffer, region: { x: number; y: number; width: number; height: number }): Buffer {
  const src = PNG.sync.read(source);
  const out = new PNG({ width: region.width, height: region.height });
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const from = ((region.y + y) * src.width + (region.x + x)) << 2;
      const to = (region.width * y + x) << 2;
      out.data[to] = src.data[from];
      out.data[to + 1] = src.data[from + 1];
      out.data[to + 2] = src.data[from + 2];
      out.data[to + 3] = src.data[from + 3];
    }
  }
  return PNG.sync.write(out);
}

async function uploadArtifact(projectId: string, bytes: Buffer): Promise<string> {
  const slot = await post(app, `/v1/projects/${projectId}/artifact-uploads`, {
    mediaType: "image/png",
    byteSize: bytes.byteLength,
    digest: sha256(bytes),
  });
  expect(slot.statusCode).toBe(201);
  const { slotId } = JSON.parse(slot.body);
  const done = await put(app, `/v1/artifacts/${slotId}`, bytes);
  expect(done.statusCode).toBe(200);
  return JSON.parse(done.body).artifactId as string;
}

function scenario(id: string) {
  return {
    id,
    recipeDigest: "recipe",
    route: "/catalog",
    fixtureDigest: "fixture",
    role: "user",
    featureFlagsDigest: "flags",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    locale: "en-US",
    timeZone: "UTC",
    colorScheme: "light",
    reducedMotion: false,
  };
}

function environment() {
  return {
    runnerImageDigest: "ri",
    browserRevision: "br",
    fontsDigest: "fo",
    adapterVersion: "av",
    captureToolVersion: "ct",
    redactionPolicyDigest: "rp",
  };
}

async function ingestCapture(input: {
  captureId: string;
  idempotencyKey: string;
  commitSha: string;
  scenarioId: string;
  screenshotArtifactId: string;
  screenshotDigest: string;
  screenshotBytes: Buffer;
  bounds: { x: number; y: number; width: number; height: number };
  scrollX?: number;
  scrollY?: number;
}): Promise<void> {
  const manifest = {
    captureId: input.captureId,
    spec: {
      protocolVersion: 1,
      projectId: PROJECT,
      commitSha: input.commitSha,
      buildArtifactDigest: `digest_${input.commitSha}`,
      scenario: scenario(input.scenarioId),
      environment: environment(),
    },
    capturedAt: `2026-02-${input.commitSha.endsWith("1") ? "01" : "02"}T10:00:00.000Z`,
    gitParents: [],
    observations: [
      {
        occurrenceId: `occ_${input.captureId}`,
        captureId: input.captureId,
        explicitAnchor: "catalog.productChooser",
        visibleText: "product chooser",
        bounds: [input.bounds],
        coordinateSpace: "document-css-pixels",
        sourceLinks: [],
        completeness: "complete-for-scenario",
        limitations: [],
      },
    ],
    artifacts: [
      {
        artifactId: input.screenshotArtifactId,
        kind: "screenshot-png",
        digest: input.screenshotDigest,
        byteSize: input.screenshotBytes.byteLength,
        mimeType: "image/png",
      },
    ],
    buildOutcome: "succeeded",
    redactionMasks: [],
    scrollOffsets: { x: input.scrollX ?? 0, y: input.scrollY ?? 0 },
    idempotencyKey: input.idempotencyKey,
  };
  const res = await app.inject({
    method: "POST",
    url: `/v1/projects/${PROJECT}/captures`,
    headers: { "content-type": "application/json", authorization: "Bearer dev-token", "idempotency-key": input.idempotencyKey },
    payload: manifest,
  });
  expect(res.statusCode).toBe(201);
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-intel-ground-"));
  const built = await buildTestApp(dir);
  app = built.app;
  cleanup = built.cleanup;
});

afterEach(() => {
  // no per-test teardown; the shared app is cleaned up via the process exit hook below
});

afterAll(async () => {
  cleanup();
});

describe("screenshot grounding", () => {
  it("resolves an exact crop to the anchored entity", async () => {
    // Screenshot with a distinctive red region on a gray page.
    const screenshot = makePng(320, 240, (x, y) =>
      x >= 200 && x < 280 && y >= 120 && y < 180 ? [220, 30, 40] : [120, 120, 120]
    );
    const screenshotArtifactId = await uploadArtifact(PROJECT, screenshot);
    await ingestCapture({
      captureId: "cap_ground_resolved",
      idempotencyKey: "ground-resolved",
      commitSha: "a".repeat(40) + "1",
      scenarioId: "catalog-desktop-signed-in",
      screenshotArtifactId,
      screenshotDigest: sha256(screenshot),
      screenshotBytes: screenshot,
      bounds: { x: 200, y: 120, width: 80, height: 60 },
    });

    // The user crops exactly that region and asks for grounding.
    const crop = cropPng(screenshot, { x: 200, y: 120, width: 80, height: 60 });
    const cropArtifactId = await uploadArtifact(PROJECT, crop);
    const res = await post(app, `/v1/projects/${PROJECT}/resolve`, {
      target: { kind: "screenshot", artifactId: cropArtifactId },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("resolved");
    expect(body.entityKey).toBe("catalog.productChooser");
    expect(body.entityId).toBeTruthy();
  });

  it("returns an ambiguous shortlist when two captures contain nearly identical regions", async () => {
    const makeVariant = (bg: [number, number, number]) =>
      makePng(200, 120, (x, y) => (x >= 10 && x < 70 && y >= 10 && y < 50 ? [50, 80, 200] : bg));
    const shotA = makeVariant([90, 90, 90]);
    const shotB = makeVariant([100, 90, 90]);
    const artifactA = await uploadArtifact(PROJECT, shotA);
    const artifactB = await uploadArtifact(PROJECT, shotB);
    await ingestCapture({
      captureId: "cap_ground_amb_a",
      idempotencyKey: "ground-amb-a",
      commitSha: "b".repeat(39) + "1",
      scenarioId: "catalog-desktop-signed-in",
      screenshotArtifactId: artifactA,
      screenshotDigest: sha256(shotA),
      screenshotBytes: shotA,
      bounds: { x: 10, y: 10, width: 60, height: 40 },
    });
    await ingestCapture({
      captureId: "cap_ground_amb_b",
      idempotencyKey: "ground-amb-b",
      commitSha: "b".repeat(39) + "2",
      scenarioId: "catalog-desktop-signed-out",
      screenshotArtifactId: artifactB,
      screenshotDigest: sha256(shotB),
      screenshotBytes: shotB,
      bounds: { x: 10, y: 10, width: 60, height: 40 },
    });

    const crop = cropPng(shotA, { x: 10, y: 10, width: 60, height: 40 });
    const cropArtifactId = await uploadArtifact(PROJECT, crop);
    const res = await post(app, `/v1/projects/${PROJECT}/resolve`, {
      target: { kind: "screenshot", artifactId: cropArtifactId },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ambiguous");
    expect(body.candidates.length).toBeGreaterThanOrEqual(2);
    expect(body.candidates.length).toBeLessThanOrEqual(3);
    for (const candidate of body.candidates) {
      expect(candidate.entityKey).toBe("catalog.productChooser");
      expect(candidate.score).toBeGreaterThanOrEqual(0);
      expect(candidate.score).toBeLessThanOrEqual(1);
      // No invented confidence percentages.
      expect(candidate.explanation).not.toMatch(/%/);
      expect(candidate.explanation).toContain("visual similarity rank");
    }
  });

  it("returns no_match when no authorized capture region is visually similar", async () => {
    const screenshot = makePng(120, 90, (x, y) => (x < 20 && y < 20 ? [10, 200, 10] : [40, 40, 40]));
    const screenshotArtifactId = await uploadArtifact(PROJECT, screenshot);
    await ingestCapture({
      captureId: "cap_ground_miss",
      idempotencyKey: "ground-miss",
      commitSha: "c".repeat(39) + "1",
      scenarioId: "catalog-desktop-signed-in",
      screenshotArtifactId,
      screenshotDigest: sha256(screenshot),
      screenshotBytes: screenshot,
      bounds: { x: 0, y: 0, width: 20, height: 20 },
    });
    // Crop of a completely unrelated area of the same page.
    const crop = cropPng(screenshot, { x: 60, y: 40, width: 40, height: 30 });
    const cropArtifactId = await uploadArtifact(PROJECT, crop);
    const res = await post(app, `/v1/projects/${PROJECT}/resolve`, {
      target: { kind: "screenshot", artifactId: cropArtifactId },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("no_match");
    expect(body.reason).toContain("no visually similar region");
  });

  it("rejects a crop artifact owned by another project with 404", async () => {
    app.db
      .prepare(
        "INSERT OR IGNORE INTO projects (id, tenant_id, name, repository, policy_revision, meta_json, created_at) VALUES (?, 'local', 'other-app', 'repo', 1, NULL, ?)"
      )
      .run("proj_other_app", new Date().toISOString());
    const crop = makePng(30, 20, () => [255, 0, 255]);
    const cropArtifactId = await uploadArtifact("proj_other_app", crop);
    const res = await post(app, `/v1/projects/${PROJECT}/resolve`, {
      target: { kind: "screenshot", artifactId: cropArtifactId },
    });
    expect(res.statusCode).toBe(404);
  });
});
