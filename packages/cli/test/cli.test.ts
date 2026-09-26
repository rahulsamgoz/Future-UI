import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgv, flagString, flagBool, splitList } from "../src/args.js";
import {
  collectCommitSignals,
  inventoryCommits,
  scoreCommitSignals,
  selectCandidateCommits,
} from "../src/commits.js";
import { initConfig } from "../src/config.js";
import { estimateCaptures, resolveScenarioIds } from "../src/history.js";
import { resolveWindow } from "../src/window.js";

describe("parseArgv", () => {
  it("parses commands, flags, values, and boolean flags", () => {
    const parsed = parseArgv([
      "history",
      "plan",
      "--window",
      "6mo",
      "--branches",
      "main,dev",
      "--offline",
      "--max-builds=8",
    ]);
    expect(parsed.command).toEqual(["history", "plan"]);
    expect(flagString(parsed.flags, "window")).toBe("6mo");
    expect(flagString(parsed.flags, "branches")).toBe("main,dev");
    expect(flagBool(parsed.flags, "offline")).toBe(true);
    expect(flagString(parsed.flags, "max-builds")).toBe("8");
    expect(splitList("main, dev ,")).toEqual(["main", "dev"]);
  });
});

describe("resolveWindow", () => {
  it("resolves 6mo relative to now at plan time", () => {
    const now = new Date("2026-09-23T12:00:00.000Z");
    const { windowStart, windowEnd } = resolveWindow("6mo", now);
    expect(windowStart).toBe("2026-03-23T12:00:00.000Z");
    expect(windowEnd).toBe("2026-09-23T12:00:00.000Z");
  });

  it("resolves explicit ranges inclusively", () => {
    const { windowStart, windowEnd } = resolveWindow("2024-01-01..2024-06-30");
    expect(windowStart).toBe("2024-01-01T00:00:00.000Z");
    expect(windowEnd).toBe("2024-06-30T23:59:59.999Z");
  });

  it("rejects unknown specs", () => {
    expect(() => resolveWindow("six months")).toThrow(/invalid window/);
  });
});

describe("commit selection scoring", () => {
  function makeTempRepo(): string {
    const dir = execFileSync("mktemp", ["-d", `${tmpdir().replace(/\/$/, "")}/ui-intel-cli-XXXXXX`], {
      encoding: "utf8",
    }).trim();
    const git = (args: string[], env: Record<string, string> = {}) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
    git(["init", "-q"]);
    git(["config", "user.email", "fixture@example.com"]);
    git(["config", "user.name", "Fixture"]);
    const commit = (files: Record<string, string>, message: string, date: string) => {
      for (const [file, content] of Object.entries(files)) {
        const full = path.join(dir, file);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      git(["add", "-A"]);
      git(["commit", "-q", "-m", message], {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      });
    };
    // Small ui change, tagged as v0.1.0.
    commit({ "ui/src/app.js": "export const a = 1;\n" }, "small ui change", "2026-08-01T10:00:00 +0000");
    git(["tag", "v0.1.0"]);
    // Token change (small diff, high weight), tagged as v1.0.0.
    commit({ "src/tokens.css": "spacing: 12px;\n" }, "token change", "2026-08-02T10:00:00 +0000");
    git(["tag", "v1.0.0"]);
    // Big untagged ui change (40 files x 2 lines).
    const big: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) big[`ui/src/comp${i}.js`] = `export const c${i} = ${i};\n`;
    commit(big, "big ui change", "2026-08-03T10:00:00 +0000");
    return dir;
  }

  it("scores releases and token changes above plain diffs", () => {
    expect(
      scoreCommitSignals({ uiDiffLines: 100, tokenOrAssetChanged: false, isRelease: false })
    ).toBe(100);
    expect(
      scoreCommitSignals({ uiDiffLines: 5, tokenOrAssetChanged: true, isRelease: false })
    ).toBe(55);
    expect(
      scoreCommitSignals({ uiDiffLines: 5, tokenOrAssetChanged: false, isRelease: true })
    ).toBe(105);
  });

  it("inventories and selects candidates from a fixture git repo", () => {
    const dir = makeTempRepo();
    try {
      const commits = inventoryCommits(dir);
      expect(commits).toHaveLength(3);
      // git log lists newest first; the root commit has no parents.
      expect(commits[commits.length - 1].parents).toEqual([]);

      const signals = commits.map((c) => ({ commit: c, signals: collectCommitSignals(dir, c.sha) }));
      const selected = selectCandidateCommits(signals, 3);
      expect(selected).toHaveLength(3);
      // Tagged commits rank first; the token change outranks the small ui diff,
      // and the untagged big ui change lands last.
      expect(selected[0].kind).toBe("release");
      expect(selected[0].reason).toContain("token/style/asset");
      expect(selected[1].kind).toBe("release");
      expect(selected[2].kind).toBe("candidate");
      expect(selected[2].reason).toContain("ui/src diff lines");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("estimates captures with a ±30% uncertainty range", () => {
    // 13 builds x 12 viewport-specific recipes = 156 (closure-3 audit P3:
    // recipe ids already carry the viewport — no separate multiplier).
    const estimate = estimateCaptures(13, 12);
    expect(estimate.estimatedCaptures).toBe(156);
    expect(estimate.uncertaintyRange).toEqual([109, 203]);
  });
});

describe("resolveScenarioIds", () => {
  it("expands 'all' to the twelve standard scenario recipes (6 named scenarios x 2 viewports)", () => {
    expect(resolveScenarioIds("all")).toHaveLength(12);
    expect(resolveScenarioIds(undefined)).toHaveLength(12);
  });
  it("splits explicit ids", () => {
    expect(resolveScenarioIds("catalog-default-desktop,account-error-desktop")).toEqual([
      "catalog-default-desktop",
      "account-error-desktop",
    ]);
  });
});

describe("initConfig", () => {
  it("creates config and honors --force", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ui-intel-cfg-"));
    try {
      const first = await initConfig(cwd, {
        project: "p1",
        api: "http://localhost:4000",
        repo: "https://github.com/example/app",
        token: "t1",
        now: new Date("2026-09-23T00:00:00.000Z"),
      });
      expect(first.created).toBe(true);
      const raw = JSON.parse(await readFile(first.configPath, "utf8"));
      expect(raw.projectId).toBe("p1");
      expect(raw.createdAt).toBe("2026-09-23T00:00:00.000Z");

      await expect(
        initConfig(cwd, { project: "p2", api: "x", repo: "y" })
      ).rejects.toThrow(/--force/);

      const forced = await initConfig(cwd, {
        project: "p2",
        api: "x",
        repo: "y",
        force: true,
      });
      expect(forced.config.projectId).toBe("p2");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writes under cwd/.ui-intelligence", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ui-intel-cfg-"));
    try {
      await mkdir(path.join(cwd, "sub"), { recursive: true });
      const { configPath: written } = await initConfig(cwd, {
        project: "p",
        api: "a",
        repo: "r",
      });
      expect(written.startsWith(cwd)).toBe(true);
      expect(written).toContain(".ui-intelligence");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
