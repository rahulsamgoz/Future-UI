/**
 * Coverage manifest logic test (architecture sections 16, 19). Runs the
 * coverage script offline (reference app unavailable) and asserts the
 * manifest is complete and honest: every planned slot present, expected
 * failures exactly matching ground truth, and totals adding up.
 *
 * The live 6-scenario capture run is executed separately by the operator:
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
  "catalog-empty-desktop",
  "catalog-loading-desktop",
  "catalog-default-mobile",
  "account-default-desktop",
  "account-error-desktop",
];

async function runOffline(): Promise<{ manifest: Record<string, unknown>; outPath: string; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ui-intel-coverage-test-"));
  const outPath = path.join(dir, "coverage-report.json");
  execFileSync("node", [scriptPath, "--offline", "--out", outPath], { encoding: "utf8" });
  const manifest = JSON.parse(await readFile(outPath, "utf8"));
  return { manifest, outPath, dir };
}

describe("capture coverage manifest (offline)", () => {
  it("produces exactly 78 slots: 13 commits x 6 scenarios, every pair present once", async () => {
    const { manifest, dir } = await runOffline();
    try {
      const slots = manifest.slots as Array<Record<string, unknown>>;
      expect(manifest.corpus).toMatchObject({ commits: 13, scenarios: 6, plannedSlots: 78 });
      expect(slots).toHaveLength(78);

      const seen = new Set(slots.map((s) => `${s.commitIndex}:${s.scenarioId}`));
      expect(seen.size).toBe(78);
      for (let commitIndex = 1; commitIndex <= 13; commitIndex += 1) {
        for (const scenarioId of ALL_SCENARIOS) {
          expect(seen.has(`${commitIndex}:${scenarioId}`)).toBe(true);
        }
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
      // Ground truth: exactly one unbuildable commit (commit 12) -> 6 slots.
      expect(expectedFailures).toHaveLength(6);
      for (const slot of expectedFailures) {
        expect(slot.commitIndex).toBe(12);
        expect(slot.buildable).toBe(false);
        expect(slot.commitMessage).toContain("INTENTIONALLY_UNBUILDABLE");
        expect(slot.reason).toBeTruthy();
      }
      // No other slot claims unbuildability.
      expect(slots.filter((s) => s.buildable === false)).toHaveLength(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records HEAD slots without capture with the explicit reason, and totals add up", async () => {
    const { manifest, dir } = await runOffline();
    try {
      const slots = manifest.slots as Array<Record<string, unknown>>;
      const totals = manifest.totals as Record<string, number>;
      expect(totals.planned).toBe(78);
      expect(totals.captured + totals.expected_failure + totals.not_captured).toBe(78);
      expect(totals.captured).toBe(slots.filter((s) => s.evidence === "captured").length);
      expect(totals.expected_failure).toBe(slots.filter((s) => s.evidence === "expected_failure").length);
      expect(totals.not_captured).toBe(slots.filter((s) => s.evidence === "not_captured").length);

      // Offline run: HEAD slots carry the explicit reason, never a fake render.
      const headSlots = slots.filter((s) => s.commitIndex === 13);
      expect(headSlots).toHaveLength(6);
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
      // Documented honest viewport mapping (no invented 144-slot expansion).
      expect((manifest.corpus as Record<string, unknown>).viewportMapping).toContain("78");
      expect((manifest.referenceBuild as Record<string, unknown>).liveCaptureExecuted).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
