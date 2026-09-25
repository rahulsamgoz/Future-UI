/**
 * Run execution (R2 stream D). The default executor is the REAL capture path
 * with honest commit binding (audit finding 3d):
 * - LOCAL repoUrl (dev profile): reconstruct the ACTUAL commit via
 *   packages/capture reconstructCommit (worktree -> serve -> capture ->
 *   publish -> verify) — captures carry that commit sha.
 * - REMOTE/absent repoUrl: capture APP_URL with a buildArtifactDigest derived
 *   from the served page's first response HTML and an honest provenance note
 *   ("commit binding asserted, not verified").
 * Tests inject a stub executor via createManager({ executor }) so unit tests
 * never spawn browsers; defaultExecutor itself accepts optional deps for
 * tests of its own.
 */
import { executeManagedRun, historyApiFromEnv } from "@ui-intelligence/capture";
import type { ManagedRunArgs, ManagedRunProvenance, UploadApi } from "@ui-intelligence/capture";
import type { CaptureEnvironment } from "@ui-intelligence/protocol";
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

export type RunExecutionResult = {
  results: ScenarioResult[];
  /** How the captures bind to the requested commit (honest provenance). */
  provenance?: ManagedRunProvenance;
};

export type RunExecutor = (
  input: RunExecutionInput,
  deps?: ManagedRunArgs["deps"],
) => Promise<RunExecutionResult>;

/** Injection seams for tests (runner/uploader/fetch/reconstruct). */
export type ManagedRunDeps = ManagedRunArgs["deps"];

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
 * Real executor: delegates to the shared executeManagedRun so the
 * runner-manager and the capture-runner managed worker behave identically.
 */
export const defaultExecutor: RunExecutor = async (input, deps) => {
  const { provenance, results } = await executeManagedRun({
    projectId: input.projectId,
    repoUrl: input.repoUrl || undefined,
    commitSha: input.commitSha,
    scenarios: input.scenarios,
    appUrl: input.appUrl,
    api: input.historyApi ?? historyApiFromEnv(),
    onLog: (message) => console.log(`[run ${input.runId}] ${message}`),
    deps,
  });
  return { provenance, results };
};
