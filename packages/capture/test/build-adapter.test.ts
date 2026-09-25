/**
 * Build-adapter hardening tests (closure-2 review): manifest validation,
 * worktree containment, quoted command splitting, and cleanup on
 * build/serve setup failure.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readHistoryManifest, reconstructCommit, splitCommand } from "../src/index.js";

function reconstructTempRoots(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("ui-intel-reconstruct-")));
}

function makeRepo(files: Record<string, string>): { repoDir: string; commitSha: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "ui-intel-build-adapter-repo-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git(["init", "-q"]);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(repoDir, name), content);
  }
  git(["add", "-A"]);
  git(["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "fixture"]);
  const commitSha = git(["rev-parse", "HEAD"]).toString().trim();
  return { repoDir, commitSha };
}

const FAKE_API = { baseUrl: "http://127.0.0.1:1", token: "t", projectId: "p" };

describe("splitCommand", () => {
  it("splits on whitespace and preserves quoted arguments", () => {
    expect(splitCommand("npm ci")).toEqual(["npm", "ci"]);
    expect(splitCommand("npm run \"build script\"")).toEqual(["npm", "run", "build script"]);
    expect(splitCommand("node -e 'process.exit(7)'")).toEqual(["node", "-e", "process.exit(7)"]);
    expect(splitCommand("  npm   run  build  ")).toEqual(["npm", "run", "build"]);
  });

  it("rejects unterminated quotes and empty commands with clear errors", () => {
    expect(() => splitCommand('node -e "oops')).toThrow(/unterminated quote/);
    expect(() => splitCommand("   ")).toThrow(/empty command/);
  });
});

describe("readHistoryManifest validation", () => {
  it("returns undefined when the manifest is absent or unparseable", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-manifest-"));
    expect(readHistoryManifest(dir)).toBeUndefined();
    writeFileSync(join(dir, "ui-intel.history.json"), "{not json");
    expect(readHistoryManifest(dir)).toBeUndefined();
  });

  it("rejects malformed manifests with clear errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-manifest-"));
    writeFileSync(join(dir, "ui-intel.history.json"), JSON.stringify(["not", "an", "object"]));
    expect(() => readHistoryManifest(dir)).toThrow(/must be a JSON object/);

    writeFileSync(
      join(dir, "ui-intel.history.json"),
      JSON.stringify({ buildAdapter: { timeoutMs: "infinite" } }),
    );
    expect(() => readHistoryManifest(dir)).toThrow(/buildAdapter\.timeoutMs must be a positive finite number/);

    writeFileSync(
      join(dir, "ui-intel.history.json"),
      JSON.stringify({ buildAdapter: { appDir: 42 } }),
    );
    expect(() => readHistoryManifest(dir)).toThrow(/buildAdapter\.appDir must be a string/);
  });
});

describe("build adapter safety", () => {
  it("rejects a manifest whose appDir escapes the worktree, and still cleans up", async () => {
    const before = reconstructTempRoots();
    const { repoDir, commitSha } = makeRepo({
      "index.html": "<html><body>hi</body></html>",
      "ui-intel.history.json": JSON.stringify({ buildAdapter: { appDir: "../.." } }),
    });

    await expect(
      reconstructCommit({ repoDir, commitSha, scenarios: ["catalog-default-desktop"], api: FAKE_API }),
    ).rejects.toThrow(/escapes the reconstruction worktree/);

    // The materialized worktree must be gone despite the setup failure.
    const leaked = [...reconstructTempRoots()].filter((name) => !before.has(name));
    expect(leaked).toEqual([]);
  });

  it("cleans up the worktree when the build command fails", async () => {
    const before = reconstructTempRoots();
    const { repoDir, commitSha } = makeRepo({
      "index.html": "<html><body>hi</body></html>",
      // install is a no-op; build fails — quoted arg exercises splitCommand too.
      "ui-intel.history.json": JSON.stringify({
        buildAdapter: {
          installCommand: "node --version",
          buildCommand: 'node -e "process.exit(7)"',
        },
      }),
    });

    await expect(
      reconstructCommit({ repoDir, commitSha, scenarios: ["catalog-default-desktop"], api: FAKE_API }),
    ).rejects.toThrow(/failed/);

    const leaked = [...reconstructTempRoots()].filter((name) => !before.has(name));
    expect(leaked).toEqual([]);
  });
});
