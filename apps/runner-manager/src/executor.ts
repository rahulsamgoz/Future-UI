/**
 * Run execution (R2 stream D). The default executor is the REAL capture path:
 * ScenarioRunner against the configured app URL, one capture per scenario.
 * Tests inject a stub executor via createManager({ executor }) so unit tests
 * never spawn browsers.
 */
import { digestOf } from "@ui-intelligence/protocol";
import type { CaptureEnvironment } from "@ui-intelligence/protocol";
import { ScenarioRunner, standardScenarios } from "@ui-intelligence/capture";
import type { RedactionPolicy } from "@ui-intelligence/capture";
import type { ScenarioResult } from "./store.js";

export type RunExecutionInput = {
  runId: string;
  projectId: string;
  repoUrl: string;
  commitSha: string;
  scenarios: string[];
  /** Base URL of the app under capture (env APP_URL for the default executor). */
  appUrl: string;
};

export type RunExecutionResult = { results: ScenarioResult[] };

export type RunExecutor = (input: RunExecutionInput) => Promise<RunExecutionResult>;

export function defaultEnvironment(): CaptureEnvironment {
  return {
    runnerImageDigest: "local",
    browserRevision: "bundled-playwright",
    fontsDigest: "unknown",
    adapterVersion: "unknown",
    captureToolVersion: "1.0.0",
    redactionPolicyDigest: "pending",
  };
}

/**
 * Real executor: resolves each scenario id against the standard recipes and
 * captures it against input.appUrl. A failing scenario is recorded as a
 * per-scenario failure; it never aborts the remaining scenarios.
 */
export const defaultExecutor: RunExecutor = async (input) => {
  const all = standardScenarios();
  const redactionPolicy: RedactionPolicy = { version: "1", masks: [] };
  const runner = new ScenarioRunner({
    baseUrl: input.appUrl,
    adapterVersion: "unknown",
    redactionPolicy,
  });
  const environment: CaptureEnvironment = {
    ...defaultEnvironment(),
    redactionPolicyDigest: await digestOf(redactionPolicy),
  };
  const results: ScenarioResult[] = [];
  for (const scenarioId of input.scenarios) {
    const recipe = all.find((r) => r.id === scenarioId);
    if (!recipe) {
      results.push({ scenarioId, status: "failed", error: `unknown scenario id "${scenarioId}"` });
      continue;
    }
    try {
      const { manifest } = await runner.execute(recipe, {
        projectId: input.projectId,
        commitSha: input.commitSha,
        buildArtifactDigest: "runner-managed",
        environment,
      });
      results.push({ scenarioId, status: "captured", captureId: manifest.captureId });
    } catch (error) {
      results.push({ scenarioId, status: "failed", error: (error as Error).message });
    }
  }
  return { results };
};
