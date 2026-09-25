# React+Vite History Fixture

A minimal real React+Vite app used for GAP B acceptance testing of the build
adapter in historical reconstruction.

## Structure

- `repo/` — a real git repository with 3 buildable commits:
  1. "initial react vite app"
  2. "add nimbus desk product"
  3. "update button label"

Each commit changes the `<App>` component header text so captures are
attributable to the commit sha.

- `generate.mjs` — regenerates the `repo/` directory from scratch.

## Build adapter convention

The fixture repo root contains `ui-intel.history.json`, which declares the build
adapter configuration for the reconstruction path:

```json
{
  "buildAdapter": {
    "appDir": ".",
    "installCommand": "npm ci",
    "buildCommand": "npm run build",
    "outDir": "dist",
    "timeoutMs": 120000
  }
}
```

When `reconstructCommit` materializes a commit from this repo, it reads the
manifest and runs the build adapter (`npm ci` → `npm run build`) before serving
the `outDir`. Repos without `ui-intel.history.json` keep the existing
static-source serving behavior.

## Network need

`npm ci` requires the npm registry (or a warm local cache). In constrained
environments, set `UI_INTEL_SKIP_NETWORK_TESTS=1` to skip the heavy E2E test.
