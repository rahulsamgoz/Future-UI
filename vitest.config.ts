import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/test/**/*.test.tsx", "apps/*/test/**/*.test.ts", "fixtures/**/test/**/*.test.ts"],
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
