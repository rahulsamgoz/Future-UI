#!/usr/bin/env node
/**
 * Measurement 3: manifest generation build overhead (architecture §15).
 *
 * Builds the reference app production bundle twice — WITH the full
 * ui-intelligence plugin (git SHA resolution, source hashing, both manifests,
 * virtual module) and WITHOUT it (a minimal stub that only serves the virtual
 * module so the app source compiles) — 3 measured runs each, alternating,
 * after one warm-up per path. The root vite.config.ts is NOT loaded
 * (configFile: false) so the comparison is isolated to the plugin's work.
 * Budget: plugin overhead < 5 %.
 *
 * Usage: node scripts/benchmark/build-overhead.mjs
 */
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { uiIntelligencePlugin } from "../../packages/vite/src/index.ts";
import { writeFile } from "node:fs/promises";

const root = new URL("../../apps/reference-app/", import.meta.url).pathname;

/** Serves only the virtual module so the without-plugin build compiles. */
function virtualModuleStub() {
  const virtualId = "virtual:ui-intelligence/manifest";
  return {
    name: "ui-intel-bench-stub",
    resolveId(id) {
      if (id === virtualId) return `\0${virtualId}`;
      return null;
    },
    load(id) {
      if (id === `\0${virtualId}`) return "export default { protocolVersion: 1, buildId: 'bench-stub' }";
      return null;
    },
  };
}

async function oneRun(withPlugin) {
  const t0 = performance.now();
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: withPlugin
      ? [
          react(),
          uiIntelligencePlugin({
            projectKey: "reference-app",
            entities: [
              { entityKey: "catalog.productChooser" },
              { entityKey: "catalog.sortControl" },
              { entityKey: "account.profileForm" },
            ],
          }),
        ]
      : [react(), virtualModuleStub()],
    build: { outDir: withPlugin ? "dist-bench-with" : "dist-bench-without", emptyOutDir: true },
  });
  return performance.now() - t0;
}

// Warm both paths once (JIT/esbuild caches) before measuring.
await oneRun(false);
await oneRun(true);

const without = [];
const withPlugin = [];
for (let i = 0; i < 3; i++) {
  without.push(await oneRun(false));
  withPlugin.push(await oneRun(true));
}
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const medWithout = median(without);
const medWith = median(withPlugin);
const overheadPct = ((medWith - medWithout) / medWithout) * 100;

const result = {
  measurement: "production build time with full ui-intelligence plugin vs virtual-module-only stub",
  runs: { without: without.map((m) => Math.round(m)), withPlugin: withPlugin.map((m) => Math.round(m)) },
  medianWithoutMs: Math.round(medWithout),
  medianWithMs: Math.round(medWith),
  overheadPct: Math.round(overheadPct * 100) / 100,
  budgetOverheadPct: 5,
  withinBudget: overheadPct < 5,
};
console.log(JSON.stringify(result, null, 2));
await writeFile(new URL("../../docs/benchmark-build.json", import.meta.url).pathname, JSON.stringify(result, null, 2) + "\n");
