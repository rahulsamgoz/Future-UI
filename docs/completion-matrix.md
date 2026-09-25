# R1 Completion Matrix — requirement → evidence (audited)

Independent audit (2026-09-25) found several rows overstated. Statuses now use:
`VERIFIED` (executed evidence), `INCOMPLETE` (implemented but unproven or partial),
`BLOCKED` (external input required), `DEFERRED` (explicitly out of scope).

## Section 16 — R1 commitments

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| Integration | Runtime SDK, Vite manifest plugin, configuration, CLI, CI capture | VERIFIED | Packages + live capture pipeline; CI on main green (run 36080134328) |
| Selection | Button, repeated instance, component, section, page, finite multi-page set | VERIFIED | Editor select E2E; instance keys; batch; page tabs |
| Representations | Approved button/card properties + carousel/grid/table | VERIFIED | Renderer tests + E2E grid accept |
| Page composition | Stack/grid/split over registered slots; locked/required regions | VERIFIED | Validator tests; live: locked admin survived layout change + batch + undos |
| Personalization | Local persistence, export/import, conflict handling, recovery, batch undo | VERIFIED* | Persistence/recovery/batch-undo tested; *stale-acceptance conflict reconciliation defect found by audit — fix in flight (branch vorflux/audit-fixes) |
| History | Plans, selected-commit reconstruction, continuous capture, extendable backfill | VERIFIED* | Plans/CLI/scan E2E verified. Reconstruction is now IMPLEMENTED and executed (audit fix): the fixture corpus is a runnable static app per commit (13 commits), `packages/capture` `reconstructCommit` materializes a commit as a git worktree, serves it, captures all 6 scenarios, and durably publishes + VERIFIES every capture; `history_scan` reconstructs when the input carries `fixtureRepo` (extend-without-duplicating, per-commit outcomes in the job payload, unbuildable commits recorded as expected failures). `docs/coverage-report.json` regenerated from the real reconstruction: 72/78 slots captured with real capture ids + sha256, 6 expected failures (commit 12), 0 gaps. *Expected failures are records, not captures (spec 16) |
| Identity | Anchors, source provenance, candidate lineage, ambiguous-match review | VERIFIED | Lineage ground-truth eval: 38 TP / 0 FP / 0 abstentions; anchors in all captures |
| Retrieval | Click/text/screenshot resolution; historical alternatives | VERIFIED* | Click+text+crop-matching grounding tested; *the 100/100 corpus figure is LEXICAL-TEXT retrieval only — screenshot grounding has separate, smaller tests and is not covered by that number |
| Generation | Up to four live alternatives from text, history, or image references | VERIFIED | Editor generate flow now calls the REAL backend: POST /v1/projects/:p/proposals with the user instruction + staged references (history captures via "Use as reference", grounded screenshot artifacts) and polls to terminal; orchestrator grounds history/image references into REAL observation content (visible text, anchor, commit, screenshot artifact id) via an injected loadReference (apps/api + index-worker wired to SQLite) instead of placeholder id strings; offline (API-unreachable) fallback to the local generator is visibly labeled "offline · local", never silent; accepted candidates keep the API validation digest. Embedding jobs record an explicit "skipped: no embedding model configured" note in the job payload instead of a bare success. Live-verified: scripts/verify-editor-proposals.mjs against the running stack (space-bunny-free) returned 4 validated candidates (carousel/grid/table) with API digests from an instruction + history reference; page tab honestly labels local layout suggestions (API page-scope generation not configured) |
| History console | Timeline, filters, side-by-side, evidence labels, source links, scan progress | VERIFIED | Studio tests + live |
| Backend | Project API, relational metadata, artifact storage, durable jobs, recovery, indexing | VERIFIED* | Pipeline + fault-injection tests; *artifact/sync route authorization gaps (audit finding 1) and capture-runner legacy-mode contract mismatch found — fixes in flight |
| Developer handoff | Export accepted specification into app-owned configuration | VERIFIED | Live: CLI created PR #3, merged, app booted the default |

## Section 18 — Integrated journeys

| Journey | Status | Evidence |
| --- | --- | --- |
| New project onboarding | VERIFIED | Live E2E 6/6 (sync, plan, scan, ingest, extend w/o duplication, history) |
| Historical onboarding | VERIFIED* | Reconstruction now executed end to end (see History row): fixture-corpus reconstruction published 72 verified captures + 6 expected-failure records; gated E2E reconstructs 2 commits × 2 scenarios and asserts the captures appear in the history API (GET /captures) |
| Historical browsing | VERIFIED | Studio + editor history E2E |
| Personal component change | VERIFIED | Browser E2E: select → grid → reload persistence → undo |
| Screenshot grounding | VERIFIED | Crop upload → resolved entityKey (API + editor UI) |
| Reference-guided page change | INCOMPLETE | Layout candidates were LOCAL enumerations, not design-reference-driven generation (audit); form state transfer verified |
| Site-wide finite batch | VERIFIED | Apply/persist/cross-route/undo E2E |
| Release compatibility | VERIFIED | Contract-bump suspension test (identity-persistence defect found by audit — fix in flight) |
| Developer handoff | VERIFIED | PR #3 end to end |

## Section 19 — Release criteria

| Area | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| Protocol | Invalid schemas/versions/refs/idempotency rejected | VERIFIED | API tests 422/409/404 |
| Runtime | Transformations preserve data/actions/state; reset reachable | VERIFIED | E2E + unit |
| Composition | Required/locked slots survive; adversarial layouts fail; batch undo covers all | VERIFIED | Validator tests + live journeys |
| Persistence | Reload, concurrent tabs, account switching, interrupted commits, unavailable storage | VERIFIED* | All tested; *cross-tab sync wired; sync conflict MODEL defect (audit finding 5) — fix in flight |
| Capture | Every planned fixture slot: artifacts or explicit expected failure | INCOMPLETE | 78-slot manifest honest (6 captured / 6 expected / 66 gaps), but gaps reflect missing reconstruction, not just unreachability; runnable-corpus fix in flight will re-baseline |
| Lineage | Labeled cases behave; uncertainty recorded | VERIFIED | Ground-truth eval 38/0/0 |
| Retrieval | 100-query corpus top-3 ≥ 90; ≥30 ambiguous/out-of-corpus | VERIFIED | Top-3 100/100 lexical-text corpus; 0 mis-resolutions; 12/12 abstentions |
| Generation | Real-provider working variants; injection cannot bypass | VERIFIED | Adversarial suite green; live provider validated candidates; editor wired to the real proposal API with grounded history/image references and a labeled offline fallback (see Generation row above) |
| Preview safety | Zero live mutations in verification corpus | VERIFIED | Stub-action tests; cart-count unchanged |
| Authorization | Cross-project reads fail | INCOMPLETE | :p-scoped routes enforced + tested; artifact/sync routes BYPASSED role checks (audit finding 1) — fix in flight with regression tests |
| Job recovery | Worker loss, lease expiry, cancellation, retries preserve dedup | VERIFIED* | Fault-injection suite; *legacy capture-runner mode contract mismatch (claim/complete 422, /cancelled 404) — fix in flight |
| Performance | <30KB gzip core; <100ms p95; <5% overhead | VERIFIED | 17.4KB / 32.3ms / 3.71% measured |
| Integration | Every section-18 journey through the connected system | INCOMPLETE | 7/9 VERIFIED; 2 pending fixes above |

## Audit-found defects and their fix status (branch vorflux/audit-fixes)

| # | Defect | Status |
| --- | --- | --- |
| A1 | Artifact + profile/sync routes bypass role checks | fix in flight (fix-auth-storage) |
| A2 | Historical reconstruction unimplemented in scan path | fix in flight (fix-reconstruction) |
| A3 | Editor bypasses API generation; references not grounded | fix in flight (fix-editor-generation) |
| A4 | S3 driver get/exists in-memory only; publication not awaited | fix in flight (fix-auth-storage) |
| A5 | Sync overwrites divergent edits silently | fix in flight (fix-persistence) |
| A6a | Capture-runner legacy mode contract mismatch | fix in flight (fix-capture-correctness: runner client matches real API — claim {workerId}, complete {leaseToken}, POST /cancel; integration test apps/capture-runner/test/legacy-api.test.ts) |
| A6b | Empty history run reports completion | fix in flight (fix-capture-correctness: honest job records — history_scan finalizes completed_with_gaps + result summary, apps/index-worker/test/history-honesty.test.ts) + A2 |
| A6c | Stale acceptance / live-view conflict | fix in flight (fix-persistence) |
| A6d | Masked child text leaks into parent observation | fix in flight (fix-capture-correctness: boundary visibleText reads a clone with masked descendants removed; packages/capture/test/masked-text.test.ts) |
| A6e | Capture accepted before artifact bytes uploaded | fix in flight (fix-auth-storage: ingest verifies bytes) |
| A6f | Contract identity persistence (v2 stored as v1) | fix in flight (fix-persistence) |

## Explicitly DEFERRED (per spec section 19, not claimed)

- Native adapters (iOS/Android) — require view/state mapping definitions first.
- Vision-capable generation in the dev profile — the configured free model is text-only; the code path exists behind a capability flag but is not exercised live.
- Remote-repository clone in reconstruction (local fixture path only in dev profile).
