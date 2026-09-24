import { describe, expect, it } from "vitest";
import {
  buildCaptureSpec,
  buildCaptureUrl,
  buildObservationsFromEvaluation,
  buildOccurrenceId,
  hashBytes,
  redactText,
} from "../src/index.js";
import type { CaptureEnvironment, CaptureSpec } from "@ui-intelligence/protocol";
import { captureRequestKey } from "@ui-intelligence/protocol";
import type { EntityEvaluation, RedactionPolicy, ScenarioRecipe } from "../src/index.js";

const recipe: ScenarioRecipe = {
  id: "catalog-default-desktop",
  name: "Catalog default state, desktop",
  route: "/",
  role: "visitor",
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  locale: "en-US",
  timeZone: "UTC",
  colorScheme: "light",
  reducedMotion: false,
  featureFlags: { gridDefault: false },
  fixture: "default",
  interactions: [],
  readiness: { selector: "[data-ui-entity='catalog.productChooser']", waitForFonts: true, stableFrames: 2 },
};

const environment: CaptureEnvironment = {
  runnerImageDigest: "local",
  browserRevision: "chromium-1",
  fontsDigest: "fonts-1",
  adapterVersion: "1.0.0",
  captureToolVersion: "1.0.0",
  redactionPolicyDigest: "placeholder",
};

const redactionPolicy: RedactionPolicy = { version: "1", masks: [{ selector: "[data-redact]" }] };

describe("redactText", () => {
  it("removes credential-like sequences", () => {
    expect(redactText("key sk-abcdefgh12 end")).toBe("key [REDACTED] end");
    expect(redactText("auth: Bearer abc.def.ghi")).toBe("auth: [REDACTED]");
    expect(redactText("card 4242 4242 4242 4242 ok")).toBe("card [REDACTED] ok");
    expect(redactText("card 4242424242424242 ok")).toBe("card [REDACTED] ok");
    expect(redactText("nothing sensitive here")).toBe("nothing sensitive here");
  });
});

describe("buildCaptureSpec", () => {
  it("maps recipe -> CaptureSpec deterministically", async () => {
    const specA = await buildCaptureSpec({
      recipe,
      projectId: "proj-1",
      commitSha: "a".repeat(40),
      buildArtifactDigest: "digest-1",
      environment,
      redactionPolicy,
    });
    const specB = await buildCaptureSpec({
      recipe,
      projectId: "proj-1",
      commitSha: "a".repeat(40),
      buildArtifactDigest: "digest-1",
      environment,
      redactionPolicy,
    });
    expect(specA).toEqual(specB);
    expect(specA.protocolVersion).toBe(1);
    expect(specA.scenario.id).toBe("catalog-default-desktop");
    expect(specA.scenario.route).toBe("/");
    expect(specA.scenario.role).toBe("visitor");
    expect(specA.scenario.viewport).toEqual({ width: 1440, height: 900, deviceScaleFactor: 1 });
    expect(specA.environment.redactionPolicyDigest).not.toBe("placeholder");
    expect(specA.environment.redactionPolicyDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a stable captureRequestKey that changes with the scenario", async () => {
    const spec: CaptureSpec = await buildCaptureSpec({
      recipe,
      projectId: "proj-1",
      commitSha: "a".repeat(40),
      buildArtifactDigest: "digest-1",
      environment,
      redactionPolicy,
    });
    const spec2: CaptureSpec = await buildCaptureSpec({
      recipe,
      projectId: "proj-1",
      commitSha: "a".repeat(40),
      buildArtifactDigest: "digest-1",
      environment,
      redactionPolicy,
    });
    expect(captureRequestKey(spec)).toBe(captureRequestKey(spec2));

    const differentFixture = await buildCaptureSpec({
      recipe: { ...recipe, fixture: "empty" },
      projectId: "proj-1",
      commitSha: "a".repeat(40),
      buildArtifactDigest: "digest-1",
      environment,
      redactionPolicy,
    });
    expect(captureRequestKey(differentFixture)).not.toBe(captureRequestKey(spec));

    const differentBuild = {
      ...spec,
      buildArtifactDigest: "digest-2",
    };
    expect(captureRequestKey(differentBuild)).not.toBe(captureRequestKey(spec));
  });
});

describe("buildCaptureUrl", () => {
  it("appends fixture and feature flag params", () => {
    const url = buildCaptureUrl("http://localhost:5173", recipe);
    expect(url.startsWith("http://localhost:5173/")).toBe(true);
    expect(url).toContain("__fixture=default");
    expect(url).toContain("__flag_gridDefault=false");
  });
});

describe("buildObservationsFromEvaluation", () => {
  const captureId = "capture_1";
  const screenshotArtifactId = "artifact_1";

  it("builds deterministic occurrence ids from anchor + index path", () => {
    expect(buildOccurrenceId("catalog.productChooser", [0, 2])).toBe("occ:catalog.productChooser#0.2");
  });

  it("links parents and keeps repeated anchors distinct", () => {
    const elements: EntityEvaluation[] = [
      {
        anchor: "catalog.page",
        role: "main",
        visibleText: "  Catalog   ",
        rect: { x: 0, y: 0, width: 1440, height: 900 },
        path: [0],
      },
      {
        anchor: "catalog.productChooser",
        instanceKey: "primary",
        role: "region",
        visibleText: "Products",
        rect: { x: 0, y: 10, width: 800, height: 300 },
        path: [0, 1],
        parentAnchor: "catalog.page",
        parentPath: [0],
      },
      {
        anchor: "catalog.productChooser",
        instanceKey: "related",
        role: "region",
        visibleText: "Related",
        rect: { x: 0, y: 400, width: 800, height: 300 },
        path: [0, 2],
        parentAnchor: "catalog.page",
        parentPath: [0],
      },
    ];
    const observations = buildObservationsFromEvaluation({ captureId, screenshotArtifactId, elements });
    expect(observations).toHaveLength(3);
    const byId = new Map(observations.map((o) => [o.occurrenceId, o]));
    const page = byId.get("occ:catalog.page#0");
    const primary = byId.get("occ:catalog.productChooser#0.1");
    const related = byId.get("occ:catalog.productChooser#0.2");
    expect(page).toBeDefined();
    expect(primary).toBeDefined();
    expect(related).toBeDefined();
    expect(primary?.parentOccurrenceId).toBe("occ:catalog.page#0");
    expect(related?.parentOccurrenceId).toBe("occ:catalog.page#0");
    expect(primary?.explicitAnchor).toBe("catalog.productChooser");
    expect(primary?.coordinateSpace).toBe("document-css-pixels");
    expect(primary?.sourceLinks).toEqual([{ definitionId: "catalog.productChooser", evidence: "registered" }]);
    expect(primary?.visibleText).toBe("Products");
    expect(primary?.completeness).toBe("complete-for-scenario");
    expect(primary?.limitations).toEqual([]);
    expect(observations.every((o) => o.captureId === captureId)).toBe(true);
    expect(observations.every((o) => o.screenshotArtifactId === screenshotArtifactId)).toBe(true);
    // Deterministic regardless of input order.
    const shuffled = buildObservationsFromEvaluation({
      captureId,
      screenshotArtifactId,
      elements: [...elements].reverse(),
    });
    expect(shuffled.map((o) => o.occurrenceId)).toEqual(observations.map((o) => o.occurrenceId));
  });

  it("marks captures with more than 200 elements as partial", () => {
    const elements: EntityEvaluation[] = Array.from({ length: 201 }, (_, i) => ({
      anchor: "catalog.productRow",
      visibleText: `row ${i}`,
      rect: { x: 0, y: i * 40, width: 800, height: 40 },
      path: [i],
    }));
    const observations = buildObservationsFromEvaluation({ captureId, screenshotArtifactId, elements });
    expect(observations.every((o) => o.completeness === "partial")).toBe(true);
    expect(observations.every((o) => o.limitations.includes("virtualized offscreen rows not observed"))).toBe(true);
  });
});

describe("hashBytes", () => {
  it("hashes raw bytes", async () => {
    const bytes = new TextEncoder().encode("hello");
    expect(await hashBytes(bytes)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });
});
