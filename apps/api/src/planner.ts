/**
 * History planning (spec section 10). Resolves relative windows to concrete
 * dates and records explicit tips and limits before execution. The dev
 * profile selects registered commits in the window; estimates use a ±30%
 * uncertainty range (no pilot data).
 */
import { newId, UiIntelligenceError, type HistoryPlanInput, type HistoryPlanRecord } from "@ui-intelligence/protocol";
import { standardScenarios } from "@ui-intelligence/capture";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "./db.js";
import { nowIso } from "./db.js";
import { insertHistoryPlan } from "./store.js";

export const ESTIMATE_UNCERTAINTY = 0.3;

/**
 * Allowlist of directories a history plan's fixtureRepo may point at (audit
 * finding 3a: an arbitrary-path read must not be possible through plan input).
 * Configured via UI_INTEL_RECONSTRUCT_ROOTS (path-delimiter separated);
 * defaults to the repo root (server cwd) plus the OS temp dir, so dev-profile
 * fixture corpora resolve while paths like /etc or other users' directories
 * are rejected.
 */
export function reconstructRoots(): string[] {
  const configured = process.env.UI_INTEL_RECONSTRUCT_ROOTS;
  if (configured && configured.trim().length > 0) {
    return configured
      .split(path.delimiter)
      .map((root) => path.resolve(root.trim()))
      .filter((root) => root.length > 0);
  }
  return [path.resolve(process.cwd()), path.resolve(tmpdir())];
}

/**
 * Validate + resolve a plan input's fixtureRepo: it must resolve to an
 * EXISTING directory inside one of the reconstruct roots. Returns the
 * resolved absolute path for persistence. Throws SCHEMA_INVALID (422) when
 * the path escapes the allowlist, points at a missing/non-directory path, or
 * names a remote repository (remote clones are not configured in the dev
 * profile).
 */
export function resolveFixtureRepo(raw: string): string {
  const fail = (message: string) =>
    new UiIntelligenceError("SCHEMA_INVALID", `fixtureRepo rejected: ${message}`, { httpStatus: 422 });
  if (/^[a-z]+:\/\//i.test(raw) || raw.startsWith("git@")) {
    throw fail("remote repositories are not supported; pass a local path");
  }
  const resolved = path.resolve(raw);
  const insideRoot = reconstructRoots().some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
  if (!insideRoot) {
    throw fail(
      `${resolved} is outside the configured reconstruct roots (UI_INTEL_RECONSTRUCT_ROOTS)`,
    );
  }
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw fail(`${resolved} does not exist`);
  }
  if (!stats.isDirectory()) {
    throw fail(`${resolved} is not a directory`);
  }
  return resolved;
}

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

  // Resolve scenarioIds: empty/absent means "all" standard scenarios; otherwise
  // validate every id against the known set and reject unknowns with 422.
  const allScenarioIds = standardScenarios().map((r) => r.id);
  const resolvedScenarioIds =
    !input.scenarioIds || input.scenarioIds.length === 0
      ? allScenarioIds
      : input.scenarioIds;
  const unknownIds = resolvedScenarioIds.filter((id) => !allScenarioIds.includes(id));
  if (unknownIds.length > 0) {
    throw new UiIntelligenceError(
      "SCHEMA_INVALID",
      `unknown scenarioIds: ${unknownIds.join(", ")}. Known: ${allScenarioIds.join(", ")}`,
      { httpStatus: 422 },
    );
  }
  // Deduplicate while preserving order.
  const uniqueScenarioIds = [...new Set(resolvedScenarioIds)];

  const builds = selectedCommits.length;
  // One capture per (commit, selected recipe): scenario ids are already
  // viewport-specific (catalog-default-desktop vs -mobile), so no per-viewport
  // multiplier (closure-3 audit P3 — the old ×2 double-counted every recipe).
  const estimatedCaptures = builds * uniqueScenarioIds.length;
  const normalizedInput: HistoryPlanInput = {
    ...input,
    scenarioIds: uniqueScenarioIds,
  };
  const record: HistoryPlanRecord = {
    planId: newId("plan"),
    input: normalizedInput,
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
