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
| `UI_INTEL_MODEL_BASE_URL` / `UI_INTEL_MODEL_API_KEY` / `UI_INTEL_MODEL_NAME` | unset | agent provider selection: when all three are set the proposal worker uses the OpenAI-compatible provider; otherwise the deterministic provider is used |
| `VITE_API_BASE` | `http://localhost:8787` | studio |
| `VITE_API_TOKEN` | `dev-token` | studio (dev profile only — never ship a token in a client bundle) |

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
