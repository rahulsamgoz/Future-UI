/**
 * Lexical retrieval index (spec sections 12, 13). Deterministic inverted
 * index with simple TF scoring — no external dependencies, no embeddings.
 */

export type LexicalRecord = {
  captureId: string;
  observations: Array<{ anchor?: string; visibleText?: string }>;
};

export type LexicalIndex = {
  /** anchor -> capture ids */
  anchors: Map<string, Set<string>>;
  /** term -> (captureId -> term frequency) */
  terms: Map<string, Map<string, number>>;
  /** captureId -> its anchors and term frequencies (reverse lookup) */
  captures: Map<string, { anchors: Set<string>; terms: Map<string, number> }>;
};

export type LexicalQuery = { text?: string; anchor?: string };

export type LexicalHit = { captureId: string; score: number };

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) if (tok) out.push(tok);
  return out;
}

/** Build an inverted index over capture observations. */
export function buildLexicalIndex(records: LexicalRecord[]): LexicalIndex {
  const index: LexicalIndex = {
    anchors: new Map(),
    terms: new Map(),
    captures: new Map(),
  };

  for (const record of records) {
    const { captureId } = record;
    const captureEntry = { anchors: new Set<string>(), terms: new Map<string, number>() };
    index.captures.set(captureId, captureEntry);

    for (const obs of record.observations) {
      if (obs.anchor) {
        captureEntry.anchors.add(obs.anchor);
        let set = index.anchors.get(obs.anchor);
        if (!set) {
          set = new Set();
          index.anchors.set(obs.anchor, set);
        }
        set.add(captureId);
      }
      if (obs.visibleText) {
        for (const term of tokenize(obs.visibleText)) {
          captureEntry.terms.set(term, (captureEntry.terms.get(term) ?? 0) + 1);
        }
      }
    }

    for (const [term, tf] of captureEntry.terms) {
      let postings = index.terms.get(term);
      if (!postings) {
        postings = new Map();
        index.terms.set(term, postings);
      }
      postings.set(captureId, tf);
    }
  }

  return index;
}

/**
 * Search the index. Text queries score by summed term frequency; an anchor
 * query scores captures containing that anchor (weight 2 per match). Results
 * are ranked by score descending, ties broken by captureId for determinism.
 */
export function search(index: LexicalIndex, query: LexicalQuery, limit: number): LexicalHit[] {
  const scores = new Map<string, number>();

  if (query.text) {
    for (const term of tokenize(query.text)) {
      const postings = index.terms.get(term);
      if (!postings) continue;
      for (const [captureId, tf] of postings) {
        scores.set(captureId, (scores.get(captureId) ?? 0) + tf);
      }
    }
  }

  if (query.anchor) {
    const postings = index.anchors.get(query.anchor);
    if (postings) {
      for (const captureId of postings) {
        scores.set(captureId, (scores.get(captureId) ?? 0) + 2);
      }
    }
  }

  const hits: LexicalHit[] = [];
  for (const [captureId, score] of scores) {
    if (score > 0) hits.push({ captureId, score });
  }
  hits.sort((a, b) => (b.score === a.score ? a.captureId.localeCompare(b.captureId) : b.score - a.score));
  return hits.slice(0, Math.max(0, limit));
}
