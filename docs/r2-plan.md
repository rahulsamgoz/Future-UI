# R2 Plan — Expansion and Production Hardening

Follows docs/architecture.md section 19 "Subsequent expansion" and the open implementation
choices. R1 (complete, merged) is the foundation; R2 does not displace it.

## Scope

### A. Framework expansion — Next.js as the second web framework (spec §19: "Test a second web framework against the protocol before freezing a stable cross-framework version")
- New `apps/next-demo`: a minimal Next.js (App Router) app with 2 registered boundaries
  (product chooser + button) using the SAME protocol contracts, runtime-core, react adapter,
  and renderers as the Vite reference app — proving the protocol is framework-neutral.
- Capture works against it unchanged (ScenarioRunner is server-agnostic).
- Verified: build + run + capture + editor journey smoke.

### B. Device synchronization (extension of §9)
- Server: `POST /v1/profiles/:id/sync` — upload bundle (device revisions), merge by
  highest revision per key, return the merged authoritative bundle. Namespaced by profile.
- Client: `SyncManager` (packages/preferences) — drains the sync outbox, pushes local
  revisions, pulls merged state, applies to the local store; manual trigger + interval.
  Conflict policy: highest revision wins; equal-revision-different-digest = keep server,
  retain local as draft (no silent overwrite).
- Verified: two devices (two stores) converge through the API; conflict case tested.

### C. Persistent semantic rules (extension of §8)
- Rule schema (protocol): conditions (route, viewport class, entityKey) → action
  (representation + properties), versioned, validated against the same contracts.
- Storage: rules records in the preference store (per profile), exportable.
- Evaluation: `RuleEngine` (packages/runtime-core) resolves the active representation
  BEFORE preference lookup: explicit preference > matching rule > contract default.
  Rules are hints, not overrides of explicit user choices.
- Editor: "Rules" tab — create/list/delete rules from validated dropdowns.
- Verified: rule creates compact buttons on mobile viewport; explicit preference wins over rule; unit + browser test.

### D. Managed historical runners (extension of §10/§11)
- `apps/runner-manager`: a small service exposing `POST /v1/runs` (schedule capture set:
  repo URL, commit range, scenarios) → creates jobs; manages a pool of capture-runner
  processes (bounded concurrency), retries, heartbeats. Docker-executable worker.
- CLI: `history submit` against the manager.
- Verified: end-to-end with the reference app + fixture commits; pool of 2 runners;
  retry on a failing job.

### E. Developer handoff → PR automation (extension of §16 handoff row)
- CLI `handoff`: takes an accepted proposal (from the API), writes it into the app-owned
  configuration file (`ui-intelligence.preferences.json` read at app boot as DEFAULT
  preferences), creates a branch, commits, opens a PR via the GitHub API.
- The app boots defaults from that file when no local preference exists (org-level
  defaults per spec §9 precedence: app defaults < org < personal).
- Verified: creates a real branch + PR on this repo; app picks up the default.

### F. Per-user auth adapter (production hardening)
- Users + API keys (hashed) + project memberships with roles (owner/member/viewer).
- Auth interface stays a single seam (`verifyPrincipal`); dev-token remains a valid
  principal for local dev. Role enforcement: viewers read-only; members create captures/
  proposals; owners manage projects/keys.
- Verified: API tests per role; cross-user denial.

### G. Remote object storage interface (production hardening)
- `StorageDriver` interface (get/put/delete/exists) with two drivers: `fs` (default,
  current behavior) and `s3` (AWS SDK v3, env-configured; no live credentials in dev —
  contract-tested with an in-process fake, live check gated on credentials).
- Retention + reference-aware GC: `gc` job deletes artifacts not referenced by any
  capture/proposal within the retention window; derived previews/embeddings share fate
  with originals. Manual + scheduled trigger; dry-run mode.
- Verified: GC unit + integration tests (referenced artifacts survive, orphans deleted).

### H. Cloud deployment artifacts
- Dockerfiles for api / index-worker / runner-manager / studio / reference-app;
  docker-compose for the full stack; healthchecks.
- GitHub Actions workflow: CI (typecheck + tests) and a capture job template (PR-triggered
  capture against a preview deployment).
- Verified: `docker compose build` succeeds locally; CI workflow file validated.

## Non-goals (still post-R2)
- Native adapters (iOS/Android) — require view/state mapping definitions first (spec §19).
- General source rewriting beyond the declarative config handoff.

## Verification bar
Same as R1: every row in the R2 matrix (docs/r2-matrix.md) closes only with execution
evidence. Full suite stays green. All journeys re-run at the end.

## Sequence
1. Plan (this doc) — no approval pause per user instruction.
2. Parallel: A (next-demo), B+G (sync/storage/GC), C (rules), D+H (runner pool/docker/CI), E (handoff PR), F (auth).
3. Integration verification round + matrix + report.
