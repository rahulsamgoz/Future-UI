/** Commit inventory and candidate selection (architecture section 10). */
import { spawnSync } from "node:child_process";

export type CommitInfo = {
  sha: string;
  /** Author date, ISO-8601. */
  date: string;
  parents: string[];
};

/** Signals used to rank commits; no repository code is executed. */
export type CommitSignals = {
  /** Changed lines under ui/src paths. */
  uiDiffLines: number;
  /** Token, style, or asset files changed (broader visual impact). */
  tokenOrAssetChanged: boolean;
  /** Commit is contained in a git tag (release preference). */
  isRelease: boolean;
};

export type ScoredCommit = CommitInfo & { signals: CommitSignals };

export type SelectedCommit = {
  commitSha: string;
  reason: string;
  kind: "release" | "candidate";
};

export function runGit(repoDir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout;
}

/** Inventory reachable commits without executing repository code. */
export function inventoryCommits(repoDir: string, branches: string[] = ["HEAD"]): CommitInfo[] {
  for (const branch of branches) {
    try {
      return parseCommitLog(runGit(repoDir, ["log", "--format=%H|%ad|%P", "--date=iso-strict", branch]));
    } catch (error) {
      if (branch === branches[branches.length - 1]) throw error;
    }
  }
  return [];
}

function parseCommitLog(output: string): CommitInfo[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, date, parentList] = line.split("|");
      return {
        sha,
        date,
        parents: (parentList ?? "").split(" ").filter((p) => p.length > 0),
      };
    });
}

const UI_SRC_PATTERN = /(^|\/)ui\/src\//;
const TOKEN_OR_ASSET_PATTERN = /(^|\/)(tokens?[./]|.*\.css$|.*\.scss$|.*\.(svg|png|jpg|jpeg|gif|webp|woff2?)$)|(^|\/)assets\//;

/** Diff signals for one commit (numstat + tag containment). */
export function collectCommitSignals(repoDir: string, sha: string): CommitSignals {
  const numstat = runGit(repoDir, ["show", "--numstat", "--format=", sha]);
  let uiDiffLines = 0;
  let tokenOrAssetChanged = false;
  for (const line of numstat.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const filePath = parts.slice(2).join("\t");
    const added = Number(parts[0]);
    const deleted = Number(parts[1]);
    const lines = (Number.isFinite(added) ? added : 0) + (Number.isFinite(deleted) ? deleted : 0);
    if (UI_SRC_PATTERN.test(filePath)) uiDiffLines += lines;
    if (TOKEN_OR_ASSET_PATTERN.test(filePath)) tokenOrAssetChanged = true;
  }
  const tagOutput = runGit(repoDir, ["tag", "--contains", sha]);
  return {
    uiDiffLines,
    tokenOrAssetChanged,
    isRelease: tagOutput.trim().length > 0,
  };
}

/** Rank commits: releases first, then token/asset changes, then diff size in ui/src. */
export function scoreCommitSignals(signals: CommitSignals): number {
  return (
    signals.uiDiffLines +
    (signals.tokenOrAssetChanged ? 50 : 0) +
    (signals.isRelease ? 100 : 0)
  );
}

/** Select up to maxBuilds candidate commits, best score first. */
export function selectCandidateCommits(scored: ScoredCommit[], maxBuilds: number): SelectedCommit[] {
  return [...scored]
    .sort((a, b) => scoreCommitSignals(b.signals) - scoreCommitSignals(a.signals) || a.date.localeCompare(b.date))
    .slice(0, Math.max(0, maxBuilds))
    .map((commit) => {
      const { signals } = commit;
      const parts: string[] = [];
      if (signals.isRelease) parts.push("tagged release");
      if (signals.tokenOrAssetChanged) parts.push("token/style/asset change");
      if (signals.uiDiffLines > 0) parts.push(`${signals.uiDiffLines} ui/src diff lines`);
      const reason = parts.length > 0 ? parts.join(", ") : "traversal coverage";
      return {
        commitSha: commit.sha,
        reason,
        kind: signals.isRelease ? ("release" as const) : ("candidate" as const),
      };
    });
}
