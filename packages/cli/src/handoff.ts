/**
 * Developer handoff → PR automation (R2 stream E).
 *
 * Takes an ACCEPTED proposal from the API, writes it into the app-owned
 * preference defaults file (ui-intelligence.preferences.json — app-level
 * defaults per the spec §9 precedence: app defaults < org < personal), then
 * creates a branch, commits, and opens a PR through the GitHub API using the
 * machine's git credential helper (no token handling in-process).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { apiErrorMessage, apiRequest } from "./api.js";
import { loadConfig, type Config } from "./config.js";

async function requireConfig(cwd: string): Promise<Config> {
  const config = await loadConfig(cwd);
  if (!config) throw new Error("no configuration found; run `ui-intel init` first");
  return config;
}

function tokenFor(config: Config | null): string {
  return config?.token || process.env.UI_INTELLIGENCE_TOKEN || "";
}

export const PREFERENCES_FILE = "ui-intelligence.preferences.json";

export type DefaultPreferenceEntry = {
  entityKey: string;
  scope: "entity" | "instance" | "page";
  scopeKey: string;
  representation: string;
  properties: Record<string, unknown>;
  contractVersion: number;
  requiredRendererVersions: Record<string, number>;
};

export type PreferenceDefaultsFile = {
  formatVersion: 1;
  /** App-level defaults: applied only when no org/personal preference exists. */
  defaults: DefaultPreferenceEntry[];
  provenance: { proposalId: string; acceptedAt: string; tool: string };
};

/** Read or initialize the defaults file inside the target app directory. */
export async function readDefaultsFile(appDir: string): Promise<PreferenceDefaultsFile | null> {
  try {
    const raw = await readFile(path.join(appDir, PREFERENCES_FILE), "utf8");
    return JSON.parse(raw) as PreferenceDefaultsFile;
  } catch {
    return null;
  }
}

/** Resolve where the defaults file lives: apps with a public/ dir (Vite)
 * serve it from there; other layouts keep it at the app root. */
export function defaultsFilePath(appDir: string): string {
  if (existsSync(path.join(appDir, "public"))) {
    return path.join(appDir, "public", PREFERENCES_FILE);
  }
  return path.join(appDir, PREFERENCES_FILE);
}

/** Merge new entries into the defaults file (later entries win per scopeKey). */
export async function writeDefaultsFile(
  appDir: string,
  entry: DefaultPreferenceEntry,
  provenance: PreferenceDefaultsFile["provenance"]
): Promise<string> {
  const file = defaultsFilePath(appDir);
  const existing = (await readDefaultsFile(appDir)) ?? { formatVersion: 1, defaults: [], provenance } satisfies PreferenceDefaultsFile;
  const others = existing.defaults.filter((d) => !(d.scopeKey === entry.scopeKey && d.scope === entry.scope));
  const next: PreferenceDefaultsFile = {
    formatVersion: 1,
    defaults: [...others, entry],
    provenance,
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return file;
}

function git(appDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: appDir, encoding: "utf8" }).trim();
}

export type HandoffResult = {
  branch: string;
  file: string;
  pullRequestUrl: string | null;
  committed: boolean;
};

/**
 * Perform the handoff: fetch the accepted proposal, write the default entry,
 * branch + commit, and (when --pr is set and the remote is GitHub) open a PR
 * via `gh`. Returns what happened so callers can report honestly.
 */
export async function performHandoff(
  cwd: string,
  flags: Record<string, string | boolean>,
  deps: {
    apiRequestFn?: typeof apiRequest;
    execGit?: (dir: string, args: string[]) => string;
    openPr?: (dir: string, branch: string, title: string, body: string, base: string) => Promise<string | null>;
  } = {}
): Promise<HandoffResult | { error: string }> {
  const config = await requireConfig(cwd);
  const proposalId = typeof flags["proposal-id"] === "string" ? flags["proposal-id"] : "";
  if (!proposalId) return { error: "--proposal-id is required" };
  const appDir = typeof flags["app-dir"] === "string" ? flags["app-dir"] : cwd;
  const base = typeof flags.base === "string" ? flags.base : "main";
  const wantPr = flags.pr === true;

  const request = deps.apiRequestFn ?? apiRequest;
  const result = await request(
    config.apiBaseUrl,
    tokenFor(config),
    "GET",
    `/v1/projects/${config.projectId}/proposals/${proposalId}`
  );
  if (!result.ok) return { error: `proposal fetch failed (${result.status}): ${apiErrorMessage(result)}` };
  const body = result.body as {
    status?: string;
    acceptedCandidateId?: string;
    acceptedCandidate?: {
      export?: { presentation?: { type?: string; properties?: Record<string, unknown> } };
      target?: { entityKey?: string; scope?: string };
      requiredRendererVersions?: Record<string, number>;
    };
    candidates?: Array<{
      candidateId?: string;
      presentation?: { type?: string; properties?: Record<string, unknown> };
    }>;
  };
  // Two response shapes: a full acceptedCandidate object, or an
  // acceptedCandidateId pointing into the candidates list. When only the id
  // is present, target identity comes from the export endpoint (which wraps
  // the payload in a JSON `contents` string).
  let candidate: {
    export?: { presentation?: { type?: string; properties?: Record<string, unknown> } };
    presentation?: { type?: string; properties?: Record<string, unknown> };
    target?: { entityKey?: string; scope?: string };
    requiredRendererVersions?: Record<string, number>;
  } | undefined = body.acceptedCandidate;
  if (!candidate && body.acceptedCandidateId) {
    const found = body.candidates?.find((c) => c.candidateId === body.acceptedCandidateId);
    let target: { entityKey?: string; scope?: string } | undefined;
    let requiredRendererVersions: Record<string, number> | undefined;
    const exportRes = await request(
      config.apiBaseUrl,
      tokenFor(config),
      "POST",
      `/v1/projects/${config.projectId}/proposals/${proposalId}/export`
    );
    if (exportRes.ok) {
      const exportBody = exportRes.body as { contents?: string };
      let unwrapped: Record<string, unknown> = exportRes.body as Record<string, unknown>;
      if (typeof exportBody.contents === "string") {
        try {
          unwrapped = JSON.parse(exportBody.contents) as Record<string, unknown>;
        } catch {
          // keep wrapped
        }
      }
      target = unwrapped.target as { entityKey?: string; scope?: string } | undefined;
      requiredRendererVersions = unwrapped.requiredRendererVersions as Record<string, number> | undefined;
    }
    if (found?.presentation) {
      candidate = { presentation: found.presentation, target, requiredRendererVersions };
    }
  }
  if (!candidate) return { error: "proposal has no accepted candidate — accept it first (POST /proposals/:id/accept)" };
  const presentation = candidate.export?.presentation ?? candidate.presentation ?? {};
  const type = presentation.type;
  if (!type) return { error: "accepted candidate has no presentation type" };
  const entityKey = candidate.target?.entityKey ?? "unknown";
  const scope = (candidate.target?.scope as DefaultPreferenceEntry["scope"]) ?? "entity";

  const file = await writeDefaultsFile(
    appDir,
    {
      entityKey,
      scope,
      scopeKey: entityKey,
      representation: type,
      properties: presentation.properties ?? {},
      contractVersion: 1,
      requiredRendererVersions: candidate.requiredRendererVersions ?? {},
    },
    { proposalId, acceptedAt: new Date().toISOString(), tool: "ui-intel handoff" }
  );

  const run = deps.execGit ?? git;
  const branch = `vorflux/handoff/${proposalId}`;
  run(appDir, ["checkout", "-q", "-B", branch, base]);
  run(appDir, ["add", "--", path.relative(appDir, file) || PREFERENCES_FILE]);
  void file;
  const committed = (() => {
    try {
      run(appDir, ["commit", "-q", "-m", `chore(ui-intelligence): apply accepted proposal ${proposalId} as app default (${type})`]);
      return true;
    } catch {
      // Nothing to commit (identical default already present).
      return false;
    }
  })();

  let pullRequestUrl: string | null = null;
  let pushError: string | null = null;
  if (wantPr && committed) {
    // The branch must exist on the remote before a PR can reference it.
    try {
      run(appDir, ["push", "-q", "-u", "origin", branch]);
    } catch (error) {
      pushError = error instanceof Error ? error.message : String(error);
    }
  }
  if (wantPr && committed && !pushError) {
    const opener =
      deps.openPr ??
      (async (dir, br, title, prBody, baseBranch) => {
        const url = run(dir, ["remote", "get-url", "origin"]).replace(/\.git$/, "");
        const out = execFileSync(
          "gh",
          ["pr", "create", "--repo", url, "--head", br, "--base", baseBranch, "--title", title, "--body", prBody],
          { cwd: dir, encoding: "utf8" }
        ).trim();
        return out.split("\n")[0] || null;
      });
    pullRequestUrl = await opener(
      appDir,
      branch,
      `UI Intelligence: apply accepted proposal ${proposalId}`,
      `Applies the accepted proposal **${proposalId}** as an app-level default preference (${type} for \`${entityKey}\`).\n\n- Source: API proposal ${proposalId}\n- File: ${PREFERENCES_FILE}\n- Precedence: app default < org < personal (explicit user preferences still win)\n\nGenerated by \`ui-intel handoff\`.`,
      base
    );
  }

  if (pushError) {
    return { error: `branch ${branch} committed but push failed: ${pushError} (push manually, then open the PR)` };
  }
  return { branch, file, pullRequestUrl, committed };
}
