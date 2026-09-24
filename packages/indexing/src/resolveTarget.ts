/**
 * Target resolution from free text (spec section 13). Combines lexical
 * retrieval with anchor matching. Explanations never invent percentages:
 * a score is an uncalibrated rank input, not a probability.
 */
import type { ResolveCandidate, ResolveResponse } from "@ui-intelligence/protocol";
import { search, tokenize, type LexicalIndex } from "./lexical.js";

export type AnchorSource = {
  entityKey: string;
  /** Optional real entity id; falls back to the entity key when absent. */
  entityId?: string;
  anchors: string[];
};

type ScoredEntity = {
  entityKey: string;
  entityId: string;
  score: number;
  matchedAnchors: string[];
  matchedCaptureCount: number;
};

function anchorTokensHit(queryTokens: Set<string>, anchor: string): boolean {
  for (const tok of tokenize(anchor)) {
    if (queryTokens.has(tok)) return true;
  }
  return false;
}

/**
 * Resolve a text query against the lexical index plus a list of candidate
 * anchors per entity.
 *
 * - Single best entity with a clear margin (top score >= 2x second) => resolved
 * - Multiple close entities => ambiguous with candidates + explanations
 * - Nothing matched => no_match
 */
export function resolveTargetFromText(
  index: LexicalIndex,
  query: { text: string },
  anchors: AnchorSource[]
): ResolveResponse {
  const queryTokens = new Set(tokenize(query.text));
  if (queryTokens.size === 0) {
    return { status: "no_match", reason: "query text contains no searchable terms" };
  }

  // Lexical retrieval over captures.
  const captureHits = search(index, { text: query.text }, Number.MAX_SAFE_INTEGER);
  const scoreByCapture = new Map(captureHits.map((h) => [h.captureId, h.score]));

  const scored: ScoredEntity[] = [];
  for (const source of anchors) {
    const matchedAnchors: string[] = [];
    let captureScore = 0;
    let matchedCaptureCount = 0;

    for (const anchor of source.anchors) {
      const anchorInIndex = index.anchors.has(anchor);
      const queryAnchorHit = anchorTokensHit(queryTokens, anchor);
      if (queryAnchorHit && anchorInIndex) matchedAnchors.push(anchor);

      const captureIds = index.anchors.get(anchor);
      if (!captureIds) continue;
      for (const captureId of captureIds) {
        const s = scoreByCapture.get(captureId);
        if (s !== undefined && s > 0) {
          captureScore += s;
          matchedCaptureCount += 1;
        }
      }
    }

    const score = matchedAnchors.length * 2 + captureScore;
    if (score > 0) {
      scored.push({
        entityKey: source.entityKey,
        entityId: source.entityId ?? source.entityKey,
        score,
        matchedAnchors,
        matchedCaptureCount,
      });
    }
  }

  if (scored.length === 0) {
    return { status: "no_match", reason: "no capture text or anchor evidence matches the query" };
  }

  scored.sort((a, b) => (b.score === a.score ? a.entityKey.localeCompare(b.entityKey) : b.score - a.score));

  const top = scored[0]!;
  const second = scored[1];
  const clearMargin = !second || top.score >= 2 * second.score;

  if (clearMargin && scored.length === 1) {
    return { status: "resolved", entityId: top.entityId, entityKey: top.entityKey };
  }
  if (clearMargin) {
    return { status: "resolved", entityId: top.entityId, entityKey: top.entityKey };
  }

  const candidates: ResolveCandidate[] = scored.map((e) => ({
    entityId: e.entityId,
    entityKey: e.entityKey,
    score: e.score,
    explanation:
      `matched anchors: ${e.matchedAnchors.length > 0 ? e.matchedAnchors.join(", ") : "(none)"}; ` +
      `matching captures: ${e.matchedCaptureCount}`,
  }));

  return { status: "ambiguous", candidates };
}
