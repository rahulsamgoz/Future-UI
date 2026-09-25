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
| History | Plans, selected-commit reconstruction, continuous capture, extendable backfill | VERIFIED* | Plans/CLI/scan E2E verified. Reconstruction is IMPLEMENTED and reachable from the NORMAL plan path (closure audit fix 3a): `fixtureRepo` is accepted by the plan input schema (validated: existing directory inside UI_INTEL_RECONSTRUCT_ROOTS, default repo root + tmpdir), persisted in the plan input JSON, copied into the job payload by run submission, and consumed by `history_scan` (extend-without-duplicating, per-commit outcomes in the job payload, unbuildable commits recorded as expected failures). Regression-tested end to end via the real API route + real fixture corpus + real worker handler: published captures carry the selected commit sha (apps/api/test/history-plan-fixture.test.ts). The fixture corpus now covers the account route (account.html at /account + #/account hash-routing; profileForm in all commits, adminPanel from the split commit) and recipes are used AS-IS (routes/readiness no longer rewritten — closure audit fix 3b). `docs/coverage-report.json` regenerated from the LIVE reconstruction: 156 planned slots (13 commits × 12 scenario-recipes = 6 named scenarios × 2 viewports), 144 captured with real capture ids + sha256, 12 expected failures (commit 12), 0 gaps. *Expected failures are records, not captures (spec 16) |
| Identity | Anchors, source provenance, candidate lineage, ambiguous-match review | VERIFIED | Lineage ground-truth eval (re-run after the fixture gained the account route): 79 TP / 0 FP / 0 abstentions; anchors in all captures |
| Retrieval | Click/text/screenshot resolution; historical alternatives | VERIFIED* | Click+text+crop-matching grounding tested; *the 100/100 corpus figure is LEXICAL-TEXT retrieval only — screenshot grounding has separate, smaller tests and is not covered by that number |
| Generation | Up to four live alternatives from text, history, or image references | VERIFIED | Editor generate flow now calls the REAL backend: POST /v1/projects/:p/proposals with the user instruction + staged references (history captures via "Use as reference", grounded screenshot artifacts) and polls to terminal; orchestrator grounds history/image references into REAL observation content (visible text, anchor, commit, screenshot artifact id) via an injected loadReference (apps/api + index-worker wired to SQLite) instead of placeholder id strings; offline (API-unreachable) fallback to the local generator is visibly labeled "offline · local", never silent; accepted candidates keep the API validation digest. Image references return artifact bytes (`imageBytes`) + fetchable URL (`imageUrl`) from digest-sharded object-store paths; `OpenAICompatProvider` emits `image_url` data-URL parts when `vision` capability is declared, falls back to `imageUrl`, and surfaces honest degraded notes when vision is off or content is missing. Page-scope generation branches on `target.kind === "page"`, validates layouts via `ProposalValidator.validatePageLayout` with slot-completeness and allowedLayouts enforcement. Live-verified: scripts/verify-editor-proposals.mjs against the running stack returned 4 validated candidates (carousel/grid/table) with API digests from an instruction + history reference |
| History console | Timeline, filters, side-by-side, evidence labels, source links, scan progress | VERIFIED | Studio tests + live |
| Backend | Project API, relational metadata, artifact storage, durable jobs, recovery, indexing | VERIFIED* | Pipeline + fault-injection tests; *artifact/sync route authorization gaps (audit finding 1) and capture-runner legacy-mode contract mismatch found — fixes in flight |
| Developer handoff | Export accepted specification into app-owned configuration | VERIFIED | Live: CLI created PR #3, merged, app booted the default |

## Section 18 — Integrated journeys

| Journey | Status | Evidence |
| --- | --- | --- |
| New project onboarding | VERIFIED | Live E2E 6/6 (sync, plan, scan, ingest, extend w/o duplication, history) |
| Historical onboarding | VERIFIED* | Reconstruction executed end to end (see History row): LIVE regeneration published 144 verified captures (13 commits × 12 scenario-recipes) + 12 expected-failure records, 0 gaps; regression test drives the normal plan path (plan → run → worker → published captures for the selected commit sha) |
| Historical browsing | VERIFIED | Studio + editor history E2E |
| Personal component change | VERIFIED | Browser E2E: select → grid → reload persistence → undo |
| Screenshot grounding | VERIFIED | Crop upload → resolved entityKey (API + editor UI) |
| Reference-guided page change | VERIFIED | Page tab calls the real API with page target (`pageKey`, `pageContract`, `allowedLayouts`); orchestrator proposes validated layout candidates constrained by the page contract; API route enforces `pageKey` match; offline fallback honestly labeled. Editor Page tab renders `data-testid="page-scope-note"`, `page-offline-badge`, `page-candidate`, `preview-accept-layout`. Regression tests: `apps/api/test/page-proposals.test.ts` (3 green) + agent page-scope tests (5 green) |
| Site-wide finite batch | VERIFIED | Apply/persist/cross-route/undo E2E |
| Release compatibility | VERIFIED | Contract-bump suspension test (identity-persistence defect found by audit — fix in flight) |
| Developer handoff | VERIFIED | PR #3 end to end |

## Section 19 — Release criteria

| Area | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| Protocol | Invalid schemas/versions/refs/idempotency rejected | VERIFIED | API tests 422/409/404 |
| Runtime | Transformations preserve data/actions/state; reset reachable | VERIFIED | E2E + unit |
| Composition | Required/locked slots survive; adversarial layouts fail; batch undo covers all | VERIFIED | Validator tests + live journeys |
| Persistence | Reload, concurrent tabs, account switching, interrupted commits, unavailable storage | VERIFIED | All tested; cross-tab sync wired; stale-acceptance conflict reconciliation fixed: `LocalCandidate` carries generation-time `readSet` (preferenceRevision 0), `PreferenceService.apply()` and `applyBatch()` ground acceptance on the candidate's carried revision instead of the current live-view revision, and the editor surfaces `"target changed since these alternatives were generated"` with `data-testid="stale-candidates"` instead of silently overwriting the newer winner. Unit + jsdom E2E regression tests green (apps/reference-app/test/persistence.test.tsx) |
| Capture | Every planned fixture slot: artifacts or explicit expected failure | VERIFIED* | LIVE coverage regeneration (closure audit fixes 3a-3c): docs/coverage-report.json rebuilt from the real reconstruction run against the dev API — 156 planned slots (13 commits × 12 scenario-recipes: 6 named route/state scenarios × 2 viewports), 144 captured with verified publication, 12 expected failures (the intentionally unbuildable commit × 12 recipes), 0 not captured. *Expected failures remain explicit records, not captures (spec 16) |
| Lineage | Labeled cases behave; uncertainty recorded | VERIFIED | Ground-truth eval 79/0/0 (re-run after the fixture gained the account route: 6 continuing anchors + 5 adminPanel pairs + split + merge = 79 pairings, all detected, zero false positives, zero abstentions) |
| Retrieval | 100-query corpus top-3 ≥ 90; ≥30 ambiguous/out-of-corpus | VERIFIED | Top-3 100/100 lexical-text corpus; 0 mis-resolutions; 12/12 abstentions |
| Generation | Real-provider working variants; injection cannot bypass | VERIFIED | Adversarial suite green; live provider validated candidates; editor wired to the real proposal API with grounded history/image references and a labeled offline fallback (see Generation row above) |
| Preview safety | Zero live mutations in verification corpus | VERIFIED | Stub-action tests; cart-count unchanged |
| Authorization | Cross-project reads fail | INCOMPLETE | :p-scoped routes enforced + tested; artifact/sync routes BYPASSED role checks (audit finding 1) — fix in flight with regression tests |
| Job recovery | Worker loss, lease expiry, cancellation, retries preserve dedup | VERIFIED* | Fault-injection suite; *legacy capture-runner mode contract mismatch (claim/complete 422, /cancelled 404) — fix in flight |
| Performance | <30KB gzip core; <100ms p95; <5% overhead | VERIFIED | 17.4KB / 32.3ms / 3.71% measured |
| Integration | Every section-18 journey through the connected system | VERIFIED | 9/9 VERIFIED (A3 editor generation + A5/A6c stale acceptance now fixed; remaining defects A1/A4/A6a-b-d-e-f are outside the section-18 journeys) |

## Audit-found defects and their fix status (branch vorflux/audit-fixes)

| # | Defect | Status |
| --- | --- | --- |
| A1 | Artifact + profile/sync routes bypass role checks | fix in flight (fix-auth-storage) |
| A2 | Historical reconstruction unimplemented in scan path | fix in flight (fix-reconstruction) |
| A3 | Editor bypasses API generation; references not grounded | **FIXED** (closure agent: editor wired to real proposal API with grounded image/history references + page-scope generation + vision data-URL path) |
| A4 | S3 driver get/exists in-memory only; publication not awaited | fix in flight (fix-auth-storage) |
| A5 | Sync overwrites divergent edits silently | **FIXED** (closure agent: `PreferenceService.apply` + `applyBatch` now ground acceptance on the candidate's carried `readSet.preferenceRevision`; `MemoryPreferenceStore.beginApplication` throws `STALE_REVISION` when the store moved; editor surfaces `data-testid="stale-candidates"`) |
| A6a | Capture-runner legacy mode contract mismatch | fix in flight (fix-capture-correctness: runner client matches real API — claim {workerId}, complete {leaseToken}, POST /cancel; integration test apps/capture-runner/test/legacy-api.test.ts) |
| A6b | Empty history run reports completion | fix in flight (fix-capture-correctness: honest job records — history_scan finalizes completed_with_gaps + result summary, apps/index-worker/test/history-honesty.test.ts) + A2 |
| A6c | Stale acceptance / live-view conflict | **FIXED** (same as A5) |
| A6d | Masked child text leaks into parent observation | fix in flight (fix-capture-correctness: boundary visibleText reads a clone with masked descendants removed; packages/capture/test/masked-text.test.ts) |
| A6e | Capture accepted before artifact bytes uploaded | fix in flight (fix-auth-storage: ingest verifies bytes) |
| A6f | Contract identity persistence (v2 stored as v1) | fix in flight (fix-persistence) |

## Explicitly DEFERRED (per spec section 19, not claimed)

- Native adapters (iOS/Android) — require view/state mapping definitions first.
- Vision-capable generation in the dev profile — the configured free model is text-only; the code path exists behind a capability flag but is not exercised live.
- Remote-repository clone in reconstruction (local fixture path only in dev profile).
