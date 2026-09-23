#!/usr/bin/env node
/**
 * History fixture generator (architecture section 16).
 *
 * Creates a disposable git repository with exactly 13 commits demonstrating
 * the identity-model cases: rename, source move, style-only refactor, global
 * token change, repeated instances, split, merge, A->B->A visual reversion,
 * and an intentionally unbuildable revision. Writes ground-truth.json with the
 * expected anchors and build outcome per commit, plus a README describing the
 * 156 planned capture slots (13 commits x 6 scenarios x 2 viewports).
 *
 * Usage: node fixtures/history/generate.mjs [outputDir]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(scriptDir, ".generated"));

// Idempotent: always start from a clean, fresh repository.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const git = (args, env = {}) =>
  execFileSync("git", args, { cwd: outDir, encoding: "utf8", env: { ...process.env, ...env } });

git(["init", "-q"]);
git(["config", "user.email", "fixture@ui-intelligence.local"]);
git(["config", "user.name", "UI Intelligence Fixture"]);

const START = Date.parse("2026-08-01T10:00:00Z");
const STEP_MS = 2.6 * 24 * 60 * 60 * 1000; // 2026-08-01 .. 2026-09-01

let commitIndex = 0;
function commit(message, files) {
  const date = new Date(START + commitIndex * STEP_MS).toISOString().replace("Z", " +0000");
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(outDir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  for (const stale of deletionsFor(commitIndex)) {
    rmSync(path.join(outDir, stale), { force: true });
  }
  git(["add", "-A"]);
  git(["commit", "-q", "--allow-empty", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  commitIndex += 1;
}

const appShell = (chooserMarkup) => `// App shell (fixture)
export function renderApp() {
  return \`
    <main data-ui-entity="catalog.page">
      <h1>Catalog</h1>
${chooserMarkup}
    </main>
  \`;
}
`;

const chooserComponent = (className, renderer, instanceKeys) => `// ProductChooser (fixture component)
// Explicit anchor: catalog.productChooser
export function ProductChooser({ products, renderer = "${renderer}" }) {
  return products.map(
    (p, i) => \`
${instanceKeys
  .map(
    (key) => `      <div class="${className}" data-ui-entity="catalog.productChooser" data-ui-instance="${key}" data-renderer="${renderer}" role="region" aria-label="Product chooser">
        <span data-ui-entity="catalog.productCard" data-ui-instance="\${p.id}-\${i}-\${key}">\${p.name} \${p.price}</span>
      </div>`
  )
  .join("\n")}
\`
  );
}
`;

const sortComponent = `// ProductSortControl (fixture component)
// Explicit anchor: catalog.sortControl
export function ProductSortControl({ sortOrder }) {
  return \`<select class="sort-control" data-ui-entity="catalog.sortControl" role="combobox" aria-label="Sort products">
    <option value="featured" \${sortOrder === "featured" ? "selected" : ""}>Featured</option>
    <option value="price" \${sortOrder === "price" ? "selected" : ""}>Price</option>
  </select>\`;
}
`;

const tokens = (spacing) => `:root {
  --spacing-unit: ${spacing}px;
  --font-stack: system-ui, sans-serif;
}
`;

const deletions = {
  1: ["src/components/ProductCarousel.tsx"],
  2: ["src/components/ProductChooser.tsx"],
  8: ["src/features/catalog/ProductSortControl.tsx"],
};

const deletionsFor = (index) => deletions[index] ?? [];

const CHOOSER_PRIMARY = 'data-ui-entity="catalog.productChooser" data-ui-instance="primary"';
const CHOOSER_RELATED = 'data-ui-entity="catalog.productChooser" data-ui-instance="related"';
const SORT_CONTROL = 'data-ui-entity="catalog.sortControl"';

// 1. initial catalog with carousel
commit("initial catalog with carousel", {
  "src/app.js": appShell(
    `      <div class="carousel" ${CHOOSER_PRIMARY} role="region">…</div>`
  ),
  "src/components/ProductCarousel.tsx": chooserComponent("carousel", "carousel@1", ["primary"]),
  "src/tokens.css": tokens(8),
});

// 2. rename ProductCarousel to ProductChooser (semantic continuity via anchor)
commit("rename ProductCarousel to ProductChooser", {
  "src/components/ProductChooser.tsx": chooserComponent("carousel", "carousel@1", ["primary"]),
  "src/app.js": appShell(
    `      <div class="carousel" ${CHOOSER_PRIMARY} role="region">…</div>`
  ),
});

// 3. move ProductChooser into features/catalog/
commit("move ProductChooser into features/catalog/", {
  "src/features/catalog/ProductChooser.tsx": chooserComponent("carousel", "carousel@1", ["primary"]),
  "src/app.js": appShell(
    `      <div class="carousel" ${CHOOSER_PRIMARY} role="region">…</div>`
  ),
});

// 4. style-only refactor of chooser (class rename, anchor unchanged)
commit("style-only refactor of chooser", {
  "src/features/catalog/ProductChooser.tsx": chooserComponent("chooser-v2", "carousel@1", ["primary"]),
  "src/app.js": appShell(
    `      <div class="chooser-v2" ${CHOOSER_PRIMARY} role="region">…</div>`
  ),
  "src/styles/chooser.css": ".chooser-v2 { display: flex; gap: var(--spacing-unit); }\n",
});

// 5. global spacing token change
commit("global spacing token change", {
  "src/tokens.css": tokens(12),
});

// 6. add grid renderer (chooser supports grid@1)
commit("add grid renderer", {
  "src/features/catalog/ProductChooser.tsx": chooserComponent("chooser-v2", "grid@1", ["primary"]),
  "src/app.js": appShell(
    `      <div class="chooser-v2" ${CHOOSER_PRIMARY} data-renderer="grid@1" role="region">…</div>`
  ),
});

// 7. repeated instances: related-products chooser (same contract, distinct instanceKey)
commit("repeated instances: add related-products chooser", {
  "src/features/catalog/ProductChooser.tsx": chooserComponent("chooser-v2", "grid@1", ["primary", "related"]),
  "src/app.js": appShell(
    `      <div class="chooser-v2" ${CHOOSER_PRIMARY} data-renderer="grid@1" role="region">…</div>\n` +
      `      <div class="chooser-v2" ${CHOOSER_RELATED} data-renderer="grid@1" role="region">…</div>`
  ),
});

// 8. split: product chooser splits into chooser + sort control (two boundaries)
commit("split: product chooser splits into chooser + sort control", {
  "src/features/catalog/ProductChooser.tsx": chooserComponent("chooser-v2", "grid@1", ["primary", "related"]),
  "src/features/catalog/ProductSortControl.tsx": sortComponent,
  "src/app.js": appShell(
    `      <div class="chooser-v2" ${CHOOSER_PRIMARY} data-renderer="grid@1" role="region">…</div>\n` +
      `      <div class="chooser-v2" ${CHOOSER_RELATED} data-renderer="grid@1" role="region">…</div>\n` +
      `      <select class="sort-control" ${SORT_CONTROL} role="combobox">…</select>`
  ),
});

// 9. merge: sort control merged back into the chooser
commit("merge: sort control merged back", {
  "src/features/catalog/ProductChooser.tsx": chooserComponent("chooser-v2", "grid@1", [
    "primary",
    "related",
  ]) + "\n// sort control merged back into the chooser boundary\n",
  "src/app.js": appShell(
    `      <div class="chooser-v2" ${CHOOSER_PRIMARY} data-renderer="grid@1" role="region">…</div>\n` +
      `      <div class="chooser-v2" ${CHOOSER_RELATED} data-renderer="grid@1" role="region">…</div>`
  ),
});

// 10. carousel -> grid default (visual A->B change)
commit("carousel → grid default", {
  "src/features/catalog/ProductChooser.tsx": chooserComponent("chooser-v2", "grid@1", [
    "primary",
    "related",
  ]),
  "src/app.js": appShell(
    `      <div class="chooser-v2" ${CHOOSER_PRIMARY} data-renderer="grid@1" role="region">…</div>\n` +
      `      <div class="chooser-v2" ${CHOOSER_RELATED} data-renderer="grid@1" role="region">…</div>`
  ),
});

// 11. revert to carousel default (A->B->A reversion)
commit("revert to carousel default", {
  "src/features/catalog/ProductChooser.tsx": chooserComponent("chooser-v2", "carousel@1", [
    "primary",
    "related",
  ]),
  "src/app.js": appShell(
    `      <div class="chooser-v2" ${CHOOSER_PRIMARY} data-renderer="carousel@1" role="region">…</div>\n` +
      `      <div class="chooser-v2" ${CHOOSER_RELATED} data-renderer="carousel@1" role="region">…</div>`
  ),
});

// 12. intentionally unbuildable revision (syntax error)
commit("intentionally unbuildable revision (INTENTIONALLY_UNBUILDABLE)", {
  "src/features/catalog/ProductChooser.tsx":
    "// INTENTIONALLY_UNBUILDABLE: missing closing brace below\n" +
    chooserComponent("chooser-v2", "carousel@1", ["primary", "related"]) +
    "\nexport function Broken() {\n",
  "src/app.js": appShell(
    `      <div class="chooser-v2" ${CHOOSER_PRIMARY} data-renderer="carousel@1" role="region">…</div>\n` +
      `      <div class="chooser-v2" ${CHOOSER_RELATED} data-renderer="carousel@1" role="region">…</div>`
  ),
});

// 13. fix build again (back to green)
commit("fix build again", {
  "src/features/catalog/ProductChooser.tsx": chooserComponent("chooser-v2", "carousel@1", [
    "primary",
    "related",
  ]),
  "src/app.js": appShell(
    `      <div class="chooser-v2" ${CHOOSER_PRIMARY} data-renderer="carousel@1" role="region">…</div>\n` +
      `      <div class="chooser-v2" ${CHOOSER_RELATED} data-renderer="carousel@1" role="region">…</div>`
  ),
});

function anchorsFor(index) {
  const anchors = ["catalog.productChooser", "catalog.page", "catalog.productCard"];
  if (index === 8) anchors.push("catalog.sortControl");
  return anchors;
}

const groundTruth = {
  corpus: {
    commits: 13,
    scenarios: 6,
    viewports: 2,
    plannedCaptureSlots: 13 * 6 * 2,
    scenarioIds: [
      "catalog-default-desktop",
      "catalog-empty-desktop",
      "catalog-loading-desktop",
      "catalog-default-mobile",
      "account-default-desktop",
      "account-error-desktop",
    ],
  },
  commits: [
    { commit: 1, message: "initial catalog with carousel", buildOutcome: "buildable", anchors: anchorsFor(1) },
    { commit: 2, message: "rename ProductCarousel to ProductChooser", buildOutcome: "buildable", anchors: anchorsFor(2), notes: "renamed definition; semantic continuity via explicit anchor" },
    { commit: 3, message: "move ProductChooser into features/catalog/", buildOutcome: "buildable", anchors: anchorsFor(3), notes: "source move; anchor unchanged" },
    { commit: 4, message: "style-only refactor of chooser", buildOutcome: "buildable", anchors: anchorsFor(4), notes: "class rename only" },
    { commit: 5, message: "global spacing token change", buildOutcome: "buildable", anchors: anchorsFor(5), notes: "tokens.css spacing 8 -> 12" },
    { commit: 6, message: "add grid renderer", buildOutcome: "buildable", anchors: anchorsFor(6), notes: "chooser now supports grid@1" },
    { commit: 7, message: "repeated instances: add related-products chooser", buildOutcome: "buildable", anchors: anchorsFor(7), notes: "same contract, distinct instanceKey" },
    { commit: 8, message: "split: product chooser splits into chooser + sort control", buildOutcome: "buildable", anchors: anchorsFor(8), notes: "two boundaries" },
    { commit: 9, message: "merge: sort control merged back", buildOutcome: "buildable", anchors: anchorsFor(9) },
    { commit: 10, message: "carousel → grid default", buildOutcome: "buildable", anchors: anchorsFor(10), notes: "visual A->B change" },
    { commit: 11, message: "revert to carousel default", buildOutcome: "buildable", anchors: anchorsFor(11), notes: "A->B->A reversion" },
    { commit: 12, message: "intentionally unbuildable revision (INTENTIONALLY_UNBUILDABLE)", buildOutcome: "unbuildable", anchors: anchorsFor(12), notes: "syntax error; expected capture failure for all 12 slots" },
    { commit: 13, message: "fix build again", buildOutcome: "buildable", anchors: anchorsFor(13) },
  ],
};

writeFileSync(path.join(outDir, "ground-truth.json"), `${JSON.stringify(groundTruth, null, 2)}\n`);
writeFileSync(path.join(outDir, ".gitignore"), "node_modules/\n");

console.log(`history fixture written to ${outDir} (13 commits)`);
