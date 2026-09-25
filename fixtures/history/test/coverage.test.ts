/**
 * Coverage manifest logic test (architecture sections 16, 19). Runs the
 * coverage script offline (history API unavailable) and asserts the manifest
 * is complete and honest: every planned slot present, expected failures
 * exactly matching ground truth, and totals adding up.
 *
 * Slot arithmetic (audit finding 3c): six named route/state scenarios across
 * BOTH viewports = 12 per-commit recipes; 13 commits x 12 = 156 planned slots.
 *
 * The live 156-slot reconstruction run is executed separately by the operator:
 * `node fixtures/history/coverage.mjs` writes docs/coverage-report.json.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../coverage.mjs");

const ALL_SCENARIOS = [
  "catalog-default-desktop",
  "catalog-default-mobile",
  "catalog-empty-desktop",
  "catalog-empty-mobile",
  "catalog-loading-desktop",
  "catalog-loading-mobile",
  "account-default-desktop",
  "account-default-mobile",
  "account-loading-desktop",
  "account-loading-mobile",
  "account-error-desktop",
  "account-error-mobile",
];

async function runOffline(): Promise<{ manifest: Record<string, unknown>; outPath: string; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ui-intel-coverage-test-"));
  const outPath = path.join(dir, "coverage-report.json");
  execFileSync("node", [scriptPath, "--offline", "--out", outPath], { encoding: "utf8" });
  const manifest = JSON.parse(await readFile(outPath, "utf8"));
  return { manifest, outPath, dir };
}

describe("capture coverage manifest (offline)", () => {
  it("produces exactly 156 slots: 13 commits x 12 scenario-recipes (6 scenarios x 2 viewports), every pair present once", async () => {
    const { manifest, dir } = await runOffline();
    try {
      const slots = manifest.slots as Array<Record<string, unknown>>;
      expect(manifest.corpus).toMatchObject({ commits: 13, scenarios: 12, plannedSlots: 156 });
      expect(slots).toHaveLength(156);

      const seen = new Set(slots.map((s) => `${s.commitIndex}:${s.scenarioId}`));
      expect(seen.size).toBe(156);
      for (let commitIndex = 1; commitIndex <= 13; commitIndex += 1) {
        for (const scenarioId of ALL_SCENARIOS) {
          expect(seen.has(`${commitIndex}:${scenarioId}`)).toBe(true);
        }
      }
      // Both viewports are covered for every named scenario.
      const ids = new Set(slots.map((s) => s.scenarioId));
      expect(ids.size).toBe(12);
      for (const named of ["catalog-default", "catalog-empty", "catalog-loading", "account-default", "account-loading", "account-error"]) {
        expect(ids.has(`${named}-desktop`)).toBe(true);
        expect(ids.has(`${named}-mobile`)).toBe(true);
      }
      // The commit/message columns are real fixture commits (unique shas).
      const shas = new Set(slots.map((s) => s.commitSha));
      expect(shas.size).toBe(13);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks expected-failure rows exactly matching ground-truth unbuildable commits", async () => {
    const { manifest, dir } = await runOffline();
    try {
      const slots = manifest.slots as Array<Record<string, unknown>>;
      const expectedFailures = slots.filter((s) => s.evidence === "expected_failure");
      // Ground truth: exactly one unbuildable commit (commit 12) x 12 recipes.
      expect(expectedFailures).toHaveLength(12);
      for (const slot of expectedFailures) {
        expect(slot.commitIndex).toBe(12);
        expect(slot.buildable).toBe(false);
        expect(slot.commitMessage).toContain("INTENTIONALLY_UNBUILDABLE");
        expect(slot.reason).toBeTruthy();
      }
      // No other slot claims unbuildability.
      expect(slots.filter((s) => s.buildable === false)).toHaveLength(12);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records HEAD slots without capture with the explicit reason, and totals add up", async () => {
    const { manifest, dir } = await runOffline();
    try {
      const slots = manifest.slots as Array<Record<string, unknown>>;
      const totals = manifest.totals as Record<string, number>;
      expect(totals.planned).toBe(156);
      expect(totals.captured + totals.expected_failure + totals.not_captured).toBe(156);
      expect(totals.captured).toBe(slots.filter((s) => s.evidence === "captured").length);
      expect(totals.expected_failure).toBe(slots.filter((s) => s.evidence === "expected_failure").length);
      expect(totals.not_captured).toBe(slots.filter((s) => s.evidence === "not_captured").length);

      // Offline run: HEAD slots carry the explicit reason, never a fake render.
      const headSlots = slots.filter((s) => s.commitIndex === 13);
      expect(headSlots).toHaveLength(12);
      for (const slot of headSlots) {
        expect(slot.evidence).toBe("not_captured");
        expect(slot.reason).toBe("reference app not running");
      }
      // Offline run: buildable commits carry the explicit no-reconstruction gap
      // (reconstruction requires a reachable history API).
      for (const slot of slots.filter((s) => s.commitIndex < 13 && s.evidence === "not_captured")) {
        expect(slot.reason).toBe(
          "historical reconstruction not executed in offline mode: pass a reachable --api to reconstruct the corpus"
        );
      }
      // Documented honest viewport arithmetic (six named scenarios x 2 viewports).
      expect((manifest.corpus as Record<string, unknown>).viewportMapping).toContain("156");
      expect((manifest.referenceBuild as Record<string, unknown>).liveCaptureExecuted).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
