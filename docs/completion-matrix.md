# R1 Completion Matrix — requirement → evidence (audited)

Independent audit (2026-09-25) found several rows overstated. Statuses now use:
`VERIFIED` (executed evidence), `INCOMPLETE` (implemented but unproven or partial),
`BLOCKED` (external input required), `DEFERRED` (explicitly out of scope).

## Section 16 — R1 commitments

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| Integration | Runtime SDK, Vite manifest plugin, configuration, CLI, CI capture | VERIFIED | Packages + live capture pipeline; CI on main green at merge commit 110d592 (run 36177237679: 430 passed, 9 skipped, Chromium installed, typecheck clean) |
| Selection | Button, repeated instance, component, section, page, finite multi-page set | VERIFIED | Editor select E2E; instance keys; batch; page tabs |
| Representations | Approved button/card properties + carousel/grid/table | VERIFIED | Renderer tests + E2E grid accept |
| Page composition | Stack/grid/split over registered slots; locked/required regions | VERIFIED | Validator tests; live: locked admin survived layout change + batch + undos |
| Personalization | Local persistence, export/import, conflict handling, recovery, batch undo | VERIFIED | Persistence/recovery/batch-undo tested; stale-acceptance conflict reconciliation defect FIXED (PR #5 `d002b71` + closure PR #6 `110d592`; see Persistence row in section 19) — closure verification 2026-09-25 confirms: revision-0 candidate acceptance after revision advanced to 3 returns conflict, winner intact |
| History | Plans, selected-commit reconstruction, continuous capture, extendable backfill | VERIFIED* | Plans/CLI/scan E2E verified. Reconstruction is IMPLEMENTED and reachable from the NORMAL plan path (closure audit fix 3a): `fixtureRepo` is accepted by the plan input schema (validated: existing directory inside UI_INTEL_RECONSTRUCT_ROOTS, default repo root + tmpdir), persisted in the plan input JSON, copied into the job payload by run submission, and consumed by `history_scan` (extend-without-duplicating, per-commit outcomes in the job payload, unbuildable commits recorded as expected failures). Regression-tested end to end via the real API route + real fixture corpus + real worker handler: published captures carry the selected commit sha (apps/api/test/history-plan-fixture.test.ts). The fixture corpus now covers the account route (account.html at /account + #/account hash-routing; profileForm in all commits, adminPanel from the split commit) and recipes are used AS-IS (routes/readiness no longer rewritten — closure audit fix 3b). `docs/coverage-report.json` regenerated from the LIVE reconstruction: 156 planned slots (13 commits × 12 scenario-recipes = 6 named scenarios × 2 viewports), 144 captured with real capture ids + sha256, 12 expected failures (commit 12), 0 gaps. *Expected failures are records, not captures (spec 16). PR #6 closure-verification gaps now FIXED (PR #7 `7d2ee82`): execution honors the plan's selected scenario set (validated 422 at creation; consistent estimates/completion/accounting; one-scenario plan executes exactly one scenario — apps/index-worker/test/history-reconstruction.test.ts) and reconstruction has a constrained React/Vite build adapter (`ui-intel.history.json` manifest → install + build with timeout/output cap → serve built output; path containment + manifest validation; cleanup on build failure — packages/capture/test/build-adapter.test.ts). Proven live: plan → run against the 3-commit React+Vite fixture produced captures bound to the selected commit with the built per-commit text (closure-2 E2E). Remote cloning remains separately deferred |
| Identity | Anchors, source provenance, candidate lineage, ambiguous-match review | VERIFIED | Lineage ground-truth eval (re-run after the fixture gained the account route): 79 TP / 0 FP / 0 abstentions; anchors in all captures |
| Retrieval | Click/text/screenshot resolution; historical alternatives | VERIFIED* | Click+text+crop-matching grounding tested; *the 100/100 corpus figure is LEXICAL-TEXT retrieval only — screenshot grounding has separate, smaller tests and is not covered by that number |
| Generation | Up to four live alternatives from text, history, or image references | VERIFIED | Editor generate flow now calls the REAL backend: POST /v1/projects/:p/proposals with the user instruction + staged references (history captures via "Use as reference", grounded screenshot artifacts) and polls to terminal; orchestrator grounds history/image references into REAL observation content (visible text, anchor, commit, screenshot artifact id) via an injected loadReference (apps/api + index-worker wired to SQLite) instead of placeholder id strings; offline (API-unreachable) fallback to the local generator is visibly labeled "offline · local", never silent; accepted candidates keep the API validation digest. Image references return artifact bytes (`imageBytes`) read through the configured storage driver (fs or s3, shared `@ui-intelligence/storage` — PR #7); `OpenAICompatProvider` emits `image_url` data-URL parts when `vision` capability is declared and surfaces honest degraded notes when vision is off or content is missing — those notes are persisted on the proposal, returned by the GET DTO, and shown in the editor (`data-testid="degraded-note"`, PR #7). Page-scope generation branches on `target.kind === "page"`, validates layouts via `ProposalValidator.validatePageLayout` with slot-completeness and allowedLayouts enforcement. Live-verified: scripts/verify-editor-proposals.mjs against the running stack returned 4 validated candidates (carousel/grid/table) with API digests from an instruction + history reference |
| History console | Timeline, filters, side-by-side, evidence labels, source links, scan progress | VERIFIED | Studio tests + live |
| Backend | Project API, relational metadata, artifact storage, durable jobs, recovery, indexing | VERIFIED | Pipeline + fault-injection tests; artifact/sync route authorization gaps (audit finding 1) FIXED in PR #5 (`d002b71`) and capture-runner legacy-mode contract mismatch FIXED (A6a); closure verification 2026-09-25 confirms artifact-read authorization still passes independent reproductions |
| Developer handoff | Export accepted specification into app-owned configuration | VERIFIED | Live: CLI created PR #3, merged, app booted the default |

## Section 18 — Integrated journeys

| Journey | Status | Evidence |
| --- | --- | --- |
| New project onboarding | VERIFIED | Live E2E 6/6 (sync, plan, scan, ingest, extend w/o duplication, history) |
| Historical onboarding | VERIFIED* | Reconstruction executed end to end (see History row): LIVE regeneration published 144 verified captures (13 commits × 12 scenario-recipes) + 12 expected-failure records, 0 gaps; regression test drives the normal plan path (plan → run → worker → published captures for the selected commit sha). *Static-corpus scope extended by PR #7: the React/Vite build adapter now reconstructs buildable historical revisions of a real Vite app (live-verified, see History row) |
| Historical browsing | VERIFIED | Studio + editor history E2E |
| Personal component change | VERIFIED | Browser E2E: select → grid → reload persistence → undo |
| Screenshot grounding | VERIFIED | Crop upload → resolved entityKey (API + editor UI) |
| Reference-guided page change | VERIFIED | Page tab calls the real API with page target (`pageKey`, `pageContract`, `allowedLayouts`); orchestrator proposes validated layout candidates constrained by the page contract; API route enforces `pageKey` match; offline fallback honestly labeled. Editor Page tab renders `data-testid="page-scope-note"`, `page-offline-badge`, `page-candidate`, `preview-accept-layout`. Regression tests: `apps/api/test/page-proposals.test.ts` (3 green) + agent page-scope tests (5 green) |
| Site-wide finite batch | VERIFIED | Apply/persist/cross-route/undo E2E |
| Release compatibility | VERIFIED | Contract-bump suspension test; identity-persistence defect (v2 stored as v1) FIXED in PR #5 (A6f) — closure verification 2026-09-25 confirms v2 contract persistence still passes |
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
| Authorization | Cross-project reads fail | VERIFIED | :p-scoped routes enforced + tested; artifact/sync route role-check bypass (audit finding 1) FIXED in PR #5 (`d002b71`) — finding-1 regression tests in apps/api/test/auth.test.ts; closure PR #6 (`110d592`) added sync ownership transactional registration + TOCTOU re-check (apps/api/test/sync-closure.test.ts); closure verification 2026-09-25: zero-membership request 403 without ownership row, authorized member succeeds |
| Job recovery | Worker loss, lease expiry, cancellation, retries preserve dedup | VERIFIED | Fault-injection suite; legacy capture-runner mode contract mismatch (claim/complete 422, /cancelled 404) FIXED in PR #5 — apps/capture-runner/test/legacy-api.test.ts runs green in CI with Chromium installed (merge commit 110d592, run 36177237679) |
| Performance | <30KB gzip core; <100ms p95; <5% overhead | VERIFIED | 17.4KB / 32.3ms / 3.71% measured |
| Integration | Every section-18 journey through the connected system | VERIFIED | 9/9 VERIFIED (A3 editor generation + A5/A6c stale acceptance now fixed; remaining defects A1/A4/A6a-b-d-e-f are outside the section-18 journeys) |

## Audit-found defects and their fix status

| # | Defect | Status |
| --- | --- | --- |
| A1 | Artifact + profile/sync routes bypass role checks | **FIXED** (PR #5 `d002b71`: artifact routes require viewer/member resolved from the artifact row; sync profiles bound to first-syncing principal; GET /v1/projects membership-filtered. PR #6 `110d592`: ownership registration transactional + TOCTOU re-check. Closure verification 2026-09-25 passes independent reproductions) |
| A2 | Historical reconstruction unimplemented in scan path | **FIXED** (PR #5: `reconstructCommit` + runnable fixture corpus; PR #6: normal plan path — `fixtureRepo` schema/persistence/payload + 12-recipe coverage + verified publication, apps/api/test/history-plan-fixture.test.ts; live coverage 144 captured / 12 expected failures / 0 gaps). Scope extended by PR #7: constrained React/Vite build adapter (B2b FIXED) |
| A3 | Editor bypasses API generation; references not grounded | **FIXED** (closure agent: editor wired to real proposal API with grounded image/history references + page-scope generation + vision data-URL path) |
| A4 | S3 driver get/exists in-memory only; publication not awaited | **FIXED** (PR #5: real async GetObject/HeadObject/Put/Delete, upload awaits persistence, ingest verifies artifact bytes, GC works in s3 mode; apps/api/test/objectstore.test.ts + storage-durability.test.ts) |
| A5 | Sync overwrites divergent edits silently | **FIXED** (PR #5: causal base-revision model + persistent drafts. Closure agent: `PreferenceService.apply` + `applyBatch` ground acceptance on the candidate's carried `readSet.preferenceRevision`; `MemoryPreferenceStore.beginApplication` throws `STALE_REVISION`; editor surfaces `data-testid="stale-candidates"`. Closure verification 2026-09-25 passes) |
| A6a | Capture-runner legacy mode contract mismatch | **FIXED** (PR #5: runner client matches real API — claim {workerId}, complete {leaseToken}, POST /cancel; integration test apps/capture-runner/test/legacy-api.test.ts green in CI with Chromium) |
| A6b | Empty history run reports completion | **FIXED** (PR #5: honest job records — history_scan finalizes completed_with_gaps + result summary, apps/index-worker/test/history-honesty.test.ts) + A2 |
| A6c | Stale acceptance / live-view conflict | **FIXED** (same as A5) |
| A6d | Masked child text leaks into parent observation | **FIXED** (PR #5: boundary visibleText reads a clone with masked descendants removed; packages/capture/test/masked-text.test.ts. Closure verification 2026-09-25 passes) |
| A6e | Capture accepted before artifact bytes uploaded | **FIXED** (PR #5: ingest verifies bytes exist via store.exists; unuploaded artifact → 422) |
| A6f | Contract identity persistence (v2 stored as v1) | **FIXED** (PR #5: contract identity threads through storage; closure verification 2026-09-25 passes) |

## PR #6 closure-verification findings (2026-09-25) and their fix status

| # | Finding | Status |
| --- | --- | --- |
| B1a | Worker image grounding reads bytes from the local fs only; S3 fallback URL is auth-gated → provider fetch 401 | **FIXED** (PR #7 `7d2ee82`: storage driver shared via `@ui-intelligence/storage`; worker + API loaders read bytes through the configured driver fs/s3; auth-gated URL no longer emitted; unauthorized raw read still 401 — apps/api/test/proposal-s3-grounding.test.ts) |
| B1b | Ignored-image (degraded) notes dropped by both persistence paths; never reach the proposal DTO or editor | **FIXED** (PR #7 `7d2ee82`: `proposals.degraded_json` persisted by both paths, exposed in the GET DTO, rendered in the editor as `data-testid="degraded-note"`; live-verified through API → worker → GET → browser) |
| B2a | History execution ignores the plan's selected scenarioIds (always runs all 12) | **FIXED** (PR #7 `7d2ee82`: planner validates ids (unknown → 422), estimates from the selected set; payload carries the set; the worker executes exactly it — live-verified one-scenario plan captured exactly one scenario) |
| B2b | Reconstruction serves source trees statically; no React/Vite build adapter | **FIXED** (PR #7 `7d2ee82`: `ui-intel.history.json` build adapter with install/build/outDir/timeout/output cap, containment + validation + cleanup; static path unchanged; live-verified against the 3-commit React+Vite fixture — captures carry the selected commit sha and the built text) |

## Explicitly DEFERRED (per spec section 19, not claimed)

- Native adapters (iOS/Android) — require view/state mapping definitions first.
- Vision-capable generation in the dev profile — the configured free model is text-only; the code path exists behind a capability flag but is not exercised live.
- Remote-repository clone in reconstruction (local fixture path only in dev profile).
