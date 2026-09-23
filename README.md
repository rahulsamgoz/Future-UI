# Future-UI — UI Intelligence R1

An integrated first release (R1) of the UI Intelligence system: an application
runtime that lets a user point to an interface, inspect alternatives, and apply
a personal presentation while the application continues to supply its current
data and behavior.

The central engineering contract:

> A presentation may change only within the data, actions, state, and
> constraints that the current application exposes for that scope.

## Monorepo layout

| Path | Responsibility |
| --- | --- |
| `packages/protocol` | Versioned schemas, identifiers, errors, adapter declarations, module ports |
| `packages/runtime-core` | Target registry, scope planner, proposal validation, operation coordination |
| `packages/preferences` | IndexedDB transactions, revisions, recovery, export/import |
| `packages/react` | Semantic boundaries, instance registry, selection, state transfer |
| `packages/renderers` | Approved presentations, page layouts, schema definitions, preview stubs |
| `packages/vite` | Build identity and separate public/private manifests |
| `packages/capture` | Scenario execution, redaction, artifacts, evidence manifests |
| `packages/indexing` | Comparison, lineage candidates, retrieval indexes |
| `packages/agent` | Grounded proposals, provider interface, budgets, validation orchestration |
| `packages/cli` | Initialization, scan planning, execution, capture, export |
| `apps/api` | Project API service (authorization, captures, retrieval, proposals, jobs) |
| `apps/index-worker` | Leased indexing/retrieval jobs |
| `apps/capture-runner` | Disposable build/scenario execution entrypoint |
| `apps/studio` | Project onboarding, history console, developer inspection |
| `apps/reference-app` | Multi-route React + Vite integration and end-user editor |
| `fixtures/history` | Reproducible Git history, scenario recipes, ground-truth matches |
| `infra/dev` | Database schema, object-store adapter configuration, process startup |

## Quick start

```bash
npm install
npm run build       # typecheck + emit all packages
npm test            # vitest across all workspaces

# Reference app (catalog + account routes with the end-user editor)
npm run dev:reference-app

# API service + worker (SQLite dev profile)
npm run dev:api
node apps/index-worker/dist/worker.js

# Studio (history console)
npm run dev:studio

# CLI
node packages/cli/dist/cli.js init
node packages/cli/dist/cli.js history plan --window 6mo
node packages/cli/dist/cli.js history run
node packages/cli/dist/cli.js capture
```

## Architecture summary

- **Identity model**: `UiEntity` (durable semantic identity), `UiEntityVersion`
  (representation at a build), `UiOccurrence` (one capture observation),
  `RuntimeInstance` (one mounted occurrence), `SourceDefinition`,
  `Capability`, `Artifact`.
- **Capture** is defined by both build and scenario; every observation carries
  an evidence label (`captured_at_build`, `reconstructed_from_commit`,
  `replayed_artifact`, `source_only`, `unavailable`).
- **Proposals** are executable presentation specifications validated against
  registered contracts — no arbitrary code, handlers, URLs, or credentials.
- **Preferences** live on device (IndexedDB), with revision-based conflict
  handling, interrupted-commit recovery, batch atomic activation, and
  export/import. Applying a cached compatible variant needs no network.
- **Backend**: modular API + leased durable jobs (at-least-once, idempotent
  publication), artifact storage with digest verification, and authorization
  derived from the authenticated principal.

See `docs/architecture.md` (source design document) for the full contract.
