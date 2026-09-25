import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const generatorPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../generate.mjs");

const EXPECTED_MESSAGES = [
  "initial catalog with carousel",
  "rename ProductCarousel to ProductChooser",
  "move ProductChooser into features/catalog/",
  "style-only refactor of chooser",
  "global spacing token change",
  "add grid renderer",
  "repeated instances: add related-products chooser",
  "split: product chooser splits into chooser + sort control",
  "merge: sort control merged back",
  "carousel → grid default",
  "revert to carousel default",
  "intentionally unbuildable revision (INTENTIONALLY_UNBUILDABLE)",
  "fix build again",
];

function generate(): string {
  const dir = execFileSync("mktemp", ["-d", `${tmpdir().replace(/\/$/, "")}/ui-intel-hist-XXXXXX`], {
    encoding: "utf8",
  }).trim();
  execFileSync("node", [generatorPath, dir], { encoding: "utf8" });
  return dir;
}

const git = (dir: string, args: string) =>
  execFileSync("sh", ["-c", `git "$@"`, "git", ...args.split(" ").filter((a) => a.length > 0)], {
    cwd: dir,
    encoding: "utf8",
  });

describe("history fixture generator", () => {
  it("creates exactly 13 commits with the expected messages in order", () => {
    const dir = generate();
    try {
      expect(git(dir, "rev-list --count HEAD")).toBe("13\n");
      const messages = git(dir, "log --reverse --format=%s").trim().split("\n");
      expect(messages).toEqual(EXPECTED_MESSAGES);
    } finally {
      rm(dir, { recursive: true, force: true });
    }
  });

  it("marks commit 12 unbuildable in ground truth", async () => {
    const dir = generate();
    try {
      const groundTruth = JSON.parse(await readFile(path.join(dir, "ground-truth.json"), "utf8"));
      expect(groundTruth.corpus.plannedCaptureSlots).toBe(156);
      const unbuildable = groundTruth.commits.filter((c: { buildOutcome: string }) => c.buildOutcome === "unbuildable");
      expect(unbuildable).toHaveLength(1);
      expect(unbuildable[0].commit).toBe(12);
      expect(unbuildable[0].message).toContain("INTENTIONALLY_UNBUILDABLE");
    } finally {
      rm(dir, { recursive: true, force: true });
    }
  });

  it("ground-truth anchors match the file contents at each commit", async () => {
    const dir = generate();
    try {
      const groundTruth = JSON.parse(await readFile(path.join(dir, "ground-truth.json"), "utf8"));
      const shas = git(dir, "log --reverse --format=%H").trim().split("\n");
      for (const entry of groundTruth.commits) {
        const sha = shas[entry.commit - 1];
        const grep = execFileSync(
          "sh",
          ["-c", `git grep -h -o 'data-ui-entity="[^"]*"' "$1" | sort -u`, "git", sha],
          { cwd: dir, encoding: "utf8" }
        );
        const found = Array.from(grep.matchAll(/data-ui-entity="([^"]*)"/g)).map((m) => m[1]);
        for (const anchor of entry.anchors) {
          expect(found, `commit ${entry.commit} (${entry.message}) missing anchor ${anchor}`).toContain(anchor);
        }
      }
      // Commit 12 source contains the intentional failure marker and throws on load.
      const sha12 = shas[11];
      const appJs = execFileSync("sh", ["-c", `git show "$1":app.js`, "git", sha12], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(appJs).toContain("INTENTIONALLY_UNBUILDABLE");
      expect(appJs).toContain('throw new Error("intentionally unbuildable")');
    } finally {
      rm(dir, { recursive: true, force: true });
    }
  });
});
