#!/usr/bin/env node
/**
 * ui-intelligence CLI (architecture sections 10, 12): init, history plan/run,
 * capture, export, status. Plain argv parsing, no commander.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { digestOf } from "@ui-intelligence/protocol";
import type { CaptureEnvironment } from "@ui-intelligence/protocol";
import { CaptureUploader, ScenarioRunner, standardScenarios } from "@ui-intelligence/capture";
import type { ScenarioRecipe } from "@ui-intelligence/capture";
import { apiErrorMessage, apiRequest } from "./api.js";
import { flagBool, flagString, parseArgv, splitList } from "./args.js";
import { initConfig, loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { buildHistoryPlan, resolveScenarioIds } from "./history.js";
import { submitRun, waitForRun } from "./manager.js";

const USAGE = `ui-intelligence CLI

Usage:
  ui-intel init --project <key> --api <baseUrl> --repo <url> [--force]
  ui-intel history plan --window <6mo|YYYY-MM-DD..YYYY-MM-DD> [--branches main] [--max-builds N] [--scenarios all|id,id] [--offline]
  ui-intel history run --plan-id <id>
  ui-intel history submit --repo <url> --commit <sha> --scenarios id1,id2 [--manager <url>] [--project <id>] [--out file]
  ui-intel capture [--scenarios id,id] [--route /] [--out dir] [--url url] [--upload]
  ui-intel export --proposal-id <id> --out <file>
  ui-intel handoff --proposal-id <id> [--app-dir <dir>] [--base main] [--pr]
  ui-intel status [--status running]

Configuration lives in .ui-intelligence/config.json under the current directory.
`;

async function requireConfig(cwd: string): Promise<Config> {
  const config = await loadConfig(cwd);
  if (!config) {
    throw new Error("no configuration found; run `ui-intel init` first");
  }
  return config;
}

function tokenFor(config: Config | null): string {
  return config?.token || process.env.UI_INTELLIGENCE_TOKEN || "";
}

async function cmdInit(cwd: string, flags: Record<string, string | boolean>): Promise<number> {
  const project = flagString(flags, "project");
  const api = flagString(flags, "api");
  const repo = flagString(flags, "repo");
  if (!project || !api || !repo) {
    console.error("init requires --project, --api, and --repo");
    return 1;
  }
  const { configPath } = await initConfig(cwd, {
    project,
    api,
    repo,
    force: flagBool(flags, "force"),
    devUrl: flagString(flags, "url"),
  });
  console.log(`wrote ${configPath}`);
  return 0;
}

async function cmdHistoryPlan(cwd: string, flags: Record<string, string | boolean>): Promise<number> {
  const windowSpec = flagString(flags, "window");
  if (!windowSpec) {
    console.error("history plan requires --window <6mo|YYYY-MM-DD..YYYY-MM-DD>");
    return 1;
  }
  const branches = splitList(flagString(flags, "branches")) ?? [];
  const config = await loadConfig(cwd);
  const plan = await buildHistoryPlan({
    repoDir: cwd,
    repository: config?.repository ?? flagString(flags, "repo") ?? "(unknown)",
    windowSpec,
    branches: branches.length > 0 ? branches : ["main"],
    scenarioIds: resolveScenarioIds(flagString(flags, "scenarios")),
    maxBuilds: Number(flagString(flags, "max-builds") ?? "12"),
  });
  if (flagBool(flags, "offline") || !config) {
    console.log(JSON.stringify(plan, null, 2));
    console.error(
      `estimate: ${plan.estimatedCaptures} captures (uncertainty range ${plan.uncertaintyRange[0]}-${plan.uncertaintyRange[1]})`
    );
    return 0;
  }
  const result = await apiRequest(config.apiBaseUrl, tokenFor(config), "POST", `/v1/projects/${config.projectId}/history-plans`, {
    body: plan,
  });
  if (!result.ok) {
    console.error(`history plan failed (${result.status}): ${apiErrorMessage(result)}`);
    return 1;
  }
  console.log(JSON.stringify(result.body, null, 2));
  return 0;
}

async function cmdHistoryRun(cwd: string, flags: Record<string, string | boolean>): Promise<number> {
  const config = await requireConfig(cwd);
  const planId = flagString(flags, "plan-id");
  if (!planId) {
    console.error("history run requires --plan-id <id>");
    return 1;
  }
  const started = await apiRequest(
    config.apiBaseUrl,
    tokenFor(config),
    "POST",
    `/v1/projects/${config.projectId}/history-plans/${planId}/runs`
  );
  if (started.status !== 202 && !started.ok) {
    console.error(`history run failed (${started.status}): ${apiErrorMessage(started)}`);
    return 1;
  }
  const { jobId } = started.body as { jobId: string };
  console.log(`job ${jobId} started; polling until terminal (Ctrl-C detaches, the run continues server-side)`);

  const onSigint = () => {
    console.log(`\ndetached; job ${jobId} continues. Reattach with: ui-intel history run --plan-id ${planId}`);
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  try {
    for (;;) {
      const poll = await apiRequest(
        config.apiBaseUrl,
        tokenFor(config),
        "GET",
        `/v1/projects/${config.projectId}/jobs/${jobId}`
      );
      if (!poll.ok) {
        console.error(`job polling failed (${poll.status}): ${apiErrorMessage(poll)}`);
        return 1;
      }
      const job = poll.body as { status: string; stage: string; progress?: number };
      console.log(`stage=${job.stage ?? "?"} progress=${job.progress ?? "?"} status=${job.status}`);
      if (["succeeded", "failed", "cancelled"].includes(job.status)) {
        console.log(`job ${jobId} ${job.status}`);
        return job.status === "succeeded" ? 0 : 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

/**
 * `history submit` (R2 stream D): schedule a capture run on the managed
 * runner pool and poll it to completion.
 */
async function cmdHistorySubmit(cwd: string, flags: Record<string, string | boolean>): Promise<number> {
  const repo = flagString(flags, "repo");
  const commit = flagString(flags, "commit");
  const scenarios = splitList(flagString(flags, "scenarios"));
  if (!repo || !commit || scenarios.length === 0) {
    console.error("history submit requires --repo <url>, --commit <sha>, and --scenarios id1,id2");
    return 1;
  }
  const config = await loadConfig(cwd);
  const managerUrl = flagString(flags, "manager") ?? process.env.UI_INTEL_RUNNER_URL ?? "http://localhost:8900";
  const token = process.env.UI_INTEL_RUNNER_TOKEN ?? process.env.UI_INTELLIGENCE_TOKEN ?? "dev-token";
  const projectId = flagString(flags, "project") ?? config?.projectId ?? "proj_reference_app";

  let runId: string;
  try {
    runId = await submitRun({ managerUrl, token, projectId, repoUrl: repo, commitSha: commit, scenarios });
  } catch (error) {
    console.error(`history submit failed: ${(error as Error).message}`);
    return 1;
  }
  console.log(`run ${runId} submitted to ${managerUrl}; polling until terminal (Ctrl-C detaches, the run continues server-side)`);

  process.on("SIGINT", () => {
    console.log(`\ndetached; run ${runId} continues. Check with: curl -H "Authorization: Bearer ${token}" ${managerUrl}/v1/runs/${runId}`);
    process.exit(130);
  });
  try {
    const run = await waitForRun(managerUrl, token, runId, {
      onPoll: (r) => console.log(`status=${r.status} attempt=${r.attempt}`),
    });
    if (run.status === "succeeded") {
      console.log(`run ${runId} succeeded`);
      for (const r of run.results ?? []) {
        console.log(`  ${r.scenarioId}: ${r.status}${r.captureId ? ` (capture ${r.captureId})` : ` (${r.error ?? "unknown error"})`}`);
      }
    } else {
      console.error(`run ${runId} ${run.status}: ${run.error ?? "unknown error"}`);
    }
    const out = flagString(flags, "out");
    if (out) {
      const target = path.resolve(cwd, out);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(run, null, 2)}\n`, "utf8");
      console.log(`wrote ${target}`);
    }
    return run.status === "succeeded" ? 0 : 1;
  } catch (error) {
    console.error(`run polling failed: ${(error as Error).message}`);
    return 1;
  }
}

function defaultEnvironment(): CaptureEnvironment {
  return {
    runnerImageDigest: "local",
    browserRevision: "bundled-playwright",
    fontsDigest: "unknown",
    adapterVersion: "unknown",
    captureToolVersion: "1.0.0",
    redactionPolicyDigest: "pending",
  };
}

async function cmdCapture(cwd: string, flags: Record<string, string | boolean>): Promise<number> {
  const config = await loadConfig(cwd);
  const baseUrl = flagString(flags, "url") ?? config?.devUrl ?? "http://localhost:5173";
  const scenarioIds = resolveScenarioIds(flagString(flags, "scenarios"));
  const routeOverride = flagString(flags, "route");
  const commitSha = flagString(flags, "commit") ?? "unknown";
  const buildArtifactDigest = flagString(flags, "build-digest") ?? "local-dev";

  const all = standardScenarios();
  const recipes: ScenarioRecipe[] = all.filter((r) => scenarioIds.includes(r.id));
  if (recipes.length === 0) {
    console.error(`unknown scenarios: ${scenarioIds.join(", ")}. Known: ${all.map((r) => r.id).join(", ")}`);
    return 1;
  }
  if (routeOverride) {
    for (const recipe of recipes) recipe.route = routeOverride;
  }

  const runner = new ScenarioRunner({
    baseUrl,
    adapterVersion: "unknown",
    redactionPolicy: { version: "1", masks: [] },
  });
  const environment: CaptureEnvironment = {
    ...defaultEnvironment(),
    redactionPolicyDigest: await digestOf({ version: "1", masks: [] }),
  };

  for (const recipe of recipes) {
    const { manifest, screenshotBytes } = await runner.execute(recipe, {
      projectId: config?.projectId ?? "local",
      commitSha,
      buildArtifactDigest,
      environment,
    });
    const outDir = flagString(flags, "out") ?? path.join(cwd, ".ui-intelligence", "captures", manifest.captureId);
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(path.join(outDir, "screenshot.png"), screenshotBytes);
    console.log(`captured ${recipe.id} -> ${outDir} (${manifest.observations.length} observations)`);

    if (flagBool(flags, "upload")) {
      if (!config) {
        console.error("upload requires configuration; run `ui-intel init` first");
        return 1;
      }
      const uploader = new CaptureUploader();
      const { captureId } = await uploader.upload(manifest, screenshotBytes, {
        baseUrl: config.apiBaseUrl,
        token: tokenFor(config),
        projectId: config.projectId,
      });
      console.log(`uploaded capture ${captureId}`);
    }
  }
  return 0;
}

async function cmdExport(cwd: string, flags: Record<string, string | boolean>): Promise<number> {
  const config = await requireConfig(cwd);
  const proposalId = flagString(flags, "proposal-id");
  const out = flagString(flags, "out");
  if (!proposalId || !out) {
    console.error("export requires --proposal-id <id> and --out <file>");
    return 1;
  }
  const result = await apiRequest(
    config.apiBaseUrl,
    tokenFor(config),
    "GET",
    `/v1/projects/${config.projectId}/proposals/${proposalId}`
  );
  if (!result.ok) {
    console.error(`export failed (${result.status}): ${apiErrorMessage(result)}`);
    return 1;
  }
  const body = result.body as {
    acceptedCandidate?: { export?: unknown; specification?: unknown };
    export?: unknown;
  };
  const exportPayload = body.acceptedCandidate?.export ?? body.export ?? body.acceptedCandidate;
  if (exportPayload === undefined) {
    console.error("proposal has no accepted candidate to export");
    return 1;
  }
  await mkdir(path.dirname(path.resolve(cwd, out)), { recursive: true });
  await writeFile(path.resolve(cwd, out), `${JSON.stringify(exportPayload, null, 2)}\n`, "utf8");
  console.log(`wrote ${path.resolve(cwd, out)}`);
  return 0;
}

async function cmdStatus(cwd: string, flags: Record<string, string | boolean>): Promise<number> {
  const config = await requireConfig(cwd);
  const status = flagString(flags, "status") ?? "running";
  const result = await apiRequest(
    config.apiBaseUrl,
    tokenFor(config),
    "GET",
    `/v1/projects/${config.projectId}/jobs?status=${encodeURIComponent(status)}`
  );
  if (result.status === 404) {
    console.error("API unavailable");
    return 1;
  }
  if (!result.ok) {
    console.error(`status failed (${result.status}): ${apiErrorMessage(result)}`);
    return 1;
  }
  console.log(JSON.stringify(result.body, null, 2));
  return 0;
}

async function cmdHandoff(cwd: string, flags: Record<string, string | boolean>): Promise<number> {
  const { performHandoff } = await import("./handoff.js");
  const result = await performHandoff(cwd, flags);
  if ("error" in result) {
    console.error(`handoff failed: ${result.error}`);
    return 1;
  }
  console.log(`branch: ${result.branch}`);
  console.log(`file:   ${result.file}`);
  console.log(`commit: ${result.committed ? "created" : "nothing to commit (already up to date)"}`);
  if (flags.pr === true) {
    console.log(`pr:     ${result.pullRequestUrl ?? "not created (see errors above)"}`);
  }
  console.log("next:   review the branch, push it, and merge when ready");
  return result.committed || flags.pr !== true ? 0 : 1;
}

/** CLI entry point. Returns a process exit code. */
export async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgv(argv);
  const [head, sub] = command;
  const cwd = process.cwd();
  try {
    if (head === "init") return await cmdInit(cwd, flags);
    if (head === "history" && sub === "plan") return await cmdHistoryPlan(cwd, flags);
    if (head === "history" && sub === "run") return await cmdHistoryRun(cwd, flags);
    if (head === "history" && sub === "submit") return await cmdHistorySubmit(cwd, flags);
    if (head === "capture") return await cmdCapture(cwd, flags);
    if (head === "export") return await cmdExport(cwd, flags);
    if (head === "handoff") return await cmdHandoff(cwd, flags);
    if (head === "status") return await cmdStatus(cwd, flags);
    console.log(USAGE);
    return command.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    return 1;
  }
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
