#!/usr/bin/env node
/**
 * Measurement 1: inactive core runtime bundle size (gzip).
 *
 * Builds a minimal entry that imports ONLY the runtime core (kernel, registries,
 * validator, coordinator) — no editor, no model/provider assets, no renderers'
 * preview stubs — and reports the gzipped single-file output.
 */
import { build } from "vite";
import { readFile, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dir = await mkdtemp(join(tmpdir(), "ui-intel-bench-"));
try {
  // Minimal consumer: kernel + renderer/instance registries + validator +
  // coordinator (the pieces a host app loads when the editor is closed).
  await writeFile(
    join(dir, "entry.ts"),
    `export {
      RuntimeKernel, RendererRegistry, InstanceRegistry, ProposalValidator, OperationCoordinator,
    } from "${new URL("../../packages/runtime-core/src/index.ts", import.meta.url).pathname}";
    export { UiIntelligenceError } from "${new URL("../../packages/protocol/src/index.ts", import.meta.url).pathname}";
    export { MemoryPreferenceStore } from "${new URL("../../packages/preferences/src/index.ts", import.meta.url).pathname}";
    // Tree-shake guard: reference the exports so they are retained.
    export const __retain = [RuntimeKernel, RendererRegistry, InstanceRegistry, ProposalValidator, OperationCoordinator, UiIntelligenceError, MemoryPreferenceStore];
    export { useUiRuntime, UiBoundary } from "${new URL("../../packages/react/src/index.ts", import.meta.url).pathname}";
    export { useUiRuntime as __retain2 } from "${new URL("../../packages/react/src/index.ts", import.meta.url).pathname}";
    `
  );
  await writeFile(
    join(dir, "index.html"),
    `<!doctype html><html><body><script type="module" src="/entry.ts"></script></body></html>`
  );

  const outDir = join(dir, "dist");
  await build({
    root: dir,
    logLevel: "silent",
    plugins: [
      {
        name: "alias-workspace",
        resolveId(source) {
          if (source.startsWith("@ui-intelligence/")) {
            const pkg = source.replace("@ui-intelligence/", "").split("?")[0];
            return new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url).pathname;
          }
          return null;
        },
      },
    ],
    build: { outDir, emptyOutDir: true, cssCodeSplit: false, rollupOptions: { output: { inlineDynamicImports: true } } },
  });

  // Sum every emitted JS chunk (vite puts them under assets/).
  const { readdir } = await import("node:fs/promises");
  const walk = async (d) => {
    const out = [];
    for (const f of await readdir(d, { withFileTypes: true })) {
      const full = join(d, f.name);
      if (f.isDirectory()) out.push(...(await walk(full)));
      else out.push(full);
    }
    return out;
  };
  let totalRaw = 0;
  let totalGzip = 0;
  const perFile = [];
  for (const full of await walk(outDir)) {
    if (!full.endsWith(".js")) continue;
    const bytes = await readFile(full);
    const gz = gzipSync(bytes, { level: 9 }).byteLength;
    totalRaw += bytes.byteLength;
    totalGzip += gz;
    perFile.push({ file: full.replace(outDir + "/", ""), raw: bytes.byteLength, gzip: gz });
  }
  const budget = 30 * 1024;
  const result = {
    measurement: "inactive core runtime bundle (runtime-core + protocol + preferences store + react adapter entry)",
    perFile,
    totalRaw,
    totalGzip,
    budgetGzip: budget,
    withinBudget: totalGzip <= budget,
  };
  console.log(JSON.stringify(result, null, 2));
  await writeFile(new URL("../../docs/benchmark-bundle.json", import.meta.url).pathname, JSON.stringify(result, null, 2) + "\n");
} finally {
  await rm(dir, { recursive: true, force: true });
}
