/**
 * R1 performance measurements (architecture section 15).
 *
 * Measurement goals (not promises):
 *   1. Inactive core runtime bundle < 30 KB gzip (excluding editor/model assets)
 *   2. p95 local representation switch < 100 ms on the representative fixture
 *   3. Manifest generation build overhead < 5 % on the representative fixture
 *
 * Usage:
 *   node scripts/benchmark/bundle.mjs          # measurement 1
 *   node scripts/benchmark/switch.mjs <url>    # measurement 2 (needs app running)
 *   node scripts/benchmark/build-overhead.mjs  # measurement 3
 *   node scripts/benchmark/run-all.mjs         # all three, writes docs/benchmark-report.md
 */
