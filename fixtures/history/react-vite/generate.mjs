/**
 * React+Vite history fixture generator (GAP B).
 *
 * Creates a disposable git repository with exactly 3 buildable commits of a
 * minimal React+Vite app. Each commit changes a visible header so captures are
 * attributable to the commit sha. The repo carries a `ui-intel.history.json`
 * manifest declaring the build adapter configuration.
 *
 * Usage: node fixtures/history/react-vite/generate.mjs [outputDir]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(scriptDir, ".generated"));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const git = (args, env = {}) =>
  execFileSync("git", args, { cwd: outDir, encoding: "utf8", env: { ...process.env, ...env } });

git(["init", "-q"]);
git(["config", "user.email", "fixture@ui-intelligence.local"]);
git(["config", "user.name", "UI Intelligence Fixture"]);

const START = Date.parse("2026-08-01T10:00:00Z");
const STEP_MS = 2.6 * 24 * 60 * 60 * 1000;

let commitIndex = 0;
function commit(message, files) {
  const date = new Date(START + commitIndex * STEP_MS).toISOString().replace("Z", " +0000");
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(outDir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(["add", "-A"]);
  git(["commit", "-q", "--allow-empty", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  commitIndex += 1;
}

const indexHtml = (stepName) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>React Vite Fixture — ${stepName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const mainTsx = (stepName, stepNumber) => `import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App stepName={${JSON.stringify(stepName)}} stepNumber={${stepNumber}} />
  </React.StrictMode>
);
`;

const appTsx = (stepName, stepNumber) => `import React from "react";

export function App({ stepName, stepNumber }: { stepName: string; stepNumber: number }) {
  return (
    <main data-ui-entity="catalog.page">
      <h1 data-ui-entity="catalog.header">Step {stepNumber}: {stepName}</h1>
      <div data-ui-entity="catalog.productChooser" role="region" aria-label="Product chooser">
        <span data-ui-entity="catalog.productCard" data-ui-instance="p1">Aurora Lamp $49</span>
        <span data-ui-entity="catalog.productCard" data-ui-instance="p2">Drift Chair $129</span>
      </div>
      <button data-ui-entity="ui.primaryButton" type="button">Add to cart</button>
    </main>
  );
}
`;

const packageJson = () => `{
  "name": "react-vite-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.3",
    "vite": "^5.4.11"
  }
}
`;

const viteConfig = () => `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
`;

const tsConfig = () => `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
`;

const gitignore = () => `node_modules\ndist\n`;

const historyManifest = () => `{
  "buildAdapter": {
    "appDir": ".",
    "installCommand": "npm ci",
    "buildCommand": "npm run build",
    "outDir": "dist",
    "timeoutMs": 120000
  }
}
`;

// Commit 1: initial React+Vite app
commit("initial react vite app", {
  ".gitignore": gitignore(),
  "index.html": indexHtml("initial react vite app"),
  "package.json": packageJson(),
  "vite.config.ts": viteConfig(),
  "tsconfig.json": tsConfig(),
  "ui-intel.history.json": historyManifest(),
  "src/main.tsx": mainTsx("initial react vite app", 1),
  "src/App.tsx": appTsx("initial react vite app", 1),
});

// Commit 2: change header text and add a product
commit("add nimbus desk product", {
  "src/main.tsx": mainTsx("add nimbus desk product", 2),
  "src/App.tsx": appTsx("add nimbus desk product", 2).replace(
    '</div>\n      <button',
    '        <span data-ui-entity="catalog.productCard" data-ui-instance="p3">Nimbus Desk $199</span>\n      </div>\n      <button'
  ),
});

// Commit 3: change header again and button text
commit("update button label", {
  "src/main.tsx": mainTsx("update button label", 3),
  "src/App.tsx": appTsx("update button label", 3).replace(
    'Add to cart',
    'Add to basket'
  ),
});

console.log(`React+Vite fixture generated in ${outDir}`);
console.log(`Commits:`);
console.log(execFileSync("git", ["-C", outDir, "log", "--oneline"], { encoding: "utf8" }).trim());
