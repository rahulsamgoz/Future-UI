import { describe, expect, it } from "vitest";
import { buildLexicalIndex, lineageCandidates, resolveTargetFromText, search } from "../src/index.js";

describe("lineageCandidates", () => {
  it("matches explicit anchors as continues_as with score 1.0", () => {
    const result = lineageCandidates(
      { commitSha: "a", anchors: ["product.carousel"], texts: ["Product carousel"] },
      { commitSha: "b", anchors: ["product.carousel"], texts: ["Product carousel"] }
    );
    expect(result).toEqual([
      {
        relation: "continues_as",
        fromAnchor: "product.carousel",
        toAnchor: "product.carousel",
        score: 1.0,
        rationale: "explicit anchor match",
      },
    ]);
  });

  it("detects a split: one source element matched by several target elements", () => {
    const result = lineageCandidates(
      { commitSha: "a", anchors: ["product.list"], texts: ["product list with prices and buttons"] },
      {
        commitSha: "b",
        anchors: ["product.grid", "product.actions"],
        texts: ["product list with prices", "buttons for products"],
      }
    );
    const splits = result.filter((c) => c.relation === "split_into");
    expect(splits).toHaveLength(2);
    expect(new Set(splits.map((c) => c.toAnchor))).toEqual(new Set(["product.grid", "product.actions"]));
    for (const s of splits) {
      expect(s.fromAnchor).toBe("product.list");
      expect(s.score).toBe(0.6);
      expect(s.rationale).toContain("split");
    }
  });

  it("detects a merge: several source elements matched by one target element", () => {
    const result = lineageCandidates(
      {
        commitSha: "a",
        anchors: ["cart.items", "cart.summary"],
        texts: ["items in your cart", "summary of totals"],
      },
      { commitSha: "b", anchors: ["cart.panel"], texts: ["items in your cart and summary of totals"] }
    );
    const merges = result.filter((c) => c.relation === "merged_into");
    expect(merges).toHaveLength(2);
    for (const m of merges) {
      expect(m.toAnchor).toBe("cart.panel");
      expect(m.score).toBe(0.6);
    }
  });

  it("marks inferred text-only candidates and caps their score at 0.5", () => {
    const result = lineageCandidates(
      { commitSha: "a", anchors: ["old.anchor"], texts: ["shipping address form"] },
      { commitSha: "b", anchors: ["new.anchor"], texts: ["shipping address form"] }
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.relation).toBe("continues_as");
    expect(result[0]!.score).toBeLessThanOrEqual(0.5);
    expect(result[0]!.rationale).toContain("inferred");
  });

  it("never maps multiple unrelated target anchors to one predecessor in a greedy pass", () => {
    // Two unrelated source elements; one has a strong match, the other only a weak one.
    const result = lineageCandidates(
      {
        commitSha: "a",
        anchors: ["orders.table", "orders.footer"],
        texts: ["orders table with totals", "page footer legal text"],
      },
      {
        commitSha: "b",
        anchors: ["orders.table", "orders.footer.notes"],
        texts: ["orders table with totals", "orders table with totals and footer legal text"],
      }
    );
    // "orders.table" continues explicitly; the footer must not silently also
    // map onto "orders.table" — it maps only onto the footer-derived target.
    const tableCandidates = result.filter((c) => c.toAnchor === "orders.table");
    expect(tableCandidates).toHaveLength(1);
    expect(tableCandidates[0]!.fromAnchor).toBe("orders.table");
  });
});

describe("buildLexicalIndex / search", () => {
  const index = buildLexicalIndex([
    {
      captureId: "cap_1",
      observations: [
        { anchor: "catalog.productChooser", visibleText: "product chooser with price tags" },
        { anchor: "catalog.sortControl", visibleText: "sort control" },
      ],
    },
    {
      captureId: "cap_2",
      observations: [{ anchor: "account.profileForm", visibleText: "profile form with price display" }],
    },
    { captureId: "cap_3", observations: [{ visibleText: "product chooser compact" }] },
  ]);

  it("ranks by term frequency", () => {
    const hits = search(index, { text: "product chooser" }, 10);
    expect(hits[0]!.captureId).toBe("cap_1");
    expect(hits.map((h) => h.captureId)).toContain("cap_3");
  });

  it("matches anchors exactly", () => {
    const hits = search(index, { anchor: "account.profileForm" }, 10);
    expect(hits).toEqual([{ captureId: "cap_2", score: 2 }]);
  });

  it("returns empty for unknown terms and respects the limit", () => {
    expect(search(index, { text: "zzz-not-found" }, 10)).toEqual([]);
    expect(search(index, { text: "product chooser price display" }, 1)).toHaveLength(1);
  });

  it("is deterministic across runs", () => {
    const a = search(index, { text: "product chooser" }, 10);
    const b = search(index, { text: "product chooser" }, 10);
    expect(a).toEqual(b);
  });
});

describe("resolveTargetFromText", () => {
  function makeIndex() {
    return buildLexicalIndex([
      {
        captureId: "cap_chooser",
        observations: [{ anchor: "catalog.productChooser", visibleText: "product chooser card grid" }],
      },
      {
        captureId: "cap_sort",
        observations: [{ anchor: "catalog.sortControl", visibleText: "product chooser sort control" }],
      },
    ]);
  }

  const anchors = [
    { entityKey: "catalog.productChooser", anchors: ["catalog.productChooser"] },
    { entityKey: "catalog.sortControl", anchors: ["catalog.sortControl"] },
  ];

  it("resolves a single best target with a clear margin", () => {
    const index = buildLexicalIndex([
      {
        captureId: "cap_profile",
        observations: [{ anchor: "account.profileForm", visibleText: "profile form fields" }],
      },
      {
        captureId: "cap_other",
        observations: [{ anchor: "catalog.sortControl", visibleText: "sort control" }],
      },
    ]);
    const result = resolveTargetFromText(index, { text: "profile form" }, [
      { entityKey: "catalog.productChooser", anchors: ["catalog.productChooser"] },
      { entityKey: "account.profileForm", anchors: ["account.profileForm"] },
    ]);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.entityKey).toBe("account.profileForm");
  });

  it("reports ambiguity with candidates and explanations when scores are close", () => {
    const result = resolveTargetFromText(makeIndex(), { text: "product chooser" }, anchors);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates.length).toBeGreaterThanOrEqual(2);
      for (const c of result.candidates) {
        expect(c.explanation).toMatch(/matched anchors|matching captures/);
        expect(c.explanation).not.toMatch(/%\s*(sure|certain|confidence)/i);
      }
    }
  });

  it("returns no_match when nothing matches", () => {
    const result = resolveTargetFromText(makeIndex(), { text: "nonexistent widget" }, anchors);
    expect(result.status).toBe("no_match");
    if (result.status === "no_match") expect(result.reason).toBeTruthy();
  });
});
