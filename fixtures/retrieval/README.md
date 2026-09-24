# Retrieval evaluation corpus

Frozen corpus for the section 19 retrieval release criterion: *"On a proposed
corpus of 100 known-target queries, the correct target appears in the top three
for at least 90; separately test at least 30 ambiguous or out-of-corpus
queries."*

## Files

- `corpus.json` — the frozen corpus (committed; do not hand-edit).
- `generate-corpus.mjs` — deterministic generator that writes `corpus.json`
  and self-checks its invariants.
- `test/eval.test.ts` — the evaluation (part of the root vitest run).

## Corpus design

- **53 entities** across realistic app areas (`catalog.*`, `cart.*`,
  `account.*`, `orders.*`, `settings.*`, `nav.*`, `content.*`,
  `dashboard.*`, `support.*`, `admin.*`, plus generated region variants
  `app.region1..6`). Each entity has an explicit anchor (its entity key) and
  2-6 observations with realistic visible text (product names, form labels,
  sort options, transaction rows, button labels) with varied wording, casing,
  and word order.
- **Deliberate near-collisions** create genuine ambiguity rather than toy
  disjoint vocabularies: "Add to cart" (button) vs "Add to cart item" (line
  item row) live on different entities; "Order #4821" appears in both the
  order list and the invoice; stopwords like "to"/"your"/"in" occur throughout.
- **100 known-target queries**, each `{ text, expectedEntityKey }`: every
  entity contributes its exact observation phrase; the remaining slots are
  filled round-robin with partial phrases ("featured products"), reordered
  words, and paraphrases built from the entity's own vocabulary. The generator
  asserts every known-target query shares content vocabulary with its expected
  entity, so the corpus never asks for the impossible.
- **20 ambiguous queries**, each `{ text, expectedEntityKeys: string[] }` with
  >= 2 equally-valid targets (e.g. "add to cart", "password", "order",
  "shipping"). The resolver must either return `ambiguous` with at least one
  expected key among the candidates, or resolve to one of the expected keys.
- **12 out-of-corpus queries**, `{ text }` about nothing in the corpus
  ("weather forecast for berlin", "banana bread recipe", ...). The generator
  asserts they share no content token with any entity, and the eval asserts
  the resolver returns `no_match` (honest abstention) for each.

## Measured baseline (2026-09-24, stopword-aware lexical scoring)

- Known-target: top-1 97/100, top-3 100/100 (criterion: top-3 >= 90).
- Ambiguous: 15 returned `ambiguous` with an expected key among candidates,
  5 resolved directly to an expected key; 0 mis-resolutions.
- Out-of-corpus: 12/12 `no_match`.

## Scoring notes / tuning history

The original TF-sum scoring matched query stopwords ("to", "your", "in", ...)
against nearly every observation, which both inflated cross-entity scores and
made honest out-of-corpus abstention impossible. The fix (packages/indexing/
`lexical.ts`) skips a small frozen English stopword list when scoring text
queries. No other scoring changes were needed; the corpus was NOT weakened to
reach the threshold.

## Regenerating / extending

```sh
node fixtures/retrieval/generate-corpus.mjs   # rewrites corpus.json
```

Edit the `ENTITIES`, `VARIANTS`, `AMBIGUOUS_QUERIES`, or `NO_MATCH_QUERIES`
tables in `generate-corpus.mjs`, re-run, and commit the new `corpus.json`.
The generator enforces the release-criterion sizes (>= 100 known-target,
>= 30 ambiguous/out-of-corpus) and vocabulary-sanity checks, and fails loudly
otherwise. Extending observations with new near-collision wordings is the
most valuable way to grow the corpus honestly.
