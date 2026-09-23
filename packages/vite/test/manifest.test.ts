import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import {
  PUBLIC_MANIFEST_FILE,
  uiIntelligencePlugin,
} from "../src/index.js";

async function makeFixtureApp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ui-intel-vite-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "index.html"),
    `<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>\n`
  );
  await writeFile(
    path.join(root, "src", "main.js"),
    `import manifest from "virtual:ui-intelligence/manifest";\n` +
      `document.title = manifest.projectKey;\n` +
      `export default manifest;\n`
  );
  await writeFile(
    path.join(root, "src", "app.js"),
    `export const markup = '<div data-ui-entity="catalog.productChooser"></div>';\n`
  );
  // A real git repo so the commit SHA is a real value we can assert against.
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "fixture@example.com"]);
  git(["config", "user.name", "Fixture"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture app"]);
  return root;
}

const pluginOptions = {
  projectKey: "test-app",
  entities: [
    { entityKey: "catalog.productChooser", pageKey: "catalog", sourceFile: "src/app.js", symbol: "App" },
  ],
};

describe("uiIntelligencePlugin", () => {
  it("emits separate public and private manifests", async () => {
    const root = await makeFixtureApp();
    try {
      await build({
        root,
        logLevel: "silent",
        build: { outDir: "dist", emptyOutDir: true },
        plugins: [uiIntelligencePlugin(pluginOptions)],
      });

      const publicRaw = await readFile(path.join(root, "dist", PUBLIC_MANIFEST_FILE), "utf8");
      const publicManifest = JSON.parse(publicRaw);
      expect(publicManifest.protocolVersion).toBe(1);
      expect(publicManifest.projectKey).toBe("test-app");
      expect(publicManifest.entities).toEqual([{ entityKey: "catalog.productChooser", pageKey: "catalog" }]);
      expect(publicManifest.buildId).toMatch(/^[0-9a-f]{12}-[0-9a-f]{16}$/);

      // Public manifest must not leak source paths, symbols, or the commit SHA.
      const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      expect(publicRaw).not.toContain(commitSha);
      expect(publicRaw).not.toContain("src/app.js");
      expect(publicRaw).not.toContain("App");
      expect(publicManifest.adapterCapabilities).toBeDefined();
      expect(publicManifest.runtimeContractRefs.length).toBeGreaterThan(0);

      // Private manifest contains everything the public one must not.
      const privateRaw = await readFile(
        path.join(root, "dist-private", "ui-intelligence", "private-manifest.json"),
        "utf8"
      );
      const privateManifest = JSON.parse(privateRaw);
      expect(privateManifest.commitSha).toBe(commitSha);
      expect(privateManifest.entities).toHaveLength(1);
      expect(privateManifest.entities[0]).toMatchObject({
        entityKey: "catalog.productChooser",
        sourceFile: "src/app.js",
        symbol: "App",
        instrumentationVersion: 1,
      });
      expect(privateManifest.entities[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves the virtual manifest module into the built output", async () => {
    const root = await makeFixtureApp();
    try {
      const result = await build({
        root,
        logLevel: "silent",
        build: { outDir: "dist", emptyOutDir: true, write: true, minify: false },
        plugins: [uiIntelligencePlugin(pluginOptions)],
      });
      const outDir = path.resolve(root, "dist");
      const files = (result as { output: Array<{ fileName: string; source?: string; code?: string }> }).output;
      // The virtual module resolved and its default export (the public manifest)
      // was inlined into the built chunk.
      const chunk = files.find(
        (f) => typeof f.code === "string" && f.code.includes("catalog.productChooser")
      );
      expect(chunk).toBeDefined();
      expect(chunk.code).toContain('"protocolVersion":1');
      expect(outDir).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
