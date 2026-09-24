# R1 Completion Matrix — requirement → evidence

Status values: `done` (executed evidence exists), `partial` (implemented, evidence incomplete), `todo`.
This file is updated as work completes. Evidence must be actual execution, not implementation claims.

## Section 16 — R1 commitments

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| Integration | Runtime SDK, Vite manifest plugin, configuration, CLI, CI capture | done | packages/{runtime-core,react,renderers,vite,cli}; E2E capture via ScenarioRunner (2 scenarios, 2026-09-23); manifest test asserts public/private separation |
| Selection | Button, repeated instance, component, section, page, finite multi-page set | done | Editor select (E2E 2026-09-23); instance keys catalog.main/catalog.related; batch tab; page tab |
| Representations | Approved button/card properties + carousel/grid/table | done | renderers package; 192-test suite; E2E grid accept |
| Page composition | Stack/grid/split over registered slots; locked/required regions | done | PageComposer + ProposalValidator.validatePageLayout; account admin locked region E2E |
| Personalization | Local persistence, export/import, conflict handling, recovery, batch undo | partial | IndexedDB persistence E2E (reload survives); unit tests for conflict/recovery; cross-tab conflict handling NOT wired (review finding); batch undo E2E pending |
| History | Time-window/branch plans, selected-commit reconstruction, continuous capture, extendable backfill | partial | CLI history plan/run implemented + unit tested; live scan not executed against fixture corpus; "extend without duplicating" unverified |
| Identity | Explicit anchors, source provenance, candidate lineage, ambiguous-match review | partial | Anchors in capture; lineage_candidates unit tests; ground-truth evaluation on fixture corpus pending |
| Retrieval | Click/text/screenshot resolution; distinct historical alternatives and comparisons | partial | Click + text done (API tests + E2E); screenshot grounding done (visual.ts crop matcher + /resolve wiring; 4 API tests: resolved/ambiguous/no_match/404) |
| Generation | Up to four live alternatives from text, history, or image references | partial | Live model (space-bunny-free) produced 2 validated candidates E2E 2026-09-24; image-reference generation pending; adversarial (injection) test pending |
| History console | Timeline, scenario filters, side-by-side, evidence labels, source links, scan progress | done | apps/studio; studio tests; E2E history tab in editor |
| Backend | Project API, relational metadata, artifact storage, durable jobs, recovery, indexing | done | apps/api + index-worker; lease/retry/recovery tests; live pipeline E2E |
| Developer handoff | Export accepted specification into app-owned configuration | done | Editor export + API /export; E2E export produces spec JSON |

## Section 18 — Integrated journeys

| Journey | Status | Evidence |
| --- | --- | --- |
| New project onboarding | done | Live E2E (UI_INTEL_E2E=1, 6/6 2026-09-24): commit sync, plan, scan job completion, capture ingest, extension without duplication, history retrieval with gaps |
| Historical onboarding | done | packages/cli/test/onboarding.e2e.test.ts live 6/6: 13 fixture commits synced, plan with estimate+uncertainty, scan succeeded, extended window re-scanned with zero re-ingestion (same capture rows, observation counts unchanged) |
| Historical browsing | done | Studio + editor history E2E (2026-09-23) |
| Personal component change | done | Browser E2E: select → grid → accept → reload → undo (2026-09-23, re-verified post-fix) |
| Screenshot grounding | done | packages/indexing/src/visual.ts crop matcher (11 unit tests) + apps/api resolve grounding (resolved ≥0.90 with 1.15x margin, ambiguous top-3 shortlist, no_match abstain; 4 API tests incl. out-of-project 404); editor + studio upload UI |
| Reference-guided page change | done | Live 2026-09-24: page tab generated 4 validated layouts, grid@1 accepted, all 3 slots present (sort/chooser/related), persisted across reload, undo restored stack; form state transfer: typed value 'Casey Test' preserved across form.standard→form.compact switch (after fix syncing edits to the state adapter); locked admin region intact throughout |
| Site-wide finite batch | done | Live 2026-09-24: button boundary selected on account route, batch applied compact (one preference revision), persisted across reload, catalog route verified rendering, locked admin intact, batch undo restored 'btn primary default' |
| Release compatibility | done | Unit test: contract bump suspends preference as draft, retains record |
| Developer handoff | done | Editor export E2E + API export round-trip test |

## Section 19 — Release criteria

| Area | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| Protocol | Invalid schemas, unknown versions, cross-project refs, idempotency mismatch rejected | done | protocol + api tests (422/409/404 cases) |
| Runtime | Transformations preserve data/actions/state; reset reachable | done | E2E + unit; reset button present |
| Composition | done | Validator unit tests (adversarial layouts rejected); live journey: locked admin + all required slots survived page-layout change AND batch application AND both undos |
| Persistence | Reload, concurrent tabs, account switching, interrupted commits, unavailable storage | done | Reload E2E + interrupted/storage unit tests; concurrent-tab live-view sync via PreferenceBroadcast + handleRemoteCommit (broadcast.test.tsx, 2 tabs on one store); account switching via switchProfile (namespace rehydration, no cross-profile digest leak); undo monotonicity + tombstone import-regression and pruneApplications tests (2026-09-24) |
| Capture | Every planned fixture slot ends with artifacts or explicit expected failure | todo | Coverage manifest + live subset + explicit gaps needed |
| Lineage | Labeled move/repeat/split/merge/reversion behave; uncertainty recorded | done | fixtures/history/test/lineage-eval.test.ts over the 13-commit fixture: 12 consecutive pairs vs 38 ground-truth pairings → 38 true positives, 0 false matches, 0 abstentions; split/merge recorded at score 0.6 with jaccard rationale; reversion pair continues_as 1.0 across A→B→A (2026-09-24). Heuristic fix: split/merge now require Jaccard ≥ 0.3 (review finding) + new-anchor split/vanished-anchor merge passes |
| Retrieval | 100-query corpus top-3 ≥ 90; ≥30 ambiguous/out-of-corpus queries | done | Frozen corpus fixtures/retrieval (53 entities, 100 known-target, 20 ambiguous, 12 no-match); eval: top-1 97/100, top-3 100/100 (≥90 required); ambiguous: 15 returned ambiguous + 5 resolved to expected key, 0 mis-resolutions; 12/12 no_match (2026-09-24). Scoring fix: stopword-aware lexical query scoring |
| Generation | Real-provider proposals produce working variants; embedded instructions cannot bypass validation | partial | Live provider E2E done; adversarial injection tests done (packages/agent/test/adversarial.test.ts: unauthorized types, unknown keys, out-of-range values, injection payloads in summaries/references/instructions all dropped or repaired, 0 injected keys in accepted candidates; orchestrator now synthesizes candidate summaries from validated fields; apps/api/test/spec-validator.test.ts: manifest-seeded validator rejects unknown property keys); image-reference generation pending |
| Preview safety | done | Unit: preview interactions leave cart count unchanged; stub action bindings record calls and never reach live implementations (renderers test); preview renderers receive only controlled providers |
| Authorization | Cross-project artifact/source/proposal reads fail | done | API isolation tests |
| Job recovery | Worker loss, lease expiry, cancellation, retries preserve dedup | partial | Lease unit tests; fault-injection (kill worker mid-job) pending |
| Performance | Bundle <30KB gzip core; <100ms p95 switch; <5% build overhead | todo | Benchmark script + measured report needed |
| Integration | Every section-18 journey executes through the connected system | partial | 4/9 journeys done |

## Open review findings to preserve/fix

| Finding | Status |
| --- | --- |
| Cross-tab conflict handling + PreferenceBroadcast wiring (capture#8) | fixed — PreferenceService instantiates PreferenceBroadcast, notifies on apply/applyBatch/undo/resetAll; handleRemoteCommit re-reads store into live view (broadcast.test.tsx) |
| Undo revision monotonicity (core#12) | fixed — undo writes previousDigest at revision = current+1 (tombstone when none); apply→export→undo→import regression test in preferences.test.ts |
| Application-record pruning (core#15) | fixed — pruneApplications(keepLast=50) on both stores, never touches active/pending; called fire-and-forget after undo; test: 60 failed + 1 active → 50 kept |
| Uploader retry/backoff (capture#11) | fixed — fetchWithRetry: 3 attempts, 250ms×2ⁿ backoff, retries network errors/5xx/429 only; PUT retries same slot URL; zero-artifact manifest fails fast (uploader.test.ts) |
| Validator checkedInvariants bookkeeping (core#9) | fixed — schema-failure early return reports ["schema"] only; locked_regions declared in validatePageLayout checked list; empty compatibleRenderers documented as unrestricted |
| Logical-parent selection for repeated instances (capture#15) | fixed — findLogicalParent prefers the tracked instance whose node contains the child in the DOM, falls back to latest (ui-boundary.test.tsx) |
| Capture readiness: default scenario recorded empty-state text | todo (new finding) |

## Known dev-profile boundaries (accepted, documented)

- Single operator token; per-project isolation at data layer only.
- space-bunny-free as configured model provider (swap via infra/dev/model.env).
- No device sync, no native adapters, no general source rewriting (post-R1 per spec).
