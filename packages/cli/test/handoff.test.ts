/**
 * R2 stream E: developer handoff — writes accepted proposals into the
 * app-owned defaults file, branches, commits, and opens a PR.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { performHandoff, readDefaultsFile, writeDefaultsFile, PREFERENCES_FILE, type PreferenceDefaultsFile } from "../src/handoff.js";
import type { ApiResult } from "../src/api.js";

function makeRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "handoff-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  require("node:fs").writeFileSync(join(dir, "README.md"), "demo app\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  // CLI config so requireConfig passes.
  require("node:fs").mkdirSync(join(dir, ".ui-intelligence"), { recursive: true });
  require("node:fs").writeFileSync(
    join(dir, ".ui-intelligence/config.json"),
    JSON.stringify({ projectKey: "reference-app", projectId: "reference-app", apiBaseUrl: "http://api.test", token: "dev-token", repository: "x", createdAt: "2026-01-01" })
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const acceptedProposal: ApiResult = {
  ok: true,
  status: 200,
  body: {
    status: "ready",
    acceptedCandidate: {
      target: { entityKey: "catalog.productChooser", scope: "entity" },
      requiredRendererVersions: { "grid@1": 1 },
      export: { presentation: { type: "grid@1", properties: { columns: 3, density: "comfortable" } } },
    },
  },
} as unknown as ApiResult;

describe("developer handoff (R2 stream E)", () => {
  let repo: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("writes the accepted candidate into the app defaults file", async () => {
    const result = await performHandoff(repo.dir, { "proposal-id": "prop_1" }, {
      apiRequestFn: async () => acceptedProposal,
      execGit: (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim(),
      openPr: async () => null,
    });
    expect("error" in result ? result.error : result.committed).toBe(true);
    const file = readFileSync(join(repo.dir, PREFERENCES_FILE), "utf8");
    const parsed = JSON.parse(file) as PreferenceDefaultsFile;
    expect(parsed.defaults).toHaveLength(1);
    expect(parsed.defaults[0].representation).toBe("grid@1");
    expect(parsed.defaults[0].entityKey).toBe("catalog.productChooser");
    expect(parsed.defaults[0].properties).toEqual({ columns: 3, density: "comfortable" });
    expect(parsed.provenance.proposalId).toBe("prop_1");
  });

  it("creates a branch and commits", async () => {
    const result = await performHandoff(repo.dir, { "proposal-id": "prop_2" }, {
      apiRequestFn: async () => acceptedProposal,
      execGit: (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim(),
      openPr: async () => null,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.branch).toBe("vorflux/handoff/prop_2");
    expect(result.committed).toBe(true);
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo.dir, encoding: "utf8" }).trim();
    expect(branch).toBe("vorflux/handoff/prop_2");
  });

  it("opens a PR when --pr is set", async () => {
    const result = await performHandoff(repo.dir, { "proposal-id": "prop_3", pr: true }, {
      apiRequestFn: async () => acceptedProposal,
      execGit: (dir, args) => {
        // The temp repo has no origin; stub the push the CLI performs
        // before opening a PR.
        if (args[0] === "push") return "";
        return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
      },
      openPr: async (_dir, branch) => `https://github.com/example/repo/pull/99?branch=${branch}`,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.pullRequestUrl).toContain("https://github.com/example/repo/pull/99");
    expect(result.pullRequestUrl).toContain("vorflux/handoff/prop_3");
  });

  it("fails clearly when the proposal has no accepted candidate", async () => {
    const result = await performHandoff(repo.dir, { "proposal-id": "prop_4" }, {
      apiRequestFn: async () => ({ ok: true, status: 200, body: { status: "ready" } }) as unknown as ApiResult,
      execGit: (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim(),
      openPr: async () => null,
    });
    expect("error" in result && result.error).toContain("no accepted candidate");
  });

  it("defaults file round-trips and later entries replace same scope", async () => {
    await writeDefaultsFile(repo.dir, {
      entityKey: "a", scope: "entity", scopeKey: "a", representation: "grid@1",
      properties: {}, contractVersion: 1, requiredRendererVersions: {},
    }, { proposalId: "p1", acceptedAt: "t", tool: "t" });
    await writeDefaultsFile(repo.dir, {
      entityKey: "a", scope: "entity", scopeKey: "a", representation: "table@1",
      properties: {}, contractVersion: 1, requiredRendererVersions: {},
    }, { proposalId: "p2", acceptedAt: "t", tool: "t" });
    const file = await readDefaultsFile(repo.dir);
    expect(file?.defaults).toHaveLength(1);
    expect(file?.defaults[0].representation).toBe("table@1");
  });
});
