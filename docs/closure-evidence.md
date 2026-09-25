# Closure Audit Evidence (2026-09-25)

Second-pass audit of merged main (`d002b71`, PR #5). Six findings, each reproduced first, then fixed and pinned with regression tests on branch `vorflux/closure`.

| Finding | Severity | Status |
|---------|----------|--------|
| 1. Rejected sync request claims profile ownership | P1 | FIXED |
| 2. Sync namespace mismatch (client project id vs canonical) | P1 | FIXED |
| 3. Normal history-plan path cannot reach reconstruction | P1 | FIXED |
| 4. Image/historical-reference generation unwired; page generation incomplete | P1 | FIXED |
| 5. Old candidate overwrites newer preference after broadcast refresh | P1 | FIXED |
| 6. Merged-main CI red (missing Chromium) | P2 | FIXED |

---

## Audit Finding 1 — Rejected sync request claims profile ownership

### Reproduction

`apps/api/src/routes/sync.ts` inserted the `sync_profiles` ownership row **before** authorization. A push from a user with zero project membership returned 403, but the ownership row was already written — the first (unauthorized) caller permanently claimed the profile, and the legitimate member could never sync it afterward.

### Fixes applied

| Fix | Files |
|-----|-------|
| **1.1** Authorization (project resolution + membership check) runs FIRST; nothing is written on a rejected request. | `apps/api/src/routes/sync.ts` |
| **1.2** Profile registration moved inside the merge transaction: `mergeSyncBundle()` accepts `options.registerProfileOwner` and inserts the `sync_profiles` row in the same `.run()` transaction as the successful merge. A failed merge leaves no ownership row. | `apps/api/src/sync.ts`, `apps/api/src/routes/sync.ts` |

### Regression tests

```bash
npx vitest run apps/api/test/sync-closure.test.ts
# Result: 4 passed
```

- `"a zero-membership user's 403 does NOT register the profile; a member can then claim it"` — rejected push writes no row; the authorized member subsequently claims the profile.
- `"a 404 for an unknown project also leaves no ownership row"` — unknown project rejection is row-free.

---

## Audit Finding 2 — Sync namespace mismatch

### Reproduction

The reference app syncs under its project **name** (`reference-app`); stored rows are canonical (`proj_reference_app`). The sync route returned the authoritative bundle keyed by the canonical id, but `SyncManager` keyed its merge by the id it submitted — the client never recognized the server's bundle as its own and devices diverged silently.

### Fixes applied

| Fix | Files |
|-----|-------|
| **2.1** Server-side `relabelAuthoritativeProjectId()` translates the authoritative bundle back into the caller's namespace at the response boundary; stored rows stay canonical. | `apps/api/src/sync.ts`, `apps/api/src/routes/sync.ts` |
| **2.2** The relabel never leaks records from other projects into the caller's bundle. | `apps/api/src/sync.ts` |

### Regression tests

```bash
npx vitest run apps/api/test/sync-closure.test.ts
# Result: 4 passed
```

- `"device B receives device A's preference and both sides see the submitted project id"` — integration: two real `SyncManager` instances over the real Fastify sync route converge; divergent edits retain persistent drafts.
- `"never leaks records from other projects into the authoritative bundle"` — cross-project isolation under relabeling.

---

## Audit Finding 3 — Normal history-plan path cannot reach reconstruction

### Reproduction

**3a — fixtureRepo stripped at the plan schema:**
```bash
curl -s -X POST "http://localhost:8787/v1/projects/proj_reference_app/history-plans" \
  -H "authorization: Bearer dev-token" -H "content-type: application/json" \
  -d '{"input":{"repository":"https://example.com/r","branches":["main"],"windowStart":"2026-01-01T00:00:00.000Z","windowEnd":"2026-02-01T00:00:00.000Z","scenarioIds":[],"maxBuilds":1,"renderBudgetMs":60000,"timezone":"UTC","fixtureRepo":"/tmp/does-not-matter"}}'
```
Response before the fix: the returned `input` field did **not** contain `fixtureRepo` — the Zod schema had no `fixtureRepo` field, so it was stripped. The run submission then created a job payload with `{planId, projectId}` only, the worker never saw a repo path, and `handleHistoryScan` fell into `finalizeIndexOnlyScan`, producing `completed_with_gaps`.

**3b — recipe adaptation rewrote every route to `/`:**
`packages/capture/src/reconstruct.ts` `tolerantRecipe` set `route: "/"` and `readiness.selector: "[data-ui-entity]"`, so account scenarios (`/#/account`) actually loaded the catalog page and catalog scenarios captured the catalog page — the account page was never exercised.

**3c — only 6 per-viewport recipes existed (5 desktop + 1 mobile):**
`standardScenarios()` returned 6 recipes total, not 12. The spec arithmetic "6 scenarios × 2 viewports" was not met; the coverage manifest counted only 78 planned slots, not 156.

**3d — managed executor used a constant digest "runner-managed":**
`apps/runner-manager/src/executor.ts` hard-coded `buildArtifactDigest: "runner-managed"` regardless of what page was actually served, and did not distinguish a local repoUrl from a remote one — it never verified the commit was actually reconstructed.

---

### Fixes applied

| Fix | Files |
|-----|-------|
| **3a.1** `fixtureRepo: z.string().min(1).optional()` added to `historyPlanInputSchema`; validated with `resolveFixtureRepo` (existing directory, inside `UI_INTEL_RECONSTRUCT_ROOTS` default `repo root + tmpdir`; rejects absolute paths outside allowlist and remote URLs). Resolved absolute path persisted in plan input JSON. | `apps/api/src/routes/projects.ts`, `apps/api/src/planner.ts` |
| **3a.2** Run submission copies `plan.input.fixtureRepo` into the job payload so `handleHistoryScan` receives it. | `apps/api/src/routes/projects.ts` |
| **3a.3** CLI `history plan` gains `--fixture-repo <path>`; passed through to plan input. | `packages/cli/src/cli.ts`, `packages/cli/src/history.ts` |
| **3a.4** `HistoryPlanInput` type extended with optional `fixtureRepo` (additive protocol change). | `packages/protocol/src/ports.ts` |
| **3b.1** Fixture generator adds `account.html` + `account.js` per commit; `index.html` hash-routes `/#/account` → `account.html`. Profile form (`account.profileForm`) present in all commits; admin panel (`account.adminPanel`) added from the split commit (commit 8) onward. Broken commit also breaks `account.js` so all 12 scenarios fail honestly. | `fixtures/history/generate.mjs` |
| **3b.2** `tolerantRecipe` stops rewriting routes/readiness — recipes are used as-is. `serveStatic` maps `/account` → `account.html`, other paths → `index.html`. | `packages/capture/src/reconstruct.ts` |
| **3c** `standardScenarios()` expanded to 12 recipes: 6 named scenarios (`catalog-default`, `catalog-empty`, `catalog-loading`, `account-default`, `account-loading`, `account-error`) each in desktop and mobile. | `packages/capture/src/scenarios.ts` |
| **3d.1** New shared `executeManagedRun` in `@ui-intelligence/capture`: local `repoUrl` → `reconstructCommit` (worktree → serve → capture → publish → verify), provenance `mode: "reconstructed"`; absent/remote → capture `APP_URL`, compute `buildArtifactDigest` from hash of first response HTML, provenance `{mode: "live-app", note: "commit binding asserted, not verified — remote/absent repoUrl"}`. | `packages/capture/src/reconstruct.ts`, `packages/capture/src/index.ts` |
| **3d.2** Runner-manager `defaultExecutor` and capture-runner `executeRunScenarios` both delegate to `executeManagedRun`. | `apps/runner-manager/src/executor.ts`, `apps/capture-runner/src/managed.ts` |
| **3d.3** Run result provenance persisted through `store.ts` `completeRun` and returned by GET `/v1/runs/:id`. | `apps/runner-manager/src/store.ts`, `apps/runner-manager/src/server.ts` |

---

### Regression tests

```bash
# Scoped tests (all green)
npx vitest run packages/capture apps/capture-runner apps/runner-manager \
  apps/api apps/index-worker fixtures/history packages/cli
# Result: 177 passed, 9 skipped (gated E2Es)
```

Key new tests:
- `apps/api/test/history-plan-fixture.test.ts` (3 green) — end-to-end: create plan WITH `fixtureRepo` via the real API, run it, assert job payload carries `fixtureRepo`, then `handleHistoryScan` reconstructs the selected commit and published captures carry that commit sha.
- `apps/runner-manager/test/executor.test.ts` (4 green) — local repoUrl triggers reconstruction path; no repoUrl triggers live-app path with honest provenance note and HTML-derived build digest; remote repoUrl same.
- `apps/capture-runner/test/managed-publication.test.ts` (4 green) — updated to verify the provenance note and the HTML-derived digest in live-app mode.

---

### Coverage regeneration (LIVE)

```bash
node fixtures/history/coverage.mjs
```

Result (written to `docs/coverage-report.json`):
- **156 planned slots** (13 commits × 12 scenario-recipes)
- **144 captured** (verified publication: capture retrievable, occurrences > 0, artifact bytes readable)
- **12 expected failures** (intentionally unbuildable commit × 12 recipes)
- **0 not_captured / 0 gaps**
- **72 account-route captured slots** (account-default, account-loading, account-error across desktop + mobile, all 13 buildable commits)

The fixture corpus now honestly covers both routes at both viewports. Reconstruction was run LIVE against the dev API (`http://localhost:8787`).

---

### Type-check

```bash
npx tsc -b packages/protocol packages/capture apps/runner-manager \
  apps/capture-runner packages/cli apps/api apps/index-worker
# EXIT:0 — clean
```

---

### Peer-owned failures (not in my scope)

Full `npx vitest run` reports **1 failure** in `apps/reference-app/test/persistence.test.tsx` (stale-candidate DOM test), owned by the `close-sync` / `fix-persistence` peer agent. All other 425 tests pass (9 skipped gated E2Es).

---

### Updated evidence rows

- `docs/r2-matrix.md` — Row D (Managed historical runners) updated with the 156-slot live regeneration numbers and the honest provenance / commit-verification details.
- `docs/completion-matrix.md` — History row updated with the normal-plan-path reconstruction reachability and 156-slot coverage; Capture row updated with the 144/12/0 live totals; Identity/Lineage rows updated to 79 TP / 0 FP / 0 abstentions (re-run after the fixture gained the account route).

---

## Audit Finding 4 — Image/historical-reference generation unwired; page generation incomplete

### Reproduction

**4a — Image references were loaded as `{ summary }` text blobs only:**
`apps/api/src/references.ts` `dbReferenceLoader` returned `{ kind: "image", summary }` with no artifact bytes or URL. The provider could not send visual input to the model.

**4b — OpenAI-compatible provider had no vision path:**
`packages/agent/src/openai-compat.ts` `userContent()` emitted only text parts, even when a reference carried `imageBytes` or `url`. The model never saw screenshots or uploaded images.

**4c — Page-scope proposals were not implemented:**
`targetQuerySchema` had no `page` discriminant. The orchestrator had no `proposePage()` method. `processProposal()` branched only on `selection` targets. The editor Page tab had no API path.

### Fixes applied

| Fix | Files |
|-----|-------|
| **4a.1** `dbReferenceLoader` now accepts `store?: ObjectStore` and `publicApiBase?: string`. Image references read artifact bytes from digest-sharded store path and return `{ imageBytes, imageUrl, imageMediaType }`. History references also return screenshot bytes/URL when the capture manifest contains a `screenshot-png` artifact. | `apps/api/src/references.ts`, `apps/index-worker/src/worker.ts` |
| **4a.2** Reference-loader unit tests assert bytes + URL for uploaded PNG and history screenshot artifact. | `apps/api/test/references.test.ts` |
| **4b.1** `ProviderReference` extended with `imageBytes?: Uint8Array`, `imageUrl?: string`, `imageMediaType?: string`. `ModelProvider` interface gains `capabilities?: { vision?: boolean }`. | `packages/agent/src/provider.ts` |
| **4b.2** `OpenAICompatProvider` exposes `readonly capabilities` from options. `userContent()` is bytes-first: when `vision` is enabled and a reference carries `imageBytes`, emits `image_url` part with `data:image/png;base64,...` data URL. Falls back to `imageUrl` (or legacy `url`) only when `imageBytes` absent. Added `bytesToBase64()` helper. | `packages/agent/src/openai-compat.ts` |
| **4b.3** Orchestrator surfaces honest degraded notes: `"N image reference(s) ignored: provider not vision-capable"` or `"carried no usable image content"` in `ProposeResult.degraded`; never silently drops. | `packages/agent/src/orchestrator.ts` |
| **4c.1** `targetQuerySchema` gains `page` discriminant: `{ kind: "page", pageKey, pageContract }`. | `packages/protocol/src/request.ts` |
| **4c.2** Orchestrator adds `ProposePageTarget`, `PAGE_LAYOUT_RENDERER_SCHEMAS`, `imageReferenceNote()`, `entityContractsForPage()`, and `proposePage()`: provider proposes layout root types + properties, orchestrator composes `LayoutNode` with one `region` per declared slot, validates via injected `validatePageLayout` (runtime-core `ProposalValidator.validatePageLayout`), rejects unauthorized layout types and candidates exceeding `maxDepth`/`maxNodes`. | `packages/agent/src/orchestrator.ts` |
| **4c.3** `processProposal()` branches on `target.kind === "page"` to `processPageProposal()`, wiring `validatePageLayout` and passing `store` + `publicApiBase` to `dbReferenceLoader`. | `apps/api/src/processor.ts` |
| **4c.4** API route `POST /v1/projects/:p/proposals` validates `pageContract.pageKey` matches target, builds `StoredPageTarget`, inserts proposal row, enqueues job. | `apps/api/src/routes/proposals.ts` |
| **4c.5** Resolution path for `query.kind === "page"` returns `{ status: "resolved", entityId: "page:${pageKey}", entityKey: pageKey }`. | `apps/api/src/resolve.ts` |
| **4c.6** Index-worker `handleProposal()` branches on `request.target.kind === "page"`, constructs page orchestrator with `validatePageLayout`. Added `@ui-intelligence/runtime-core` dependency to `apps/api` and `apps/index-worker`. | `apps/index-worker/src/worker.ts`, `apps/api/package.json`, `apps/index-worker/package.json` |
| **4c.7** Editor Page tab calls `proposePageViaApi()` (POST page target, poll), falls back to `generator.layoutCandidatesFor()` with offline badge; `acceptLayout()` uses `candidate.readSet`. | `apps/reference-app/src/editor/Editor.tsx` |

### Regression tests

```bash
# Scoped tests (all green)
npx vitest run packages/agent/test/image-grounding.test.ts
# Result: 12 passed

npx vitest run apps/api/test/page-proposals.test.ts apps/api/test/references.test.ts
# Result: 7 passed

npx vitest run apps/reference-app/test/persistence.test.tsx
# Result: 11 passed
```

Key new tests:
- `packages/agent/test/image-grounding.test.ts` (12 green) — vision data URL, fallback to URL, text-only when undeclared, degraded notes for non-vision provider and missing content, history screenshot bytes, page-scope layout validation, allowedLayouts enforcement, closed-without-validator, maxNodes rejection.
- `apps/api/test/page-proposals.test.ts` (3 green) — real API route accepts page target, generates layout candidates, validates with `validatePageLayout`, every slot present as region; rejects rogue layout type; rejects pageKey mismatch.
- `apps/api/test/references.test.ts` (2 new green) — `dbReferenceLoader` returns `imageBytes` + `imageUrl` + `imageMediaType` for uploaded PNG; history reference returns screenshot artifact bytes/URL.

### Type-check

```bash
npx tsc -b packages/agent packages/runtime-core
npx tsc -b apps/api
npx tsc -b apps/index-worker
npx tsc -p apps/reference-app
# EXIT:0 — clean
```

---

## Audit Finding 5 — Old candidate overwrites newer preference after broadcast refresh

### Reproduction

**5a — Candidates carried no generation context:**
`LocalGenerator` produced `LocalCandidate` without a `readSet`. `Editor.generateFor()` passed `generationRevision` into the generator but the resulting candidates did not surface it. `PreferenceService.apply()` substituted `displayedRevision` (the current live-view revision) instead of the revision observed at generation time.

**5b — Acceptance ignored generation-time revision:**
When the store moved to a higher revision after generation (e.g., another tab/device applied a winner), clicking Accept sent the candidate with `previousRevision = current live revision`. The `OperationCoordinator`/`MemoryPreferenceStore` then allowed the stale candidate to overwrite the newer winner.

**5c — Batch apply had the same bug:**
`applyBatchCompact()` used `this.active.get(p.scopeKey)?.revision ?? 0` as `previousRevision`, so a batch containing one stale and one fresh candidate could overwrite a newer winner with the stale one.

### Fixes applied

| Fix | Files |
|-----|-------|
| **5a.1** `LocalCandidate` gains `readSet: TargetReadSet` field. `validatedCandidate()` builds `readSet` with the passed `preferenceRevision` and returns it on the candidate. `candidatesFor()` and `layoutCandidatesFor()` thread `preferenceRevision` into `kernel.currentReadSet()` and carry it on every result. | `apps/reference-app/src/editor/LocalGenerator.ts` |
| **5b.1** `PreferenceService.apply()` uses the caller-supplied `readSet` directly instead of substituting `displayedRevision`. | `apps/reference-app/src/app/PreferenceService.ts` |
| **5b.2** `PreferenceService.applyBatch()` uses each participant's `readSet.preferenceRevision` as `previousRevision` in `participantRecords`, instead of `this.active.get(p.scopeKey)?.revision ?? 0`. | `apps/reference-app/src/app/PreferenceService.ts` |
| **5b.3** `Editor.acceptCandidate()` passes `candidate.readSet` to `preferences.apply`; on `status === "conflict"` sets `stale = true` and shows `"Could not apply: the target changed since these alternatives were generated."` with `data-testid="stale-candidates"`. `applyBatchCompact()` captures generation revision per target and passes `candidate.readSet` to batch participants. | `apps/reference-app/src/editor/Editor.tsx` |
| **5c.1** `App.tsx` detects when it is already wrapped in a `ServicesContext.Provider` and reuses those services instead of creating a new `PreferenceService` + store. This allows tests that inject a shared `MemoryPreferenceStore` to observe the same store instance that the rendered `Editor` uses. | `apps/reference-app/src/App.tsx` |

### Regression tests

```bash
npx vitest run apps/reference-app/test/persistence.test.tsx
# Result: 11 passed (4 new: direct unit conflict, batch conflict, fresh candidate applies, editor DOM stale path)
```

Key new tests:
- `"an OLD candidate (generated at revision 0) conflicts after the target moved to revision 3; the winner stays"` — unit test using `LocalGenerator` + `PreferenceService.apply` with carried `readSet` → conflict detected, store unchanged.
- `"batch candidates carry their generation context the same way"` — batch path with stale then fresh candidate → conflict for stale, success for fresh.
- `"a fresh candidate generated after the refresh applies cleanly"` — generation at revision 3 applies with no conflict.
- `"the editor shows stale-candidates instead of applying when the target moved"` — jsdom end-to-end through rendered `Editor`: generate at revision 0, external writer moves store to revision 3, broadcast refresh, click Accept → conflict surfaced as UI message with `data-testid="stale-candidates"`.

### Type-check

```bash
npx tsc -p apps/reference-app
# EXIT:0 — clean
```

---

### Updated evidence rows

- `docs/completion-matrix.md` — Generation row updated (image bytes grounding, vision data URL, page-scope API generation); Reference-guided-page row updated (page layout validation, slot completeness, API route).

---

## Audit Finding 6 — Merged-main CI red (missing Chromium)

### Reproduction

The CI run on the PR #5 merge commit (`d002b71`, run 36101155699) failed in `apps/capture-runner/test/legacy-api.test.ts` with:

```
browserType.launch: Executable doesn't exist at .../chromium_headless_shell-1243/chrome-linux/headless_shell
```

The capture regression executes the REAL capture path and needs Playwright's Chromium, which `ci.yml` never installed. The test also silently skipped when no browser was present, so a missing browser was invisible locally.

### Fixes applied

| Fix | Files |
|-----|-------|
| **6.1** `ci.yml` gains a Playwright browser cache step (`~/.cache/ms-playwright`, keyed on `package-lock.json`) and `npx playwright install --with-deps chromium`, run after `npm ci` so the workspace-pinned Playwright version is resolved. | `.github/workflows/ci.yml` |
| **6.2** `legacy-api.test.ts` gains `browserGate()`: fail-loud by default when Chromium is missing; an explicit skip with a visible reason is allowed only under `UI_INTEL_ALLOW_NO_BROWSER=1`. No more silent skips. | `apps/capture-runner/test/legacy-api.test.ts` |
| **6.3** `capture.yml` wired for durable publication: `HISTORY_API_URL` / `HISTORY_API_TOKEN` / `HISTORY_API_PROJECT` env, health-gated service startup (step fails if api/runner-manager/reference-app do not come up), pid-file `always()` cleanup. | `.github/workflows/capture.yml` |
| **6.4** Both workflows validated with PyYAML locally. | — |

### Regression tests

```bash
npx vitest run apps/capture-runner/test/legacy-api.test.ts
# Result: 8 passed (real Chromium present locally at ~/.cache/ms-playwright/chromium-1243)

# Fail-loud verified with PLAYWRIGHT_BROWSERS_PATH pointed at an empty dir:
# the suite FAILS with the gate message instead of skipping.
```

### CI verification

Merge-commit CI run on main must be green — verified after merge (run id recorded in the PR Testing section).

---

## Closure review follow-up (2026-09-25, second commit on `vorflux/closure`)

Two review subagents (backend/capture/CI scope; generation/editor scope) plus a simplify pass reviewed the closure diff. Findings and resolutions:

| # | Severity | Finding | Fix | Regression test |
|---|----------|---------|-----|-----------------|
| R1 | Major | `executeRunScenarios` lost the `historyApiFromEnv()` fallback — pool-spawned child workers received `historyApi: undefined` and would report every scenario failed in `capture.yml` managed runs. | `api: input.historyApi ?? historyApiFromEnv()` in `apps/capture-runner/src/managed.ts`. | `managed-publication.test.ts`: "falls back to HISTORY_API_* env when no historyApi is injected" (verification GETs hit the env-derived base URL); the "never reports captured" case stubbed hermetic with `vi.stubEnv("HISTORY_API_URL", "")`. |
| R2 | Major | Sync ownership TOCTOU: the route-level owner read was outside the merge transaction — two concurrent requests could both pass, and the loser's `INSERT OR IGNORE` silently kept the winner's owner row while still writing the loser's preferences. | `mergeSyncBundle` re-reads the actual owner inside the transaction after `INSERT OR IGNORE` and throws FORBIDDEN on mismatch, rolling back the merge. | `sync-closure.test.ts`: "the in-transaction owner check rolls back a merge that lost the registration race (TOCTOU)". |
| R3 | Minor | `reconstructCommit` leaked the git worktree when `server.close()` rejected (cleanup unreachable). | Nested `try { await server.close() } finally { materialized.cleanup() }`. | Covered by existing reconstruction suites (cleanup path unchanged on success). |
| R4 | Minor | `capture.yml` coverage step used `|| true`, swallowing coverage failures. | Removed; the step now fails the workflow. | PyYAML validation of both workflows. |
| R5 | Minor | `executor.test.ts` and `history-plan-fixture.test.ts` lacked the fail-loud browser gate. | Gate helpers moved to `packages/capture/src/browser-gate.ts` (exported from `@ui-intelligence/capture`); all three capture-path suites share them. | Existing gate-logic tests in `legacy-api.test.ts` now exercise the shared module; both suites gate via `describe.skipIf` / `it.skipIf` under `UI_INTEL_ALLOW_NO_BROWSER=1` and throw at collection otherwise. |
| R6 | Medium | `imageReferenceNote()` counted only `kind === "image"` refs, but the provider's vision path also attaches `kind === "history"` refs carrying screenshots — dropped screenshots were under-counted. | Shared `referenceHasImageContent()` predicate in `packages/agent/src/provider.ts` (exactly the provider's attachment conditions); the note counts image refs plus content-bearing history refs. | `image-grounding.test.ts`: "counts image-bearing history references…" (unit) + "surfaces the history screenshot in the degraded note through the orchestrator" (2 refs → "2 image reference(s) ignored"). |
| R7 | Low | `App.tsx` boot effect depends on `cart` identity — subtle but safe; a future per-render cart would re-boot in a loop. | Stability comment added at the dependency array. | Existing `persistence.test.tsx` suite (11 tests) covers the provider-injection path. |
| R8 | Low (out of scope) | Index-worker byte grounding reads the fs layout only; S3 deployments fall back to the fetchable URL. | Surfaced as optional scope feedback (Pending); the URL fallback keeps vision grounding functional. | — |

Simplify pass (same commit): `Editor.tsx` `postProposalAndPoll` unifies entity/page API paths; `PreferenceService` dead code removed; `processor.ts`/`worker.ts` share orchestrator construction; `executeManagedRun` result mapping made explicit.

**Post-follow-up verification:** `npx vitest run` → 430 passed / 9 skipped / 0 failed; `npx tsc -b` clean.

---

# Closure-2 — remaining areas from the PR #6 closure verification (2026-09-25, branch `vorflux/closure-2`)

The PR #6 closure verification confirmed four of six closure areas and left two remaining areas with four gaps. Each gap was reproduced first, then fixed, then pinned with acceptance tests.

| Gap | Reproduction | Fix | Test command | Result |
|-----|--------------|-----|--------------|--------|
| **B1a** — S3 fallback URLs unusable by the provider | `apps/index-worker/test/grounding.test.ts` repro: artifact bytes in the real S3 driver (injected SDK transport), empty worker fs cache → `imageBytes` undefined and `imageUrl` = auth-gated `/v1/artifacts/:id/raw?projectId=...` (unauthenticated provider fetch → 401) | Storage driver moved to shared `packages/storage` (`@ui-intelligence/storage`); worker + API loaders read bytes through the configured driver (fs or s3); auth-gated URL no longer populated (field retained, documented); artifact authorization unchanged | `npx vitest run apps/api/test/proposal-s3-grounding.test.ts` | 2 passed — provider received real PNG bytes from S3; unauthorized raw read still 401 |
| **B1b** — ignored-image warnings discarded before the editor | `apps/index-worker/test/grounding.test.ts` repro: image reference + text-only provider → orchestrator produced the degraded note but the persisted proposal row had no trace of it | `proposals.degraded_json` column (graceful `ALTER TABLE` migration in API + worker; schema.sql + infra/dev/schema.sql updated); both `persistProposalOutcome` paths store it; proposal GET DTO returns `degraded`; editor renders it next to candidates (`data-testid="degraded-note"`) | `npx vitest run apps/reference-app/test/api-proposals.test.tsx` | 3 passed — note renders with candidates when present |
| **B2a** — worker ignores the plan's selected scenarios | `apps/index-worker/test/history-reconstruction.test.ts` repro: plan with `scenarioIds: ["catalog-default-desktop"]` → recording executor received all 12 scenarios | Planner validates scenarioIds (unknown → 422), defaults absent/empty to all 12, estimates from the selected set; run submission copies ids into the job payload; worker executes exactly the selected set (missing-computation, reconstruct call, completion accounting, error message) | `npx vitest run apps/index-worker/test/history-reconstruction.test.ts` + `npx vitest run apps/api/test/history-plan-fixture.test.ts` | 5 + 4 passed — one-scenario plan executes exactly one scenario; unknown ids 422 |
| **B2b** — reconstruction lacks the React/Vite build adapter | Real 3-commit React+Vite fixture (`fixtures/history/react-vite/generate.mjs`): without the adapter, reconstruction served the source tree (`/src/main.tsx` as `application/octet-stream`, app unrunnable) | `reconstructCommit` detects `ui-intel.history.json` in the worktree → constrained build adapter (`appDir`, `installCommand` default `npm ci`, `buildCommand` default `npm run build`, `outDir` default `dist`, timeout + 2 MB output cap) → serves built output; cleanup covers worktree + build output; no-manifest repos keep static serve (156-slot static corpus regression-tested); `adapterVersion` flips to `build-adapter` in the capture environment | `npx vitest run apps/api/test/history-plan-react-vite.test.ts` | 2 passed — plan → run → worker → real `npm ci` + `vite build` → published captures carry the selected commit sha and contain the per-commit built text ("Step 3 … update button label") |

**Guards:** the React/Vite E2E is gated by the shared fail-loud `browserGate` (Chromium) plus `UI_INTEL_SKIP_NETWORK_TESTS=1` for constrained environments (npm install needs the network or a warm npm cache).

**Post-closure-2 verification:** `npx vitest run` → 439 passed / 9 skipped / 0 failed; `npx tsc -b` clean. Merge-commit CI run id is recorded in the PR Testing section after merge.
