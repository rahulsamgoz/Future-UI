/**
 * Run execution (R2 stream D). The default executor is the REAL capture path:
 * ScenarioRunner against the configured app URL, one capture per scenario.
 * Tests inject a stub executor via createManager({ executor }) so unit tests
 * never spawn browsers.
 */
import { digestOf } from "@ui-intelligence/protocol";
import type { CaptureEnvironment } from "@ui-intelligence/protocol";
import {
  historyApiFromEnv,
  publishCapture,
  ScenarioRunner,
  standardScenarios,
} from "@ui-intelligence/capture";
import type { RedactionPolicy, UploadApi } from "@ui-intelligence/capture";
import type { ScenarioResult } from "./store.js";

export type RunExecutionInput = {
  runId: string;
  projectId: string;
  repoUrl: string;
  commitSha: string;
  scenarios: string[];
  /** Base URL of the app under capture (env APP_URL for the default executor). */
  appUrl: string;
  /**
   * History API for durable publication (audit finding: the manager path must
   * publish captures, not just report ids). Defaults to the HISTORY_API_URL /
   * HISTORY_API_TOKEN / HISTORY_API_PROJECT env vars.
   */
  historyApi?: UploadApi;
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
 * captures it against input.appUrl. Every capture is then durably published
 * to the history API via CaptureUploader and VERIFIED (capture retrievable,
 * occurrences > 0, artifact bytes readable) before the scenario is reported
 * as captured with the REAL captureId + artifactId. A failing scenario is
 * recorded as a per-scenario failure; it never aborts the remaining scenarios.
 */
export const defaultExecutor: RunExecutor = async (input) => {
  const all = standardScenarios();
  const api = input.historyApi ?? historyApiFromEnv();
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
      const { manifest, screenshotBytes } = await runner.execute(recipe, {
        projectId: input.projectId,
        commitSha: input.commitSha,
        buildArtifactDigest: "runner-managed",
        environment,
      });
      if (!api) {
        results.push({
          scenarioId,
          status: "failed",
          error: "history API not configured (HISTORY_API_URL): capture executed but NOT durably published",
        });
        continue;
      }
      const published = await publishCapture({
        manifest,
        screenshotBytes,
        api,
        dedupe: { commitSha: input.commitSha, scenarioId: recipe.id, buildArtifactDigest: "runner-managed" },
      });
      results.push({ scenarioId, status: "captured", captureId: published.captureId, artifactId: published.artifactId });
    } catch (error) {
      results.push({ scenarioId, status: "failed", error: (error as Error).message });
    }
  }
  return { results };
};
