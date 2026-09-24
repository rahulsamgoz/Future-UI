# R1 Performance Measurements (architecture section 15)

Measured 2026-09-24 on the dev sandbox (Linux, Node 22.21, Chromium via Playwright,
Vite 5.4.21). Scripts: `scripts/benchmark/{bundle,switch,build-overhead}.mjs` — all
reproducible; raw JSON in `docs/benchmark-{bundle,switch,build}.json`.

These are measurements on the declared environment, not product performance claims.

| Goal (section 15) | Budget | Measured | Result |
| --- | --- | --- | --- |
| Inactive core runtime bundle (runtime-core + protocol + preferences store + react adapter), gzip | < 30 KB | **17.4 KB** (72.7 KB raw) | within budget |
| p95 local representation switch (accept + undo, click-to-visible-DOM), 20 samples on the reference fixture | < 100 ms | **32.3 ms** (p50 31.3, max 32.3) | within budget |
| Manifest generation build overhead (full plugin vs virtual-module-only stub, median of 3 alternating runs after warm-up) | < 5 % | **3.71 %** (480 ms → 497 ms median) | within budget |

Notes:
- The switch measurement drives the real editor (Accept click → grid renderer
  visible; Undo click → carousel restored), not a synthetic harness.
- The build-overhead comparison isolates the plugin's work (git SHA resolution,
  source hashing, both manifests, virtual module) with `configFile: false` and a
  stub that only serves the virtual module in the without-case.
- Bundle measurement builds a minimal entry importing the runtime core,
  protocol, memory preference store, and the React adapter; editor and model
  assets are excluded per the section 15 definition of the inactive core.
