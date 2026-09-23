import { describe, expect, it } from "vitest";
import type { CaptureRecord, Observation } from "@ui-intelligence/protocol";
import { compareCaptures, groupNearDuplicates } from "../src/index.js";

function obs(overrides: Partial<Observation> & { occurrenceId: string }): Observation {
  return {
    captureId: overrides.captureId ?? "cap_1",
    bounds: [{ x: 0, y: 0, width: 100, height: 40 }],
    coordinateSpace: "document-css-pixels",
    sourceLinks: [],
    completeness: "complete-for-scenario",
    limitations: [],
    ...overrides,
  } as Observation;
}

function captureRecord(overrides: {
  captureId: string;
  observations: Observation[];
  scenarioId?: string;
  createdAt?: string;
}): CaptureRecord {
  return {
    captureId: overrides.captureId as CaptureRecord["captureId"],
    projectId: "proj_test" as CaptureRecord["projectId"],
    buildId: "build_1",
    scenarioId: overrides.scenarioId ?? "s1",
    commitSha: "c1",
    evidenceLabel: "captured_at_build",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    manifest: {
      captureId: overrides.captureId,
      spec: {
        protocolVersion: 1,
        projectId: "proj_test",
        commitSha: "c1",
        buildArtifactDigest: "d0",
        scenario: {
          id: overrides.scenarioId ?? "s1",
          recipeDigest: "r",
          route: "/",
          fixtureDigest: "f",
          role: "guest",
          featureFlagsDigest: "ff",
          viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
          locale: "en-US",
          timeZone: "UTC",
          colorScheme: "light",
          reducedMotion: false,
        },
        environment: {
          runnerImageDigest: "ri",
          browserRevision: "br",
          fontsDigest: "fo",
          adapterVersion: "av",
          captureToolVersion: "ct",
          redactionPolicyDigest: "rp",
        },
      },
      capturedAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
      gitParents: [],
      observations: overrides.observations,
      artifacts: [],
      buildOutcome: "succeeded",
      redactionMasks: [],
      scrollOffsets: { x: 0, y: 0 },
      idempotencyKey: overrides.captureId,
    },
  };
}

describe("compareCaptures", () => {
  it("detects no changes for identical observations", () => {
    const a = [obs({ occurrenceId: "o1", explicitAnchor: "btn.save", visibleText: "Save" })];
    const b = [obs({ occurrenceId: "o2", explicitAnchor: "btn.save", visibleText: "Save" })];
    expect(compareCaptures(a, b)).toEqual({ changed: false, changes: [] });
  });

  it("detects text and bounds changes on matched anchors", () => {
    const a = [obs({ occurrenceId: "o1", explicitAnchor: "btn.save", visibleText: "Save" })];
    const b = [
      obs({
        occurrenceId: "o2",
        explicitAnchor: "btn.save",
        visibleText: "Save changes",
        bounds: [{ x: 0, y: 0, width: 140, height: 40 }],
      }),
    ];
    const result = compareCaptures(a, b);
    expect(result.changed).toBe(true);
    expect(result.changes).toContainEqual({ anchorA: "btn.save", anchorB: "btn.save", kind: "text_changed" });
    expect(result.changes).toContainEqual({ anchorA: "btn.save", anchorB: "btn.save", kind: "bounds_changed" });
  });

  it("ignores bounds jitter within 2px", () => {
    const a = [obs({ occurrenceId: "o1", explicitAnchor: "x", bounds: [{ x: 10, y: 10, width: 100, height: 40 }] })];
    const b = [obs({ occurrenceId: "o2", explicitAnchor: "x", bounds: [{ x: 12, y: 8, width: 102, height: 42 }] })];
    expect(compareCaptures(a, b).changed).toBe(false);
  });

  it("detects additions and removals", () => {
    const a = [obs({ occurrenceId: "o1", explicitAnchor: "old.item" })];
    const b = [obs({ occurrenceId: "o2", explicitAnchor: "new.item" })];
    const result = compareCaptures(a, b);
    expect(result.changes).toContainEqual({ anchorA: "old.item", kind: "removed" });
    expect(result.changes).toContainEqual({ anchorB: "new.item", kind: "added" });
  });

  it("falls back to path index matching for unanchored observations", () => {
    const a = [obs({ occurrenceId: "o1", visibleText: "one" }), obs({ occurrenceId: "o2", visibleText: "two" })];
    const b = [obs({ occurrenceId: "o3", visibleText: "one" }), obs({ occurrenceId: "o4", visibleText: "changed" })];
    const result = compareCaptures(a, b);
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([{ kind: "text_changed" }]);
  });
});

describe("groupNearDuplicates", () => {
  it("groups identical captures and keeps every member id", () => {
    const mk = (id: string, y: number): CaptureRecord =>
      captureRecord({
        captureId: id,
        createdAt: `2026-01-0${id === "cap_a" ? 1 : 2}T00:00:00.000Z`,
        observations: [
          obs({ occurrenceId: `${id}-o1`, captureId: id, explicitAnchor: "item.1", visibleText: "Widget" }),
          obs({
            occurrenceId: `${id}-o2`,
            captureId: id,
            explicitAnchor: "item.2",
            visibleText: "Gadget",
            bounds: [{ x: 0, y, width: 100, height: 40 }],
          }),
        ],
      });
    const groups = groupNearDuplicates([mk("cap_b", 2), mk("cap_a", 0), mk("cap_c", 1.5)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.representativeId).toBe("cap_a");
    expect([...groups[0]!.memberIds].sort()).toEqual(["cap_a", "cap_b", "cap_c"]);
  });

  it("separates captures whose bounds differ by more than 2px", () => {
    const mk = (id: string, y: number): CaptureRecord =>
      captureRecord({
        captureId: id,
        createdAt: "2026-01-01T00:00:00.000Z",
        observations: [
          obs({
            occurrenceId: `${id}-o1`,
            captureId: id,
            explicitAnchor: "item.1",
            visibleText: "Widget",
            bounds: [{ x: 0, y, width: 100, height: 40 }],
          }),
        ],
      });
    const groups = groupNearDuplicates([mk("cap_a", 0), mk("cap_b", 50)]);
    expect(groups).toHaveLength(2);
  });

  it("does not group across scenarios", () => {
    const mk = (id: string, scenarioId: string): CaptureRecord =>
      captureRecord({
        captureId: id,
        scenarioId,
        createdAt: "2026-01-01T00:00:00.000Z",
        observations: [obs({ occurrenceId: `${id}-o1`, captureId: id, explicitAnchor: "item.1", visibleText: "W" })],
      });
    const groups = groupNearDuplicates([mk("cap_a", "desktop"), mk("cap_b", "mobile")]);
    expect(groups).toHaveLength(2);
  });

  it("returns one member per distinct capture (no input dropped)", () => {
    const inputs = ["a", "b", "c", "d"].map((id) =>
      captureRecord({
        captureId: `cap_${id}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        observations: [obs({ occurrenceId: `o_${id}`, captureId: `cap_${id}`, explicitAnchor: "k", visibleText: id })],
      })
    );
    const groups = groupNearDuplicates(inputs);
    const totalMembers = groups.reduce((n, g) => n + g.memberIds.length, 0);
    expect(totalMembers).toBe(inputs.length);
  });
});
