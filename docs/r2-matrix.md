# R2 Completion Matrix — requirement → evidence

Status values: `done` (executed evidence exists), `partial`, `todo`.
Companion to docs/r2-plan.md. R1 matrix: docs/completion-matrix.md (all done).

## A. Framework expansion (Next.js)
| Requirement | Status | Evidence |
| --- | --- | --- |
| Second web framework (Next.js) runs the same protocol contracts, runtime-core, react adapter, renderers | done | `apps/next-demo` (Next 15.5.26 App Router, `output: "export"`): `src/contracts.ts` redeclares the SAME `catalog.productChooser` + `ui.primaryButton` entity keys/allowed representations as the Vite reference app; kernel = `@ui-intelligence/runtime-core` RuntimeKernel + `registerAllRenderers`, boundaries via `@ui-intelligence/react` UiBoundary with `@ui-intelligence/renderers` components; host-owned live bindings (`product.open` → details drawer, `ui.action` → acknowledgment). `npx next build` succeeds (static export, route `/` prerendered, / 21.2 kB). 4 vitest tests in `apps/next-demo/test/app.test.tsx` pass (chooser renders demo products, data-ui-entity attributes on both boundaries, drawer opens through the live action, button boundary renders + invokes). |
| Capture works unchanged against the Next.js app | done | Served the exported `out/` on http://localhost:3100 (tiny node static server): `curl` HTTP 200, page HTML contains `data-ui-entity="catalog.productChooser"` (data-ui-instance="catalog.main") and `data-ui-entity="ui.primaryButton"` (data-ui-instance="ui.toggle"), plus current product names and button label — the exact DOM contract `packages/capture` ScenarioRunner records, so capture runs unchanged against a plain static server. |

## B. Device synchronization
| Requirement | Status | Evidence |
| --- | --- | --- |
| Server sync endpoint merges device bundles by highest revision | todo | |
| Client SyncManager drains outbox, pushes, pulls, applies | todo | |
| Conflict policy: no silent overwrite; divergent equal revisions retained as draft | todo | |
| Two devices converge | todo | |

## C. Persistent semantic rules
| Requirement | Status | Evidence |
| --- | --- | --- |
| Versioned rule schema validated against contracts | todo | |
| RuleEngine: preference > rule > default precedence | todo | |
| Rules stored per profile, exportable, editable in UI | todo | |
| Browser evidence: rule drives compact on mobile; explicit preference overrides rule | todo | |

## D. Managed historical runners
| Requirement | Status | Evidence |
| --- | --- | --- |
| runner-manager service schedules capture sets | todo | |
| Bounded worker pool with retries/heartbeats | todo | |
| CLI `history submit` | todo | |
| End-to-end run with reference app + fixture commits | todo | |

## E. Developer handoff → PR
| Requirement | Status | Evidence |
| --- | --- | --- |
| CLI writes accepted spec into app-owned config file | done | packages/cli handoff command (handoff.ts): accepted proposal → ui-intelligence.preferences.json entry with provenance; 5 unit tests incl. merge-by-scopeKey and no-candidate failure |
| App boots defaults from config (app defaults < org < personal precedence) | done | PreferenceService.loadAppDefaults fetches the file and fills ONLY gaps (explicit personal preference wins by the active.get check); public/ scaffold serves it |
| Branch + commit + PR created | done | LIVE 2026-09-25: real accepted proposal proposal_cbcf351caf484f83bb3fe239 → branch vorflux/handoff/... → commit → PR https://github.com/rahulsamgoz/Future-UI/pull/3 |

## F. Per-user auth
| Requirement | Status | Evidence |
| --- | --- | --- |
| Users, hashed API keys, project memberships, roles | done | authz.ts: users + api_keys (SHA-256 hashed, plaintext shown once) + project_members (owner/member/viewer) tables; operator token remains full owner (back-compat); POST/GET /v1/users provisioning (operator-only) |
| Role enforcement (owner/member/viewer) on all routes | todo | preHandler gate: project-scoped GET ≥ viewer, mutations ≥ member; 6/6 auth tests |
| Cross-user denial tests | done | auth.test.ts: user with membership only in project A denied 403 on project B ("no membership"); viewer denied writes ("below required member"); member denied provisioning |

## G. Remote storage + retention/GC
| Requirement | Status | Evidence |
| --- | --- | --- |
| StorageDriver interface, fs + s3 drivers | todo | |
| Reference-aware GC deletes orphans, keeps referenced | todo | |
| Retention policy honored (originals + derived) | todo | |

## H. Cloud deployment artifacts
| Requirement | Status | Evidence |
| --- | --- | --- |
| Dockerfiles + compose build successfully | todo | |
| CI workflow (tests + capture template) | todo | |
