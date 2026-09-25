#!/usr/bin/env node
/**
 * Capture coverage manifest (architecture sections 10, 16, 19).
 *
 * Builds the history fixture corpus, then produces an honest coverage
 * manifest: one row per (commit, scenario) slot. Every planned slot ends as
 * an authentic captured artifact, an explicit expected failure, or an
 * explicit gap — never an invented render.
 *
 * DEFAULT (live) mode runs REAL historical reconstruction over the fixture
 * corpus: every commit is materialized as a git worktree, served statically
 * (serving IS the build for this runnable corpus), and captured
 * scenario-by-scenario via the capture path, with each capture durably
 * published to the history API and VERIFIED before it counts (see
 * packages/capture reconstructCommit). The intentionally unbuildable commit
 * yields per-scenario EXPECTED failures — recorded, never faked.
 *
 * Viewport mapping (audit finding 3c): the SIX named route/state scenarios
 * (catalog default/empty/loading, account default/loading/error) each exist in
 * BOTH viewports — 12 per-commit recipes (packages/capture standardScenarios),
 * so the coverage matrix is commits x scenario-recipes = 13 x 12 = 156 planned
 * slots, matching the spec's "six named route/state scenarios across two
 * viewports" arithmetic.
 *
 * Usage:
 *   node fixtures/history/coverage.mjs [--offline] [--out path]
 *        [--api url] [--token t] [--project p]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const OFFLINE = args.includes("--offline");
const outPath = path.resolve(process.cwd(), flag("--out") ?? path.join(repoRoot, "docs", "coverage-report.json"));
const apiUrl = flag("--api") ?? "http://localhost:8787";
const token = flag("--token") ?? "dev-token";
const projectId = flag("--project") ?? "proj_reference_app";

let fixtureDir = "";
const cleanup = () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
};

try {
  // ---- 1. generate the fixture corpus ---------------------------------------
  fixtureDir = mkdtempSync(path.join(tmpdir(), "ui-intel-coverage-"));
  execFileSync("node", [path.join(scriptDir, "generate.mjs"), fixtureDir], { encoding: "utf8" });

  const groundTruth = JSON.parse(readFileSync(path.join(fixtureDir, "ground-truth.json"), "utf8"));
  const scenarioIds = groundTruth.corpus.scenarioIds; // 12 per-commit recipes (6 scenarios x 2 viewports)

  // Fixture commits in chronological order, matched to ground truth by index.
  const log = execFileSync(
    "git",
    ["-C", fixtureDir, "log", "--reverse", "--format=%H%x1f%s"],
    { encoding: "utf8" }
  );
  const fixtureCommits = log
    .trim()
    .split("\n")
    .map((line) => {
      const [sha, message] = line.split("\x1f");
      return { sha, message };
    });
  if (fixtureCommits.length !== groundTruth.corpus.commits) {
    throw new Error(`expected ${groundTruth.corpus.commits} fixture commits, got ${fixtureCommits.length}`);
  }
  const fixtureHeadSha = fixtureCommits[fixtureCommits.length - 1].sha;

  // Current build identity: HEAD of THIS repository (the tooling repo).
  const repoHeadSha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // ---- 2. historical reconstruction of every fixture commit ------------------
  let apiReachable = false;
  if (!OFFLINE) {
    try {
      const health = await fetch(`${apiUrl.replace(/\/$/, "")}/health`);
      apiReachable = health.ok;
    } catch {
      apiReachable = false;
    }
    if (!apiReachable) console.error(`history API not reachable at ${apiUrl}; reconstruction skipped`);
  }

  /** commitIndex -> CommitReconstruction (packages/capture reconstructCommit) */
  const reconstructions = new Map();
  if (!OFFLINE && apiReachable) {
    const capture = await import("@ui-intelligence/capture");
    for (let i = 0; i < fixtureCommits.length; i += 1) {
      const commit = fixtureCommits[i];
      const truth = groundTruth.commits[i];
      try {
        const result = await capture.reconstructCommit({
          repoDir: fixtureDir,
          commitSha: commit.sha,
          scenarios: scenarioIds,
          api: { baseUrl: apiUrl, token, projectId },
          onLog: (message) => console.log(message),
        });
        reconstructions.set(truth.commit, result);
      } catch (error) {
        console.error(`reconstruction failed for commit ${truth.commit} (${commit.sha}): ${error.message}`);
      }
    }
  }

  // ---- 3. manifest rows: one per (commit, scenario) slot --------------------
  const OFFLINE_GAP_REASON =
    "historical reconstruction not executed in offline mode: pass a reachable --api to reconstruct the corpus";
  const slots = [];
  for (let i = 0; i < fixtureCommits.length; i += 1) {
    const commit = fixtureCommits[i];
    const truth = groundTruth.commits[i];
    const buildable = truth.buildOutcome === "buildable";
    const isHead = commit.sha === fixtureHeadSha;
    const reconstruction = reconstructions.get(truth.commit);
    for (const scenarioId of scenarioIds) {
      const slot = {
        commitSha: commit.sha,
        commitIndex: truth.commit,
        commitMessage: truth.message,
        scenarioId,
        viewport: scenarioId.endsWith("-mobile") ? "mobile" : "desktop",
        buildable,
      };
      const scenarioResult = reconstruction?.scenarios.find((s) => s.scenarioId === scenarioId);
      if (scenarioResult?.outcome === "captured") {
        // Authentic pixels from the reconstructed commit, durably published
        // and verified through the history API.
        slots.push({
          ...slot,
          evidence: "captured",
          captureId: scenarioResult.captureId,
          sha256: scenarioResult.sha256,
          screenshotArtifactId: scenarioResult.artifactId,
          observationCount: scenarioResult.occurrenceCount,
          capturedCommitSha: commit.sha,
        });
      } else if (scenarioResult?.outcome === "expected_failure") {
        // Expected failures remain explicit coverage records (spec section 16).
        slots.push({
          ...slot,
          evidence: "expected_failure",
          reason: scenarioResult.error ?? truth.notes ?? "intentionally unbuildable revision",
        });
      } else if (scenarioResult?.outcome === "failed") {
        slots.push({
          ...slot,
          evidence: "not_captured",
          reason: `reconstruction failed: ${scenarioResult.error}`,
        });
      } else if (!buildable) {
        // No reconstruction ran for this commit (offline mode): keep the
        // ground-truth expected-failure record.
        slots.push({
          ...slot,
          evidence: "expected_failure",
          reason: truth.notes ?? "intentionally unbuildable revision",
        });
      } else {
        slots.push({
          ...slot,
          evidence: "not_captured",
          reason: OFFLINE
            ? isHead
              ? "reference app not running"
              : OFFLINE_GAP_REASON
            : "history API not reachable; reconstruction not executed",
        });
      }
    }
  }

  const totals = {
    planned: slots.length,
    captured: slots.filter((s) => s.evidence === "captured").length,
    expected_failure: slots.filter((s) => s.evidence === "expected_failure").length,
    not_captured: slots.filter((s) => s.evidence === "not_captured").length,
  };

  const manifest = {
    generatedAt: new Date().toISOString(),
    corpus: {
      commits: groundTruth.corpus.commits,
      scenarios: groundTruth.corpus.scenarios,
      scenarioIds,
      plannedSlots: fixtureCommits.length * scenarioIds.length,
      runnable: groundTruth.corpus.runnable ?? false,
      viewportMapping:
        "12 scenario recipes per commit: six named route/state scenarios x 2 viewports (desktop 1440x900, mobile 390x844); 13 commits x 12 recipes = 156 planned slots",
    },
    referenceBuild: {
      repositoryHeadSha: repoHeadSha,
      apiUrl,
      projectId,
      liveCaptureExecuted: false,
      note: "coverage comes from historical reconstruction of the fixture commits, not from a live reference-app capture",
    },
    reconstruction: {
      executed: reconstructions.size > 0,
      commits: reconstructions.size,
      captured: totals.captured,
      expected_failure: totals.expected_failure,
      failed: totals.not_captured,
      publicationVerified: true,
      note:
        "every 'captured' slot was reconstructed from the commit (git worktree + static serve), published to the history API, and verified (capture retrievable, occurrences > 0, artifact bytes readable)",
    },
    totals,
    slots,
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `coverage manifest written to ${outPath}: ${totals.planned} planned slots ` +
      `(${totals.captured} captured, ${totals.expected_failure} expected failure, ${totals.not_captured} not captured)`
  );
  process.exit(0);
} catch (error) {
  console.error(`coverage manifest failed: ${error.message}`);
  process.exit(1);
} finally {
  cleanup();
}
