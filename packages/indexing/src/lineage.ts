/**
 * Lineage candidate generation (spec sections 4 and 13).
 *
 * Relations: continues_as, split_into, merged_into, replaces. Competing
 * matches are considered together: a greedy nearest-neighbor pass must not
 * map several unrelated target anchors onto one predecessor. Best-match-only
 * is enforced; the remainder are reported as separate candidates.
 */
import type { LineageRelation } from "@ui-intelligence/protocol";

export type LineageSide = {
  commitSha: string;
  anchors: string[];
  texts: string[];
};

export type LineageCandidate = {
  relation: LineageRelation;
  fromAnchor: string;
  toAnchor: string;
  score: number;
  rationale: string;
};

/** Split/merge candidates share text; their score is the fixed relation score. */
const SPLIT_MERGE_SCORE = 0.6;
/** Inferred (text-only, no anchor evidence) candidates are capped below 0.6. */
export const INFERRED_SCORE_CAP = 0.5;

/** Jaccard overlap of word tokens, lowercased. 0 when both sides are empty. */
export function textJaccard(a: string, b: string): number {
  const tokens = (s: string): Set<string> => {
    const set = new Set<string>();
    for (const tok of s.toLowerCase().split(/[^a-z0-9]+/)) if (tok) set.add(tok);
    return set;
  };
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

type Element = { index: number; anchor?: string; text: string };

function elementsOf(side: LineageSide): Element[] {
  const len = Math.max(side.anchors.length, side.texts.length);
  const out: Element[] = [];
  for (let i = 0; i < len; i += 1) {
    const anchor = side.anchors[i];
    const text = side.texts[i] ?? "";
    if (anchor === undefined && text === "") continue;
    out.push({ index: out.length, anchor, text });
  }
  return out;
}

/**
 * Compute lineage candidates between two commits.
 *
 * `anchors` and `texts` are parallel element lists per side (element i has
 * `anchors[i]` and `texts[i]`).
 *
 * Rules:
 * - explicit anchor name match => continues_as, score 1.0
 * - one predecessor matching several successors with shared text => split_into
 *   candidates (score 0.6, justified by text overlap Jaccard)
 * - several predecessors matching one successor => merged_into (score 0.6)
 * - no anchor match in the target but text matches => inferred candidate,
 *   relation continues_as, score = Jaccard capped at 0.5, rationale "inferred"
 */
export function lineageCandidates(from: LineageSide, to: LineageSide): LineageCandidate[] {
  const fromElems = elementsOf(from);
  const toElems = elementsOf(to);
  const candidates: LineageCandidate[] = [];

  const fromUsed = new Set<number>();
  const toUsed = new Set<number>();

  // Pass 1: explicit anchor name matches.
  for (const fe of fromElems) {
    if (!fe.anchor) continue;
    const matches = toElems.filter((te) => te.anchor === fe.anchor);
    if (matches.length === 1) {
      const te = matches[0]!;
      candidates.push({
        relation: "continues_as",
        fromAnchor: fe.anchor,
        toAnchor: te.anchor!,
        score: 1.0,
        rationale: "explicit anchor match",
      });
      fromUsed.add(fe.index);
      toUsed.add(te.index);
    } else if (matches.length > 1) {
      // Same explicit anchor reused by several successors: one -> many.
      const withSharedText = matches.filter((te) => textJaccard(fe.text, te.text) > 0);
      for (const te of withSharedText) {
        candidates.push({
          relation: "split_into",
          fromAnchor: fe.anchor,
          toAnchor: te.anchor!,
          score: SPLIT_MERGE_SCORE,
          rationale: `split: one source anchor matched ${matches.length} target anchors with shared text (jaccard ${textJaccard(fe.text, te.text).toFixed(2)})`,
        });
        toUsed.add(te.index);
      }
      fromUsed.add(fe.index);
    }
  }

  // Pass 2: text overlap among the remaining elements.
  const remainingFrom = fromElems.filter((e) => !fromUsed.has(e.index));
  const remainingTo = toElems.filter((e) => !toUsed.has(e.index));

  const pairs: Array<{ f: Element; t: Element; j: number }> = [];
  for (const fe of remainingFrom) {
    for (const te of remainingTo) {
      const j = textJaccard(fe.text, te.text);
      if (j > 0) pairs.push({ f: fe, t: te, j });
    }
  }

  const pairUsed = new Set<string>();
  const splitFrom = new Set<number>();
  const mergedTo = new Set<number>();

  // one -> many: a single predecessor matches several successors.
  for (const fe of remainingFrom) {
    const matches = pairs.filter((p) => p.f.index === fe.index && !pairUsed.has(`${p.f.index}->${p.t.index}`));
    if (matches.length > 1) {
      splitFrom.add(fe.index);
      for (const p of matches) {
        pairUsed.add(`${p.f.index}->${p.t.index}`);
        candidates.push({
          relation: "split_into",
          fromAnchor: fe.anchor ?? `#${fe.index}`,
          toAnchor: p.t.anchor ?? `#${p.t.index}`,
          score: SPLIT_MERGE_SCORE,
          rationale: `split: source element matched ${matches.length} target elements with shared text (jaccard ${p.j.toFixed(2)})`,
        });
      }
    }
  }

  // many -> one: several predecessors match the same successor.
  for (const te of remainingTo) {
    const matches = pairs.filter(
      (p) => p.t.index === te.index && !pairUsed.has(`${p.f.index}->${p.t.index}`) && !splitFrom.has(p.f.index)
    );
    if (matches.length > 1) {
      mergedTo.add(te.index);
      for (const p of matches) {
        pairUsed.add(`${p.f.index}->${p.t.index}`);
        candidates.push({
          relation: "merged_into",
          fromAnchor: p.f.anchor ?? `#${p.f.index}`,
          toAnchor: te.anchor ?? `#${te.index}`,
          score: SPLIT_MERGE_SCORE,
          rationale: `merge: ${matches.length} source elements matched one target element with shared text (jaccard ${p.j.toFixed(2)})`,
        });
      }
    }
  }

  // Remaining one-to-one text matches: inferred, no anchor evidence.
  for (const p of pairs) {
    if (pairUsed.has(`${p.f.index}->${p.t.index}`)) continue;
    if (splitFrom.has(p.f.index) || mergedTo.has(p.t.index)) continue;
    pairUsed.add(`${p.f.index}->${p.t.index}`);
    candidates.push({
      relation: "continues_as",
      fromAnchor: p.f.anchor ?? `#${p.f.index}`,
      toAnchor: p.t.anchor ?? `#${p.t.index}`,
      score: Math.min(p.j, INFERRED_SCORE_CAP),
      rationale: `inferred from text overlap (jaccard ${p.j.toFixed(2)}); no matching anchor in target commit ${to.commitSha}`,
    });
  }

  return candidates;
}
