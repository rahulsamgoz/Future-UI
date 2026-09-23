import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkgs = [
  "protocol",
  "runtime-core",
  "preferences",
  "react",
  "renderers",
  "vite",
  "capture",
  "indexing",
  "agent",
  "cli",
];
const apiApps = ["api", "index-worker", "capture-runner"];

const alias: Record<string, string> = {};
for (const p of pkgs) {
  alias[`@ui-intelligence/${p}`] = fileURLToPath(
    new URL(`./packages/${p}/src/index.ts`, import.meta.url)
  );
}
for (const a of apiApps) {
  alias[`@ui-intelligence/${a}`] = fileURLToPath(
    new URL(`./apps/${a}/src/index.ts`, import.meta.url)
  );
}

export default defineConfig({
  resolve: { alias },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.tsx",
      "apps/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.tsx",
      "fixtures/**/test/**/*.test.ts",
    ],
    environment: "node",
    environmentMatchGlobs: [
      ["packages/react/test/**", "jsdom"],
      ["packages/renderers/test/**", "jsdom"],
      ["apps/reference-app/test/**", "jsdom"],
      ["apps/studio/test/**", "jsdom"]
    ],
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
