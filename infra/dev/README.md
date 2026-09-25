# UI Intelligence — dev infrastructure

Local development profile for the UI Intelligence R1 backend: SQLite metadata
store, local filesystem object store, API service, index worker, capture
runner, and Studio console.

## Environment variables

| Variable | Default | Used by |
| --- | --- | --- |
| `UI_INTEL_DB` | `./data/ui-intelligence.sqlite` | api, index-worker (SQLite file; parent dirs are created) |
| `UI_INTEL_TOKEN` | `dev-token` | api (bearer token for every `/v1` request) |
| `UI_INTEL_STORE` | `./data/artifacts` | api (filesystem object store root) |
| `UI_INTEL_SCHEMA` | `infra/dev/schema.sql` in the repo | index-worker (schema bootstrap) |
| `PORT` | `8787` | api |
| `UI_INTEL_MODEL_BASE_URL` / `UI_INTEL_MODEL_API_KEY` / `UI_INTEL_MODEL_NAME` | unset | agent provider selection: when all three are set the proposal worker uses the OpenAI-compatible provider; otherwise the deterministic provider is used. Easiest setup: put them in `infra/dev/model.env` (gitignored) — `start-all.sh` sources it automatically. Any OpenAI-compatible endpoint works (OpenCode Zen with a funded key, OpenRouter, OpenAI, a local vLLM/Ollama, ...). Note: Zen's `-free` models are restricted to the official OpenCode client **except `space-bunny-free`**, which is served without client restrictions (zero-retention by design) and works directly through this API with `UI_INTEL_MODEL_API_KEY=public`. |
| `VITE_API_BASE` | `http://localhost:8787` | studio |
| `VITE_API_TOKEN` | `dev-token` | studio (dev profile only — never ship a token in a client bundle) |
| `UI_INTEL_STORAGE_DRIVER` | `fs` | api, index-worker (R2 stream G): object storage driver selection — `fs` (digest-sharded local filesystem, unchanged R1 layout) or `s3`. |
| `UI_INTEL_S3_BUCKET` | unset | api (R2 stream G): S3 bucket for the `s3` driver. When `UI_INTEL_STORAGE_DRIVER=s3` but the bucket is unset, startup logs a line and falls back to the `fs` driver. AWS credentials come from the standard AWS SDK chain (`AWS_ACCESS_KEY_ID` etc.). Optional `UI_INTEL_S3_PREFIX` sets a key prefix. Note: the dev-profile S3 driver serves sync `get`/`exists` from a write-through cache of objects written by the current process; the fs driver is the complete reference implementation. |
| `GC_RETENTION_DAYS` | unset | api + index-worker (R2 stream G): retention window for reference-aware GC. Set on the api to make it the default for `POST /v1/projects/:p/gc` when the body omits `retentionDays`; set on the index-worker to enable the scheduled daily GC pass (guarded by the `gc_runs` table). Unset on the worker disables scheduled GC entirely. |

## Device preference sync (R2 stream B)

`POST /v1/profiles/:profileId/sync` is the server side of device preference
synchronization (architecture section 9). The API holds no device preference
state otherwise; synced records live in the `synced_preferences` table,
namespaced by the opaque `profileId` and the project derived from the body's
`projectId` (id or name accepted). All authenticated principals may sync in
the dev profile — the profile id is never an authorization input. The `$API`
and `$AUTH` variables are defined in the journey walkthrough below.

```bash
curl -s -H "$AUTH" -H "$CT" -d '{
  "projectId": "proj_reference_app",
  "deviceLabel": "laptop",
  "pushedAt": "2026-03-01T00:00:00.000Z",
  "preferences": [
    {"key": {"profileId": "profile_1", "projectId": "proj_reference_app",
             "scope": "entity", "scopeKey": "catalog.productChooser"},
     "activeSpecificationDigest": "<sha256-of-spec>", "revision": 2,
     "contractVersion": 1, "updatedAt": "2026-03-01T00:00:00.000Z"}
  ],
  "specifications": [
    {"digest": "<sha256-of-spec>", "proposal": {"representation": "grid@1",
     "properties": {"columns": 2}}, "requiredRendererVersions": {"grid@1": 1},
     "createdAt": "2026-03-01T00:00:00.000Z"}
  ]
}' $API/profiles/profile_1/sync
```

The response is the merge result `{accepted, serverWins, retainedAsDraft,
authoritative}`. Merge rules: highest revision per key wins; equal revision
with an equal digest is a no-op; equal revision with a DIFFERENT digest keeps
the server record and reports the key in `serverWins`/`retainedAsDraft` so
the pushing device retains its local specification as a draft (never a
silent overwrite). The client-side `SyncManager` (packages/preferences)
drives this endpoint: it drains the local outbox, pushes the exported
bundle, applies the authoritative bundle, and offers `startAutoSync(ms)`.

## Retention and GC (R2 stream G)

`POST /v1/projects/:p/gc` (body `{retentionDays?, dryRun?, force?}`) runs
reference-aware garbage collection: artifacts whose last referencing
capture/proposal is older than the retention window are deleted (row +
object bytes), as are unreferenced artifacts older than the window.
Artifacts referenced within the window — and everything referenced by the
current (latest) build's captures — are always kept. A safety guard aborts
the run when deletion would remove more than 50% of the project's artifacts
unless `force: true`. Every run is recorded in the `gc_runs` table. The
index-worker reuses the same rules for a scheduled daily pass when
`GC_RETENTION_DAYS` is set (fs driver only; with `UI_INTEL_STORAGE_DRIVER=s3`
the scheduled pass logs and skips).

## Database

`schema.sql` is the full SQLite schema. The API applies it on startup and
seeds the `reference-app` project (entity keys `catalog.productChooser`,
`catalog.sortControl`, `account.profileForm`, runtime manifest with renderer
property schemas, six declared scenarios). The index-worker applies the same
file when it starts. The dev tenant is fixed to `local`.

## Processes

```bash
# build everything first
npx tsc -b apps/api apps/index-worker apps/capture-runner apps/studio

# 1. API service (http://localhost:8787)
UI_INTEL_DB=./data/ui-intelligence.sqlite UI_INTEL_STORE=./data/artifacts \
  node apps/api/dist/server.js

# 2. Index worker (polls the same SQLite db, 2s interval)
UI_INTEL_DB=./data/ui-intelligence.sqlite node apps/index-worker/dist/main.js

# 3. Capture runner (executes repository builds + scenario captures)
node apps/capture-runner/dist/main.js --help

# 4. Studio (http://localhost:5173)
npm run dev -w @ui-intelligence/studio

# 5. Reference app (http://localhost:5174)
npm run dev:reference-app
```

Or start API + worker together with logs:

```bash
./infra/dev/start-all.sh          # logs in infra/dev/logs/
```

## R1 journey walkthrough

All `/v1` requests need `-H "Authorization: Bearer dev-token"`.

```bash
API=http://localhost:8787/v1
AUTH='Authorization: Bearer dev-token'
CT='content-type: application/json'

# 0. Confirm the seeded project and runtime manifest
curl -s -H "$AUTH" $API/projects
curl -s -H "$AUTH" $API/projects/proj_reference_app/runtime-manifest

# 1. Register commits (what the CLI's `history plan`/sync does)
curl -s -H "$AUTH" -H "$CT" -d '{"commits":[{"sha":"abc123","committedAt":"2026-01-10T10:00:00.000Z","parents":[]}]}' \
  $API/projects/proj_reference_app/commits:sync

# 2. Plan a historical scan
curl -s -H "$AUTH" -H "$CT" -d '{
  "input": {"repository":"https://github.com/example/reference-app","branches":["main"],
            "windowStart":"2026-01-01T00:00:00.000Z","windowEnd":"2026-02-01T00:00:00.000Z",
            "scenarioIds":["catalog-desktop-signed-in","account-desktop-signed-in"],
            "maxBuilds":12,"renderBudgetMs":600000,"timezone":"UTC"}}' \
  $API/projects/proj_reference_app/history-plans

# 3. Run the plan (202 + jobId); the worker marks the plan completed and
#    enqueues index_capture jobs for captured commits
curl -s -H "$AUTH" -H "$CT" -d '' \
  $API/projects/proj_reference_app/history-plans/<planId>/runs

# 4. Upload a screenshot artifact, then ingest a capture manifest referencing it
curl -s -H "$AUTH" -H "$CT" -d '{"mediaType":"image/png","byteSize":<n>,"digest":"<sha256>"}' \
  $API/projects/proj_reference_app/artifact-uploads
curl -s -X PUT -H 'content-type: application/octet-stream' --data-binary @shot.png \
  $API/artifacts/<slotId>
curl -s -H "$AUTH" -H "$CT" -H 'idempotency-key: cap-001' -d @manifest.json \
  $API/projects/proj_reference_app/captures

# 5. Resolve targets and browse history
curl -s -H "$AUTH" -H "$CT" -d '{"target":{"kind":"text","text":"product chooser"}}' \
  $API/projects/proj_reference_app/resolve
curl -s -H "$AUTH" \
  "$API/projects/proj_reference_app/entities/catalog.productChooser/history?limit=20"

# 6. Generate, inspect, accept, export a proposal
curl -s -H "$AUTH" -H "$CT" -d '{
  "request": {"requestId":"r1","operation":"propose_change",
              "target":{"kind":"selection","entityId":"ent_catalog_product_chooser","runtimeInstanceId":"rt1"},
              "references":[],"instruction":"make it a compact grid",
              "appBuildId":"build_dev","requestedCandidateCount":4}}' \
  $API/projects/proj_reference_app/proposals
curl -s -H "$AUTH" $API/projects/proj_reference_app/proposals/<proposalId>
curl -s -H "$AUTH" -H "$CT" -d '{"candidateId":"<candidateId>"}' \
  $API/projects/proj_reference_app/proposals/<proposalId>/accept
curl -s -H "$AUTH" -X POST $API/projects/proj_reference_app/proposals/<proposalId>/export
```

The Studio console (http://localhost:5173) covers the same flow visually:
overview with scan/job progress, the history console with evidence chips and
side-by-side screenshot compare, and the proposals inspector with validation
reports and digests.

## Notes and boundaries

- SQLite is the dev metadata store; production uses PostgreSQL per spec
  section 12. The jobs table implements the same lease semantics (claim →
  lease token + 30s expiry → heartbeat → terminal complete; at-least-once).
- The object store is the local filesystem keyed by content digest.
- Screenshot grounding in `/resolve` is intentionally unsupported in the dev
  profile and answers `no_match` with that reason (spec section 13).
- Accepting a proposal records the choice only; nothing executes business
  actions (spec section 8 step 6).

## Runner manager (R2 stream D)

`apps/runner-manager` schedules historical capture runs and leases them to a
pool of capture-runner workers (architecture sections 10-11). It has its own
SQLite store (`RUNNER_DB`, default `./data/runner.sqlite`) and bearer token
(`RUNNER_TOKEN`, default `dev-token`); it never touches the API database.

```bash
# 1. Manager (http://localhost:8900, health: /health)
npx tsc -b apps/runner-manager && RUNNER_DB=./data/runner.sqlite node apps/runner-manager/dist/server.js

# 2. Workers: capture-runner processes pointed at the manager (RUNNER_MANAGER_URL
#    switches the worker off the capture-API protocol). APP_URL is the app under
#    capture; playwright + chromium must be available locally.
npx tsc -b apps/capture-runner
RUNNER_MANAGER_URL=http://localhost:8900 RUNNER_TOKEN=dev-token APP_URL=http://localhost:5173 \
  node apps/capture-runner/dist/main.js
# Workers register, claim queued runs, heartbeat every 10s, and complete with
# per-scenario results; dead workers' runs are re-queued after the lease/silence
# expires. Optionally spawn a pool from the manager itself: RUNNER_POOL_COUNT=2.

# 3. Submit + poll a run from the CLI
node packages/cli/dist/cli.js history submit \
  --repo https://github.com/rahulsamgoz/Future-UI \
  --commit <sha> \
  --scenarios catalog-default-desktop,catalog-empty-desktop \
  --manager http://localhost:8900
```

Manager endpoints (all `/v1` need `Authorization: Bearer $RUNNER_TOKEN`;
`/health` is open): `POST /v1/runs` (202, `{projectId, repoUrl, commitSha,
scenarios}`), `GET /v1/runs/:id` (status + per-scenario results with capture
ids), `POST /v1/workers/register`, `POST /v1/workers/:id/heartbeat` (also
extends the lease of the worker's active run), `POST /v1/workers/:id/claim`
(leases the next queued run; one run per worker at a time), and
`POST /v1/runs/:id/complete` (idempotent, lease-checked; bounded retries).

Environment variables: `RUNNER_DB` (default `./data/runner.sqlite`),
`RUNNER_TOKEN` (default `dev-token`), `PORT` (default `8900`),
`RUNNER_POOL_COUNT` (optional embedded pool of capture-runner children),
`APP_URL` (app under capture for pool-spawned children), and on the worker
side `RUNNER_MANAGER_URL` / `APP_URL` / `RUNNER_TOKEN`.
