/**
 * Retrieval evaluation over the frozen corpus (spec section 19, retrieval
 * row): "On a proposed corpus of 100 known-target queries, the correct target
 * appears in the top three for at least 90; separately test at least 30
 * ambiguous or out-of-corpus queries."
 *
 * The corpus is frozen in ../corpus.json (regenerate with
 * `node ../generate-corpus.mjs`; the file is committed and must not drift).
 * Each observation becomes one capture with the entity's explicit anchor, so
 * the lexical index mirrors what capture indexing produces.
 *
 * Measured numbers are printed to stdout; the assertions enforce the release
 * criterion (top-3 >= 90/100) and honest abstention behavior on ambiguous and
 * out-of-corpus queries.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLexicalIndex, resolveTargetFromText, search } from "@ui-intelligence/indexing";

const corpusPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

// Each observation is one capture: captureId encodes the owning entity.
const records = [];
const entityByCapture = new Map();
for (const entity of corpus.entities) {
  entity.observations.forEach((visibleText, i) => {
    const captureId = `${entity.entityKey}#obs${i}`;
    records.push({ captureId, observations: [{ anchor: entity.anchors[0], visibleText }] });
    entityByCapture.set(captureId, entity.entityKey);
  });
}
const index = buildLexicalIndex(records);
const anchorSources = corpus.entities.map((e) => ({ entityKey: e.entityKey, anchors: e.anchors }));

/** Entity ranking for a text query: lexical hits mapped to entities, deduped in score order. */
function entityRanking(text, limit) {
  const hits = search(index, { text }, records.length);
  const ranking = [];
  for (const hit of hits) {
    const key = entityByCapture.get(hit.captureId);
    if (key !== undefined && !ranking.includes(key)) ranking.push(key);
    if (ranking.length >= limit) break;
  }
  return ranking;
}

describe("retrieval evaluation (frozen corpus)", () => {
  it("the correct target appears in the top three for at least 90 of 100 known-target queries", () => {
    const known = corpus.knownTargetQueries;
    expect(known.length).toBeGreaterThanOrEqual(100);

    let top1 = 0;
    let top3 = 0;
    const misses = [];
    for (const query of known) {
      const ranking = entityRanking(query.text, 3);
      if (ranking[0] === query.expectedEntityKey) top1 += 1;
      if (ranking.includes(query.expectedEntityKey)) top3 += 1;
      else misses.push({ text: query.text, expected: query.expectedEntityKey, got: ranking });
    }

    // Measured numbers (also visible in test output for the completion matrix).
    console.log(
      `[retrieval] known-target queries: ${known.length}; top-1: ${top1} (${((top1 / known.length) * 100).toFixed(1)}%); ` +
        `top-3: ${top3} (${((top3 / known.length) * 100).toFixed(1)}%)`
    );
    if (misses.length > 0) {
      console.log(`[retrieval] top-3 misses (${misses.length}):`);
      for (const m of misses) console.log(`  - "${m.text}" expected ${m.expected}, got ${JSON.stringify(m.got)}`);
    }

    expect(top3).toBeGreaterThanOrEqual(90);
  });

  it("ambiguous queries return ambiguous with an expected key among the candidates, or resolve to one", () => {
    let ambiguous = 0;
    let resolvedToExpected = 0;
    const failures = [];
    for (const query of corpus.ambiguousQueries) {
      const result = resolveTargetFromText(index, { text: query.text }, anchorSources);
      if (result.status === "ambiguous") {
        ambiguous += 1;
        const keys = result.candidates.map((c) => c.entityKey);
        const hit = query.expectedEntityKeys.filter((k) => keys.includes(k));
        if (hit.length === 0) failures.push({ text: query.text, expected: query.expectedEntityKeys, candidates: keys });
        // Abstention behavior: ambiguity is surfaced with >= 2 candidates, not silently resolved.
        expect(result.candidates.length).toBeGreaterThanOrEqual(2);
      } else if (result.status === "resolved") {
        if (!query.expectedEntityKeys.includes(result.entityKey)) {
          failures.push({ text: query.text, expected: query.expectedEntityKeys, resolved: result.entityKey });
        } else {
          resolvedToExpected += 1;
        }
      } else {
        failures.push({ text: query.text, expected: query.expectedEntityKeys, status: result.status });
      }
    }
    console.log(
      `[retrieval] ambiguous queries: ${corpus.ambiguousQueries.length}; returned ambiguous: ${ambiguous}; ` +
        `resolved to an expected key: ${resolvedToExpected}`
    );
    expect(failures).toEqual([]);
  });

  it("out-of-corpus queries return no_match (honest abstention)", () => {
    const failures = [];
    for (const query of corpus.noMatchQueries) {
      const result = resolveTargetFromText(index, { text: query.text }, anchorSources);
      if (result.status !== "no_match") {
        failures.push({ text: query.text, status: result.status });
      } else {
        expect(result.reason).toBeTruthy();
      }
    }
    expect(failures).toEqual([]);
  });

  it("does not invent calibrated confidence labels in explanations", () => {
    for (const query of corpus.knownTargetQueries.slice(0, 20)) {
      const result = resolveTargetFromText(index, { text: query.text }, anchorSources);
      if (result.status === "ambiguous") {
        for (const c of result.candidates) {
          expect(c.explanation).not.toMatch(/%\s*(sure|certain|confidence)/i);
        }
      }
    }
  });
});
