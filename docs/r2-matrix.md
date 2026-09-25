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
| Server sync endpoint merges device bundles by highest revision | done | `POST /v1/profiles/:profileId/sync` (apps/api/src/routes/sync.ts + src/sync.ts); `synced_preferences` table in apps/api/src/schema.ts and infra/dev/schema.sql; one-transaction merge — apps/api/test/sync.test.ts ("merges device bundles…" asserts classification + authoritative state + table rows) |
| Client SyncManager drains outbox, pushes, pulls, applies | done | packages/preferences/src/sync.ts `SyncManager.syncNow` (export → enqueueSync before push → push → clearSync after success → applyAuthoritative) + `startAutoSync`; packages/preferences/test/sync.test.ts ("pushes the local bundle, enqueues the outbox before the push…", "startAutoSync pushes on the interval until stopped") |
| Conflict policy: no silent overwrite; divergent equal revisions retained as draft | done | Server marks equal-revision/different-digest keys serverWins+retainedAsDraft (apps/api/src/sync.ts); client keeps the server record in the store and the local spec in `SyncManager.drafts` (documented in-memory Map); tests: apps/api/test/sync.test.ts + packages/preferences/test/sync.test.ts ("divergent equal-revision retained as draft and NOT silently applied" assertions) |
| Two devices converge | done | packages/preferences/test/sync.test.ts ("converges two stores: device 2's higher revision is accepted, device 1 pulls it back") — after both syncs, both stores hold revision-2 chooser + the server's button spec; apps/api/test/sync.test.ts exercises the same flow through the HTTP endpoint |

## C. Persistent semantic rules
| Requirement | Status | Evidence |
| --- | --- | --- |
| Versioned rule schema validated against contracts | done | `packages/protocol/src/rules.ts` (`semanticRuleSchema`, version 1, representation non-empty, properties record); stores reject malformed rules with `SCHEMA_INVALID` on write (`packages/preferences/test/rules.test.ts`, 12 tests); rule properties additionally validated against the renderer property schema at evaluation (`packages/runtime-core/test/rules.test.ts`) |
| RuleEngine: preference > rule > default precedence | done | `packages/runtime-core/src/rules.ts` — `evaluate` returns the last matching enabled rule (later rules win) whose representation is contract-allowed and whose properties conform to the registry schema; `RuleEngine.resolveRepresentation` implements explicit preference > rule > contract default. Evidence: `packages/runtime-core/test/rules.test.ts` (17 tests: matching, disabled skip, nonconforming skip, later-rule-wins, precedence); reference-app hook `useResolvedRepresentation` applies it for both product chooser instances and the account export button |
| Rules stored per profile, exportable, editable in UI | done | `getRules`/`putRules` on `PreferenceStore` (memory + IndexedDB) storing the whole list as ONE record under reserved scopeKey `__rules__` (scope `app`) — travels in `exportBundle`/`importBundle` (`packages/preferences/test/rules.test.ts` round-trip test); editor "rules" tab with validated dropdowns (entity from app contracts, representation from `allowedRepresentations`, viewport/route, compact toggle for `button.compact@1`), enable/disable + delete (`apps/reference-app/src/editor/RulesTab.tsx`; testids `rules-tab`, `rule-create`, `rule-list`, `rule-item`, `rule-delete`) |
| Browser evidence: rule drives compact on mobile; explicit preference overrides rule | done | `apps/reference-app/test/rules.test.tsx` (jsdom, 4 tests): matchMedia stub → mobile; rule "compact on mobile for ui.primaryButton" created via the Rules tab renders the export button compact with NO explicit preference; accepting a `button.default@1` preference in the editor overrides the rule; undo returns to compact (rule); disabling the rule reverts to the contract default; desktop viewport unaffected |

## D. Managed historical runners
| Requirement | Status | Evidence |
| --- | --- | --- |
| runner-manager service schedules capture sets | done | apps/runner-manager (Fastify + SQLite `RUNNER_DB`): POST /v1/runs → 202 {runId}, GET /v1/runs/:id with per-scenario results, worker register/heartbeat/claim, lease-checked idempotent complete. 9 unit tests green (`npx vitest run apps/runner-manager/test/manager.test.ts`). |
| Bounded worker pool with retries/heartbeats | done | `runPool(count, opts)` spawns capture-runner children (RUNNER_MANAGER_URL/APP_URL env) with restart-on-death, or embedded in-process workers for tests; workers heartbeat every 10s, one run per worker, lease expiry / worker death re-queues the run (tests: re-claim after expiry, dead-worker re-queue, bounded retries 3 attempts, embedded pool of 2 drains 2 runs). |
| CLI `history submit` | done | packages/cli `history submit --repo --commit --scenarios [--manager]`: POSTs the run, prints runId, polls to terminal, optional --out. Unit tests with a fetch stub verify argv parsing + request shape (packages/cli/test/submit.test.ts, 4 green). |
| End-to-end run with reference app + fixture commits | done | UI_INTEL_E2E=1 apps/runner-manager/test/manager.e2e.test.ts against the live reference app on :5173: manager on an ephemeral port + pool of 2 real capture-runner workers executed `catalog-default-desktop` and `catalog-empty-desktop` at HEAD 895a7c1 via ScenarioRunner; run reached succeeded with capture_b624d294… and capture_1dad273d… (1 passed, 1.6s). |

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
| Role enforcement (owner/member/viewer) on all routes | done | preHandler gate in server.ts: project-scoped GET/OPTIONS ≥ viewer, mutations ≥ member; project creation + user provisioning operator-only; 6/6 auth tests incl. viewer-write-denied and member-provision-denied |
| Cross-user denial tests | done | auth.test.ts: user with membership only in project A denied 403 on project B ("no membership"); viewer denied writes ("below required member"); member denied provisioning |

## G. Remote storage + retention/GC
| Requirement | Status | Evidence |
| --- | --- | --- |
| StorageDriver interface, fs + s3 drivers | done | apps/api/src/objectstore.ts: `StorageDriver` (put/get/delete/exists), `FsStorageDriver` (R1 digest-sharded layout preserved), `S3StorageDriver` (@aws-sdk/client-s3, `{bucket, prefix, client}` with client injectable, env `UI_INTEL_S3_BUCKET`), `createStorageDriver` factory on `UI_INTEL_STORAGE_DRIVER` (fs default; missing bucket → logged fs fallback); ObjectStore keeps its API (digest verification inside, `persisted` promise surfaced for async drivers). Tests: apps/api/test/objectstore.test.ts (fake-client S3 assertions incl. key prefixing, fs layout, factory fallback) |
| Reference-aware GC deletes orphans, keeps referenced | done | apps/api/src/gc.ts `runGc` (+ `POST /v1/projects/:p/gc` in src/routes/gc.ts, scheduled daily pass in apps/index-worker/src/gc.ts gated by `GC_RETENTION_DAYS` + `gc_runs`); apps/api/test/gc.test.ts (old-referenced deleted + bytes gone, fresh-referenced kept, old orphan deleted, fresh orphan kept, dryRun no-op, >50% guard aborts unless forced, route-level test) and apps/index-worker/test/gc.test.ts (daily gating, fs byte deletion, s3 skip, guard) |
| Retention policy honored (originals + derived) | done | Retention window (days) is the single policy input on both the API route (`retentionDays` body or `GC_RETENTION_DAYS`) and the worker; deletion removes rows AND object bytes so derived previews sharing an artifact row share fate; artifacts of the current build's captures and any reference inside the window are never deleted (tested: "keeps artifacts whose latest reference is within retention…", "old reference on the CURRENT build → kept"). Dev-profile note: no derived embedding/preview rows exist yet (spec 14 "embedding_spaces/embeddings" tables are post-R1); the artifact-level rule already covers them |

## H. Cloud deployment artifacts
| Requirement | Status | Evidence |
| --- | --- | --- |
| Dockerfiles + compose build successfully | done | Multi-stage node:22-slim Dockerfiles for api / index-worker / runner-manager (HEALTHCHECK /health) and nginx:alpine images for studio + reference-app (nginx.conf with /v1 proxy to api); root .dockerignore; docker-compose.yml (shared network, data volume, restart policies, depends_on healthy). Built all five in the sandbox: api/index-worker/runner-manager 481MB each, studio 93.8MB, reference-app 94MB. Smoke-tested containers: api + manager /health and bearer-authenticated /v1 calls, POST /v1/runs → 202, studio + reference-app SPA served with /v1 proxied to api. Full `docker compose up` verified (all 5 services healthy; index-worker needed infra/dev/schema.sql copied into its image). |
| CI workflow (tests + capture template) | done | .github/workflows/ci.yml (push/PR → node 22, npm ci, npx tsc -b, npx vitest run without UI_INTEL_E2E). .github/workflows/capture.yml (workflow_dispatch inputs repoUrl/commitSha/scenarios → starts api + manager with RUNNER_POOL_COUNT=2 + reference app, npx playwright install chromium, CLI history submit, coverage report, uploads run-result.json + coverage-report.json). YAML parsed and validated locally (python3 -c yaml.safe_load); the workflows have not run on GitHub from this sandbox — capture.yml is a template. |
