/**
 * Lineage ground-truth evaluation (spec section 19, lineage row): labeled
 * move, repeat, split/merge, and reversion cases behave correctly; uncertainty
 * is recorded. Evidence: ground-truth pairings, false-match and abstention
 * counts.
 *
 * The evaluation runs the fixture generator (fixtures/history/generate.mjs,
 * 13 commits) into a temp repository, extracts per-commit boundary elements
 * (explicit anchors + visible-text evidence from the source at each commit via
 * `git show`), and runs `lineageCandidates` over every consecutive pair. Each
 * candidate is classified against the ground-truth expectations encoded by the
 * fixture's own labels; counts are printed to stdout.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { lineageCandidates, type LineageSide } from "@ui-intelligence/indexing";

const generatorPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "generate.mjs");

let repoDir = "";

beforeAll(async () => {
  repoDir = await mkdtemp(path.join(tmpdir(), "ui-intel-lineage-eval-"));
  execFileSync("node", [generatorPath, repoDir]);
});

afterAll(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
});

const git = (args: string[]): string => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

/**
 * Extract boundary elements from the source at a commit: every
 * data-ui-entity anchor with its visible-text evidence (aria-label plus the
 * inline text between tags — source keywords on the same line are not visible
 * text and are excluded). Occurrences of the same anchor merge their distinct
 * texts, so repeated instances stay one lineage element. A textless boundary
 * (e.g. a bare container div) keeps its anchor with empty text.
 */
function elementsAt(sha: string): LineageSide {
  const files = git(["ls-tree", "-r", "--name-only", sha])
    .split("\n")
    .filter((f) => /\.(js|tsx|jsx|css|html)$/.test(f));
  const textsByAnchor = new Map<string, Set<string>>();
  for (const file of files) {
    const source = git(["show", `${sha}:${file}`]);
    for (const line of source.split("\n")) {
      const anchor = line.match(/data-ui-entity="([^"]+)"/)?.[1];
      if (!anchor) continue;
      if (!textsByAnchor.has(anchor)) textsByAnchor.set(anchor, new Set());
      const aria = line.match(/aria-label="([^"]*)"/)?.[1] ?? "";
      let body = "";
      for (const m of line.matchAll(/>([^<>]*)</g)) body += ` ${m[1]}`;
      const tail = line.match(/>([^<>]*)$/);
      if (tail) body += ` ${tail[1]}`;
      const text = `${aria} ${body}`
        .replace(/\$\{/g, " ")
        .replace(/\}/g, " ") // keep template identifiers as text tokens
        .replace(/&[a-z]+;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) textsByAnchor.get(anchor)!.add(text);
    }
  }
  const anchors = [...textsByAnchor.keys()].sort();
  return {
    commitSha: sha,
    anchors,
    texts: anchors.map((a) => [...textsByAnchor.get(a)!].sort().join(" ")),
  };
}

/** Ground-truth expectations implied by the fixture's own commit labels. */
// The catalog page and the account route (profile form + save button) continue
// through every commit; the account admin panel boundary exists from the split
// commit (8) onward.
const CONTINUING_ANCHORS = [
  "catalog.page",
  "catalog.productChooser",
  "catalog.productCard",
  "account.page",
  "account.profileForm",
  "ui.primaryButton",
];
const ADMIN_PANEL_FROM_PAIR = 8; // adminPanel first appears IN commit 8, so it continues from pair 8 onward
const PAIRS = 12; // 13 commits -> 12 consecutive pairs

function buildExpectations(): Array<{ pair: number; relation: string; from: string; to: string }> {
  const expectations: Array<{ pair: number; relation: string; from: string; to: string }> = [];
  for (let pair = 1; pair <= PAIRS; pair += 1) {
    for (const anchor of CONTINUING_ANCHORS) {
      expectations.push({ pair, relation: "continues_as", from: anchor, to: anchor });
    }
  }
  for (let pair = ADMIN_PANEL_FROM_PAIR; pair <= PAIRS; pair += 1) {
    expectations.push({ pair, relation: "continues_as", from: "account.adminPanel", to: "account.adminPanel" });
  }
  // Commit 8 label: "split: product chooser splits into chooser + sort control".
  expectations.push({ pair: 7, relation: "split_into", from: "catalog.productChooser", to: "catalog.sortControl" });
  // Commit 9 label: "merge: sort control merged back".
  expectations.push({ pair: 8, relation: "merged_into", from: "catalog.sortControl", to: "catalog.productChooser" });
  return expectations;
}

describe("lineage ground-truth evaluation (fixtures/history corpus)", () => {
  it("classifies all candidates across the 12 consecutive pairs with zero false matches and zero abstentions", async () => {
    const groundTruth = JSON.parse(await readFile(path.join(repoDir, "ground-truth.json"), "utf8"));
    const unbuildable = groundTruth.commits.filter((c: { buildOutcome: string }) => c.buildOutcome === "unbuildable");
    expect(unbuildable).toHaveLength(1);
    expect(unbuildable[0].commit).toBe(12); // intentionally unbuildable revision is labeled

    const shas = git(["log", "--reverse", "--format=%H"]).trim().split("\n");
    expect(shas).toHaveLength(13);

    const expectations = buildExpectations();
    const expectedKeys = new Set(expectations.map((e) => `${e.pair}:${e.relation}:${e.from}->${e.to}`));

    let truePositives = 0;
    let falsePositives = 0;
    const abstentions = new Set(expectedKeys);
    const unexpected: string[] = [];

    for (let pair = 1; pair <= PAIRS; pair += 1) {
      const from = elementsAt(shas[pair - 1]!);
      const to = elementsAt(shas[pair]!);
      for (const candidate of lineageCandidates(from, to)) {
        const key = `${pair}:${candidate.relation}:${candidate.fromAnchor}->${candidate.toAnchor}`;
        if (expectedKeys.has(key)) {
          truePositives += 1;
          abstentions.delete(key);
        } else {
          falsePositives += 1;
          unexpected.push(key);
        }
      }
    }

    console.log(
      `[lineage] expected pairings: ${expectations.length}; true positives: ${truePositives}; ` +
        `false positives: ${falsePositives}; abstentions (expected pairing with no candidate): ${abstentions.size}`
    );
    if (unexpected.length > 0) console.log(`[lineage] false matches: ${unexpected.join("; ")}`);
    if (abstentions.size > 0) console.log(`[lineage] abstained on: ${[...abstentions].join("; ")}`);

    expect(falsePositives).toBe(0);
    expect(abstentions.size).toBe(0);
    expect(truePositives).toBe(expectations.length);
  });

  it("records the split and merge as uncertain relations (score 0.6, jaccard in the rationale)", () => {
    const shas = git(["log", "--reverse", "--format=%H"]).trim().split("\n");
    const splitPair = lineageCandidates(elementsAt(shas[6]!), elementsAt(shas[7]!));
    const split = splitPair.find((c) => c.relation === "split_into" && c.toAnchor === "catalog.sortControl");
    expect(split).toBeDefined();
    expect(split!.fromAnchor).toBe("catalog.productChooser");
    expect(split!.score).toBe(0.6); // uncertainty recorded: below the 1.0 explicit-anchor score
    expect(split!.rationale).toContain("jaccard");
    // The chooser also continues explicitly through the split.
    expect(
      splitPair.some(
        (c) => c.relation === "continues_as" && c.fromAnchor === "catalog.productChooser" && c.toAnchor === "catalog.productChooser" && c.score === 1.0
      )
    ).toBe(true);

    const mergePair = lineageCandidates(elementsAt(shas[7]!), elementsAt(shas[8]!));
    const merge = mergePair.find((c) => c.relation === "merged_into" && c.fromAnchor === "catalog.sortControl");
    expect(merge).toBeDefined();
    expect(merge!.toAnchor).toBe("catalog.productChooser");
    expect(merge!.score).toBe(0.6);
    expect(merge!.rationale).toContain("jaccard");
  });

  it("handles the A->B->A visual reversion with anchor continuity (continues_as at score 1.0)", () => {
    const shas = git(["log", "--reverse", "--format=%H"]).trim().split("\n");
    const rendererDefault = (sha: string): string =>
      git(["show", `${sha}:app.js`]).match(/var renderer = "([^"]+)"/)![1]!;
    // Commits 5, 10, 11: carousel (A) -> grid (B) -> carousel (A).
    expect(rendererDefault(shas[4]!)).toBe("carousel@1");
    expect(rendererDefault(shas[9]!)).toBe("grid@1");
    expect(rendererDefault(shas[10]!)).toBe("carousel@1");

    // The reversion pair keeps explicit anchor continuity.
    const candidates = lineageCandidates(elementsAt(shas[9]!), elementsAt(shas[10]!));
    for (const anchor of CONTINUING_ANCHORS) {
      const match = candidates.find((c) => c.relation === "continues_as" && c.toAnchor === anchor);
      expect(match?.score).toBe(1.0);
      expect(match?.rationale).toBe("explicit anchor match");
    }
    // No uncertain relations are invented for a pure visual reversion.
    expect(candidates.every((c) => c.relation === "continues_as" && c.score === 1.0)).toBe(true);
  });
});
