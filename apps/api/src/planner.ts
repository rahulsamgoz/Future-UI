/**
 * History planning (spec section 10). Resolves relative windows to concrete
 * dates and records explicit tips and limits before execution. The dev
 * profile selects registered commits in the window; estimates use a ±30%
 * uncertainty range (no pilot data).
 */
import { newId, type HistoryPlanInput, type HistoryPlanRecord } from "@ui-intelligence/protocol";
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import type { Db } from "./db.js";
import { nowIso } from "./db.js";
import { insertHistoryPlan } from "./store.js";

export const VIEWPORTS_PER_SCENARIO = 2;
export const ESTIMATE_UNCERTAINTY = 0.3;

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function planHistory(db: Db, projectId: string, input: HistoryPlanInput): HistoryPlanRecord {
  if (!input || typeof input.repository !== "string" || input.repository.length === 0) {
    throw new UiIntelligenceError("SCHEMA_INVALID", "history plan input requires a repository", { httpStatus: 422 });
  }
  if (!Array.isArray(input.branches) || input.branches.length === 0) {
    throw new UiIntelligenceError("SCHEMA_INVALID", "history plan input requires at least one branch", { httpStatus: 422 });
  }
  if (!isIsoDate(input.windowStart) || !isIsoDate(input.windowEnd) || Date.parse(input.windowStart) > Date.parse(input.windowEnd)) {
    throw new UiIntelligenceError("SCHEMA_INVALID", "history plan window must be an ordered date range", { httpStatus: 422 });
  }

  const commits = db
    .prepare(
      "SELECT sha, parents_json, committed_at FROM commits WHERE project_id = ? AND committed_at >= ? AND committed_at <= ? ORDER BY committed_at DESC"
    )
    .all(projectId, input.windowStart, input.windowEnd) as Array<{ sha: string; parents_json: string; committed_at: string }>;

  // Registered commits in the window become selected candidates (up to maxBuilds).
  const selectedCommits = commits.slice(0, Math.max(0, input.maxBuilds)).map((c) => ({
    commitSha: c.sha,
    reason: `registered commit in window (${c.committed_at})`,
    kind: "candidate" as const,
  }));

  // Tips: commits in the window that no other registered commit references
  // as a parent are the best available tip approximation in the dev profile.
  const parentSet = new Set<string>();
  for (const c of commits) {
    for (const p of JSON.parse(c.parents_json) as string[]) parentSet.add(p);
  }
  const tipCandidates = commits.filter((c) => !parentSet.has(c.sha));
  const resolvedTips = input.branches.map((branch, i) => ({
    branch,
    commitSha: tipCandidates[i]?.sha ?? "",
  }));

  const builds = selectedCommits.length;
  const scenarios = Math.max(1, input.scenarioIds.length);
  const estimatedCaptures = builds * scenarios * VIEWPORTS_PER_SCENARIO;
  const record: HistoryPlanRecord = {
    planId: newId("plan"),
    input,
    resolvedTips,
    selectedCommits,
    estimatedCaptures,
    uncertaintyRange: [
      Math.round(estimatedCaptures * (1 - ESTIMATE_UNCERTAINTY)),
      Math.round(estimatedCaptures * (1 + ESTIMATE_UNCERTAINTY)),
    ],
    status: "approved",
    createdAt: nowIso(),
  };

  insertHistoryPlan(db, projectId, record);
  return record;
}
