#!/usr/bin/env node
/**
 * Capture coverage manifest (architecture sections 16, 19).
 *
 * Builds the history fixture corpus, then produces an honest coverage
 * manifest: one row per (commit, scenario) slot. Every planned slot ends as
 * an authentic captured artifact, an explicit expected failure, or an
 * explicit gap — never an invented render.
 *
 * Viewport mapping: the 6 standard scenario recipes each carry their own
 * viewport (5 desktop, 1 mobile — packages/capture standardScenarios), so the
 * coverage matrix is commits x scenarios = 13 x 6 = 78 planned slots. The
 * spec's "12 commits x 6 scenarios x 2 viewports = 144" arithmetic maps to
 * per-recipe viewports covering both viewports across the scenario set, not
 * a literal 2x expansion per scenario.
 *
 * Historical commits other than HEAD are recorded as explicit gap records:
 * the fixture corpus is synthetic text files, not a runnable app, so no
 * historical reconstruction is executed in the dev profile.
 *
 * Usage:
 *   node fixtures/history/coverage.mjs [--offline] [--out path]
 *        [--app url] [--api url] [--token t] [--project p]
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
const appUrl = flag("--app") ?? "http://localhost:5173";
const apiUrl = flag("--api") ?? "http://localhost:8787";
const token = flag("--token") ?? "dev-token";
const projectId = flag("--project") ?? "reference-app";

// ---- 1. generate the fixture corpus ---------------------------------------
const fixtureDir = mkdtempSync(path.join(tmpdir(), "ui-intel-coverage-"));
try {
  execFileSync("node", [path.join(scriptDir, "generate.mjs"), fixtureDir], { encoding: "utf8" });

  const groundTruth = JSON.parse(readFileSync(path.join(fixtureDir, "ground-truth.json"), "utf8"));
  const scenarioIds = groundTruth.corpus.scenarioIds; // 6 per-viewport recipes

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

  // Current build identity: HEAD of THIS repository (the running reference app).
  const repoHeadSha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // ---- 2. live capture of the current build (6 standard scenarios) ---------
  const live = new Map(); // scenarioId -> { captureId, sha256, screenshotArtifactId }
  let referenceAppAvailable = false;
  if (!OFFLINE) {
    try {
      const health = await fetch(`${apiUrl.replace(/\/$/, "")}/health`);
      const app = await fetch(`${appUrl.replace(/\/$/, "")}/`);
      referenceAppAvailable = health.ok && app.ok;
    } catch {
      referenceAppAvailable = false;
    }
  }

  if (referenceAppAvailable) {
    const capture = await import("@ui-intelligence/capture");
    const protocol = await import("@ui-intelligence/protocol");
    const { ScenarioRunner, CaptureUploader, standardScenarios, hashBytes } = capture;
    const digestOf = protocol.digestOf;

    const redactionPolicy = { version: "1", masks: [] };
    const environment = {
      runnerImageDigest: "local",
      browserRevision: "bundled-playwright",
      fontsDigest: "unknown",
      adapterVersion: "unknown",
      captureToolVersion: "1.0.0",
      redactionPolicyDigest: await digestOf(redactionPolicy),
    };
    const runner = new ScenarioRunner({
      baseUrl: appUrl,
      adapterVersion: "unknown",
      redactionPolicy,
    });
    const uploader = new CaptureUploader();
    const api = { baseUrl: apiUrl, token, projectId };

    for (const recipe of standardScenarios()) {
      try {
        const { manifest, screenshotBytes } = await runner.execute(recipe, {
          projectId,
          commitSha: repoHeadSha,
          buildArtifactDigest: "local-dev",
          environment,
        });
        const { captureId } = await uploader.upload(manifest, screenshotBytes, api);
        // Verify the capture is visible through the project API.
        const listResponse = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/projects/${projectId}/captures`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!listResponse.ok) throw new Error(`captures list failed with status ${listResponse.status}`);
        const { captures } = await listResponse.json();
        const stored = captures.find((c) => c.captureId === captureId);
        if (!stored) throw new Error(`capture ${captureId} not found after upload`);
        live.set(recipe.id, {
          captureId,
          sha256: await hashBytes(screenshotBytes),
          screenshotArtifactId: manifest.artifacts.find((a) => a.kind === "screenshot-png")?.artifactId,
          observationCount: stored.observationCount,
        });
        console.log(`captured ${recipe.id} -> ${captureId}`);
      } catch (error) {
        console.error(`capture failed for ${recipe.id}: ${error.message}`);
      }
    }
  }

  // ---- 3. manifest rows: one per (commit, scenario) slot -------------------
  const HISTORICAL_GAP_REASON = "historical reconstruction not executed in dev profile: source corpus is synthetic";
  const slots = [];
  for (let i = 0; i < fixtureCommits.length; i += 1) {
    const commit = fixtureCommits[i];
    const truth = groundTruth.commits[i];
    const buildable = truth.buildOutcome === "buildable";
    const isHead = commit.sha === fixtureHeadSha;
    for (const scenarioId of scenarioIds) {
      const slot = {
        commitSha: commit.sha,
        commitIndex: truth.commit,
        commitMessage: truth.message,
        scenarioId,
        viewport: scenarioId.endsWith("-mobile") ? "mobile" : "desktop",
        buildable,
      };
      if (!buildable) {
        // Expected failures remain explicit coverage records (spec section 16).
        slots.push({
          ...slot,
          evidence: "expected_failure",
          reason: truth.notes ?? "intentionally unbuildable revision",
        });
      } else if (isHead && live.has(scenarioId)) {
        const captured = live.get(scenarioId);
        slots.push({
          ...slot,
          evidence: "captured",
          captureId: captured.captureId,
          sha256: captured.sha256,
          screenshotArtifactId: captured.screenshotArtifactId,
          observationCount: captured.observationCount,
          // Authentic pixels come from the current build of THIS repository.
          capturedCommitSha: repoHeadSha,
        });
      } else {
        slots.push({
          ...slot,
          evidence: "not_captured",
          reason: isHead && !OFFLINE
            ? "reference app not running or capture failed"
            : isHead
              ? "reference app not running"
              : HISTORICAL_GAP_REASON,
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
      viewportMapping:
        "6 scenario recipes each carry their own viewport (5 desktop, 1 mobile); the spec's 12x6x2=144 arithmetic maps to commits x scenarios = 78 per-recipe-viewport slots covering both viewports across the scenario set",
    },
    referenceBuild: {
      repositoryHeadSha: repoHeadSha,
      appUrl,
      apiUrl,
      projectId,
      liveCaptureExecuted: referenceAppAvailable,
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
  rmSync(fixtureDir, { recursive: true, force: true });
}
