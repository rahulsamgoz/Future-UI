/**
 * History plan construction (architecture section 10): window resolution,
 * commit inventory without code execution, candidate scoring, and capture
 * estimates with an uncertainty range.
 */
import { standardScenarios } from "@ui-intelligence/capture";
import type { HistoryPlanInput } from "@ui-intelligence/protocol";
import {
  collectCommitSignals,
  inventoryCommits,
  selectCandidateCommits,
} from "./commits.js";
import type { CommitInfo, ScoredCommit } from "./commits.js";
import { resolveWindow } from "./window.js";

export type HistoryPlanArgs = {
  repoDir: string;
  repository: string;
  windowSpec: string;
  branches: string[];
  scenarioIds: string[];
  maxBuilds: number;
  timezone?: string;
  renderBudgetMs?: number;
  /** Optional local fixture repo carried through to the plan input. */
  fixtureRepo?: string;
  now?: Date;
};

export type HistoryPlanEstimate = {
  /** Planned capture slots: selectedBuilds x selected recipes (recipe ids are already viewport-specific). */
  estimatedCaptures: number;
  /** Plus/minus 30 percent uncertainty range around the estimate. */
  uncertaintyRange: [number, number];
};

export type LocalHistoryPlan = {
  input: HistoryPlanInput;
  resolvedTips: Array<{ branch: string; commitSha: string }>;
  selectedCommits: Array<{ commitSha: string; reason: string; kind: "release" | "candidate" | "artifact_available" }>;
  estimatedCaptures: number;
  uncertaintyRange: [number, number];
  status: "draft";
  createdAt: string;
};

export function estimateCaptures(selectedBuilds: number, scenarioCount: number): HistoryPlanEstimate {
  // Scenario ids are viewport-specific, so each selected recipe is one capture
  // per commit (closure-3 audit P3 — the old viewport multiplier double-counted).
  const estimatedCaptures = selectedBuilds * scenarioCount;
  return {
    estimatedCaptures,
    uncertaintyRange: [
      Math.max(0, Math.floor(estimatedCaptures * 0.7)),
      Math.ceil(estimatedCaptures * 1.3),
    ],
  };
}

/** Resolve scenario ids: "all" expands to the standard reference scenarios. */
export function resolveScenarioIds(spec: string | undefined): string[] {
  if (!spec || spec === "all") return standardScenarios().map((s) => s.id);
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function buildHistoryPlan(args: HistoryPlanArgs): Promise<LocalHistoryPlan> {
  const { windowStart, windowEnd } = resolveWindow(args.windowSpec, args.now);
  const branches = args.branches.length > 0 ? args.branches : ["main"];
  const resolveTip = (branch: string): string => {
    try {
      return inventoryCommits(args.repoDir, [branch])[0]?.sha ?? "";
    } catch {
      return ""; // branch not present in this checkout
    }
  };
  const tips = branches.map((branch) => ({ branch, commitSha: resolveTip(branch) }));
  const commits: CommitInfo[] = inventoryCommits(args.repoDir, [...branches, "HEAD"]);
  const windowStartMs = Date.parse(windowStart);
  const windowEndMs = Date.parse(windowEnd);
  const inWindow = commits.filter((commit) => {
    const t = Date.parse(commit.date);
    return t >= windowStartMs && t <= windowEndMs;
  });
  const scored: ScoredCommit[] = inWindow.map((commit) => ({
    ...commit,
    signals: collectCommitSignals(args.repoDir, commit.sha),
  }));
  const selected = selectCandidateCommits(scored, args.maxBuilds);
  const scenarioIds = args.scenarioIds.length > 0 ? args.scenarioIds : resolveScenarioIds("all");
  const { estimatedCaptures, uncertaintyRange } = estimateCaptures(selected.length, scenarioIds.length);
  return {
    input: {
      repository: args.repository,
      branches,
      windowStart,
      windowEnd,
      scenarioIds,
      maxBuilds: args.maxBuilds,
      renderBudgetMs: args.renderBudgetMs ?? 600_000,
      timezone: args.timezone ?? "UTC",
      ...(args.fixtureRepo ? { fixtureRepo: args.fixtureRepo } : {}),
    },
    resolvedTips: tips,
    selectedCommits: selected,
    estimatedCaptures,
    uncertaintyRange,
    status: "draft",
    createdAt: (args.now ?? new Date()).toISOString(),
  };
}
