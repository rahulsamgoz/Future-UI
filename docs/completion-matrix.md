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
| Retrieval | Click/text/screenshot resolution; distinct historical alternatives and comparisons | partial | Click + text done (API tests + E2E); screenshot grounding returns honest no_match — real grounding todo |
| Generation | Up to four live alternatives from text, history, or image references | partial | Live model (space-bunny-free) produced 2 validated candidates E2E 2026-09-24; image-reference generation pending; adversarial (injection) test pending |
| History console | Timeline, scenario filters, side-by-side, evidence labels, source links, scan progress | done | apps/studio; studio tests; E2E history tab in editor |
| Backend | Project API, relational metadata, artifact storage, durable jobs, recovery, indexing | done | apps/api + index-worker; lease/retry/recovery tests; live pipeline E2E |
| Developer handoff | Export accepted specification into app-owned configuration | done | Editor export + API /export; E2E export produces spec JSON |

## Section 18 — Integrated journeys

| Journey | Status | Evidence |
| --- | --- | --- |
| New project onboarding | partial | Components exist; end-to-end onboarding journey run pending |
| Historical onboarding | todo | Window/branch plan → estimate → scan → inspect → extend, not executed |
| Historical browsing | done | Studio + editor history E2E (2026-09-23) |
| Personal component change | done | Browser E2E: select → grid → accept → reload → undo (2026-09-23, re-verified post-fix) |
| Screenshot grounding | todo | Endpoint returns no_match; real crop-matching implementation needed |
| Reference-guided page change | partial | Page tab generates layouts; form-state preservation + locked regions E2E pending |
| Site-wide finite batch | partial | Batch applies compact buttons; cross-route visit + batch undo E2E pending |
| Release compatibility | done | Unit test: contract bump suspends preference as draft, retains record |
| Developer handoff | done | Editor export E2E + API export round-trip test |

## Section 19 — Release criteria

| Area | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| Protocol | Invalid schemas, unknown versions, cross-project refs, idempotency mismatch rejected | done | protocol + api tests (422/409/404 cases) |
| Runtime | Transformations preserve data/actions/state; reset reachable | done | E2E + unit; reset button present |
| Composition | Required/locked slots survive; adversarial layouts fail; batch undo covers all | partial | Validator unit tests; batch undo across participants E2E pending |
| Persistence | Reload, concurrent tabs, account switching, interrupted commits, unavailable storage | partial | Reload E2E; interrupted/storage unit tests; concurrent tabs + account switching todo |
| Capture | Every planned fixture slot ends with artifacts or explicit expected failure | todo | Coverage manifest + live subset + explicit gaps needed |
| Lineage | Labeled move/repeat/split/merge/reversion behave; uncertainty recorded | partial | Unit tests; ground-truth corpus evaluation + false-match/abstention counts pending |
| Retrieval | 100-query corpus top-3 ≥ 90; ≥30 ambiguous/out-of-corpus queries | todo | Frozen corpus + evaluation test needed |
| Generation | Real-provider proposals produce working variants; embedded instructions cannot bypass validation | partial | Live provider E2E done; adversarial injection test todo |
| Preview safety | Zero live mutation calls in verification corpus | partial | Unit test (cart count unchanged); instrumented corpus run pending |
| Authorization | Cross-project artifact/source/proposal reads fail | done | API isolation tests |
| Job recovery | Worker loss, lease expiry, cancellation, retries preserve dedup | partial | Lease unit tests; fault-injection (kill worker mid-job) pending |
| Performance | Bundle <30KB gzip core; <100ms p95 switch; <5% build overhead | todo | Benchmark script + measured report needed |
| Integration | Every section-18 journey executes through the connected system | partial | 4/9 journeys done |

## Open review findings to preserve/fix

| Finding | Status |
| --- | --- |
| Cross-tab conflict handling + PreferenceBroadcast wiring (capture#8) | todo |
| Undo revision monotonicity (core#12) | todo |
| Application-record pruning (core#15) | todo |
| Uploader retry/backoff (capture#11) | todo |
| Validator checkedInvariants bookkeeping (core#9) | todo |
| Logical-parent selection for repeated instances (capture#15) | todo |
| Capture readiness: default scenario recorded empty-state text | todo (new finding) |

## Known dev-profile boundaries (accepted, documented)

- Single operator token; per-project isolation at data layer only.
- space-bunny-free as configured model provider (swap via infra/dev/model.env).
- No device sync, no native adapters, no general source rewriting (post-R1 per spec).
