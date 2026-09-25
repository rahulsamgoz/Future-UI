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
 * Every commit is a RUNNABLE static app with no build step: `index.html` +
 * `app.js` (the catalog route) + `account.html` + `account.js` (the account
 * route, hash-routed from the host page and also served at /account) +
 * `tokens.css` / `styles.css` where the narrative adds them.
 * Serving the commit directory IS the build for this corpus (see
 * packages/capture/src/reconstruct.ts). Each page renders the committed UI
 * with real `data-ui-entity` anchors and a commit-distinct heading so captures
 * are attributable to their commit. The sort-control source exists ONLY in the
 * commit that introduces it (the split), so source-based lineage evaluation
 * sees the real split/merge narrative.
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
  // Every commit carries the account route: profileForm in all commits, the
  // admin panel from the split commit (8th) onward, and the same
  // INTENTIONALLY_UNBUILDABLE breakage as app.js so EVERY scenario of the
  // unbuildable commit fails — not only the catalog ones.
  const broken = files["app.js"].includes("INTENTIONALLY_UNBUILDABLE");
  files["account.html"] = accountHtml(message);
  files["account.js"] = accountJs({
    stepName: message,
    stepNumber: commitIndex + 1,
    withAdminPanel: commitIndex >= 7,
    broken,
  });
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

// ---------------------------------------------------------------------------
// Per-commit runnable app content
// ---------------------------------------------------------------------------

/**
 * index.html: the static host page. The heading text (step name) makes every
 * commit visually distinct so captures are attributable. The anchor-bearing
 * subtree is rendered by app.js into #app. The inline script hash-routes
 * "#/account" to account.html (preserving the __fixture query) so the account
 * scenarios capture the account page — the recipe routes are used as-is.
 */
const indexHtml = (stepName) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Catalog — ${stepName}</title>
    <link rel="stylesheet" href="tokens.css" />
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <script>
      if (location.hash.indexOf("#/account") === 0) {
        location.replace("account.html" + location.search);
      }
    </script>
    <main id="app" data-ui-entity="catalog.page"></main>
    <script src="app.js"></script>
  </body>
</html>
`;

/**
 * account.html: the account route document (also served directly at /account
 * by the reconstruct static server). account.js renders the committed account
 * UI into #app.
 */
const accountHtml = (stepName) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Account — ${stepName}</title>
    <link rel="stylesheet" href="tokens.css" />
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main id="app" data-ui-entity="account.page"></main>
    <script src="account.js"></script>
  </body>
</html>
`;

/**
 * app.js emitter. Generator strings are single-quoted so the runtime ${...}
 * template literals land verbatim in the emitted source.
 */
function appJs({ stepName, stepNumber, renderer, className, instanceKeys, withSortControl, broken }) {
  const q = JSON.stringify;
  const L = [
    `// Catalog fixture app — step ${stepNumber}: ${stepName}`,
    `// Runnable static app (no build step): served as-is, this file renders the`,
    `// committed UI into #app with real data-ui-entity anchors.`,
    `var stepName = ${q(stepName)};`,
    `var renderer = ${q(renderer)};`,
    `var className = ${q(className)};`,
    `var instanceKeys = ${q(instanceKeys)};`,
    ``,
  ];
  if (broken) {
    L.push(
      `// INTENTIONALLY_UNBUILDABLE: this revision fails during load; readiness is`,
      `// never satisfied and every scenario capture for this commit must be recorded`,
      `// as an EXPECTED failure, never a synthetic success.`,
      `throw new Error("intentionally unbuildable");`,
      ``
    );
  }
  L.push(
    `var fixture = new URLSearchParams(location.search).get("__fixture") || "default";`,
    `var products = fixture === "empty" ? [] : [`,
    `  { id: "p1", name: "Aurora Lamp", price: "$49" },`,
    `  { id: "p2", name: "Drift Chair", price: "$129" },`,
    `  { id: "p3", name: "Nimbus Desk", price: "$199" }`,
    `];`,
    ``,
    `function productCardMarkup(key) {`,
    `  return products.map(function (p, i) {`,
    `    return \``,
    `        <span data-ui-entity="catalog.productCard" data-ui-instance="\${p.id}-\${i}-\${key}">\${p.name} \${p.price}</span>`,
    `\`;`,
    `  }).join("");`,
    `}`,
    `function chooserContentMarkup(key) {`,
    `  if (products.length === 0) {`,
    `    // Empty state: the chooser boundary stays visible with a real message.`,
    `    return \``,
    `        <p class="empty-state" role="status">No products available yet</p>`,
    `\`;`,
    `  }`,
    `  return productCardMarkup(key);`,
    `}`,
    ``,
    `function chooserMarkup() {`,
    `  return instanceKeys.map(function (key) {`,
    `    return \``,
    `      <div class="\${className}" data-ui-entity="catalog.productChooser" data-ui-instance="\${key}" data-renderer="\${renderer}" role="region" aria-label="Product chooser">`,
    `\${chooserContentMarkup(key)}`,
    `      </div>`,
    `\`;`,
    `  }).join("");`,
    `}`
  );
  if (withSortControl) {
    L.push(
      ``,
      `// Split: the sort control is a separate boundary in this revision only.`,
      `function sortMarkup() {`,
      `  return \``,
      `      <select class="sort-control" data-ui-entity="catalog.sortControl" role="combobox" aria-label="Sort products">`,
      `        <option value="featured" selected>Featured</option>`,
      `        <option value="price">Price</option>`,
      `      </select>`,
      `\`;`,
      `}`
    );
  } else {
    L.push(``, `var sortMarkup = null;`);
  }
  L.push(
    ``,
    `function render() {`,
    `  document.getElementById("app").innerHTML = \``,
    `    <h1>Catalog — step ${stepNumber}: \${stepName}</h1>`,
    `\${chooserMarkup()}\${sortMarkup ? sortMarkup() : ""}`,
    `  \`;`,
    `}`,
    ``,
    `if (fixture === "loading") {`,
    `  // Defer rendering so the loading scenario observes a real pending state`,
    `  // before readiness is satisfied.`,
    `  setTimeout(render, 350);`,
    `} else {`,
    `  render();`,
    `}`,
    ``
  );
  return L.join("\n");
}

const tokensCss = (spacing) => `:root {
  --spacing-unit: ${spacing}px;
  --font-stack: system-ui, sans-serif;
}
`;

/**
 * account.js emitter: the account route with the profile form boundary in
 * EVERY commit, the admin panel boundary from the split commit onward, and
 * real loading/error fixture states (same ?__fixture mechanism as the
 * catalog). The broken commit breaks this script too, so EVERY scenario of
 * that commit fails — never only the catalog ones.
 */
function accountJs({ stepName, stepNumber, withAdminPanel, broken }) {
  const q = JSON.stringify;
  const L = [
    `// Account fixture app — step ${stepNumber}: ${stepName}`,
    `// Runnable static app (no build step): renders the committed account UI`,
    `// into #app with real data-ui-entity anchors.`,
    `var stepName = ${q(stepName)};`,
    `var stepNumber = ${q(stepNumber)};`,
    `var withAdminPanel = ${withAdminPanel ? "true" : "false"};`,
    ``,
  ];
  if (broken) {
    L.push(
      `// INTENTIONALLY_UNBUILDABLE: this revision fails during load; readiness is`,
      `// never satisfied and every scenario capture for this commit must be recorded`,
      `// as an EXPECTED failure, never a synthetic success.`,
      `throw new Error("intentionally unbuildable");`,
      ``
    );
  }
  if (withAdminPanel) {
    L.push(
      ``,
      `// Split-commit narrative: the admin panel is a separate boundary from`,
      `// this revision onward (its anchor exists in the source only here).`,
      `function adminMarkup() {`,
      `  return \``,
      `      <section class="admin-panel" data-ui-entity="account.adminPanel" role="region" aria-label="Admin panel">Admin panel: member administration</section>`,
      `\`;`,
      `}`
    );
  } else {
    L.push(``, `var adminMarkup = null;`);
  }
  L.push(
    `var fixture = new URLSearchParams(location.search).get("__fixture") || "default";`,
    ``,
    `function render() {`,
    `  document.getElementById("app").innerHTML = \``,
    `    <h1>Account — step \${stepNumber}: \${stepName}</h1>`,
    `\${fixture === "error" ? \`<div class="account-error" role="alert">Unable to load account settings</div>\` : ""}`,
    `    <form class="profile-form" data-ui-entity="account.profileForm" role="form" aria-label="Profile settings">`,
    `      <label>Name <input type="text" name="name" value="Ada Lovelace" /></label>`,
    `      <label>Email <input type="email" name="email" value="ada@example.com" /></label>`,
    `      <button type="button" data-ui-entity="ui.primaryButton">Save profile</button>`,
    `    </form>`,
    `\${adminMarkup ? adminMarkup() : ""}`,
    `  \`;`,
    `}`,
    ``,
    `if (fixture === "loading") {`,
    `  // Defer rendering so the loading scenario observes a real pending state`,
    `  // before readiness is satisfied.`,
    `  setTimeout(render, 350);`,
    `} else {`,
    `  render();`,
    `}`,
    ``
  );
  return L.join("\n");
}

const baseStyles = `.carousel { display: flex; }
`;

// ---------------------------------------------------------------------------
// The 13 commits
// ---------------------------------------------------------------------------

// 1. initial catalog with carousel
commit("initial catalog with carousel", {
  "index.html": indexHtml("initial catalog with carousel"),
  "app.js": appJs({
    stepName: "initial catalog with carousel",
    stepNumber: 1,
    renderer: "carousel@1",
    className: "carousel",
    instanceKeys: ["primary"],
    withSortControl: false,
  }),
  "tokens.css": tokensCss(8),
  "styles.css": baseStyles,
});

// 2. rename ProductCarousel to ProductChooser (semantic continuity via anchor)
commit("rename ProductCarousel to ProductChooser", {
  "index.html": indexHtml("rename ProductCarousel to ProductChooser"),
  "app.js": appJs({
    stepName: "rename ProductCarousel to ProductChooser",
    stepNumber: 2,
    renderer: "carousel@1",
    className: "carousel",
    instanceKeys: ["primary"],
    withSortControl: false,
  }),
});

// 3. move ProductChooser into features/catalog/
commit("move ProductChooser into features/catalog/", {
  "index.html": indexHtml("move ProductChooser into features/catalog/"),
  "app.js": appJs({
    stepName: "move ProductChooser into features/catalog/",
    stepNumber: 3,
    renderer: "carousel@1",
    className: "carousel",
    instanceKeys: ["primary"],
    withSortControl: false,
  }),
});

// 4. style-only refactor of chooser (class rename, anchor unchanged)
commit("style-only refactor of chooser", {
  "index.html": indexHtml("style-only refactor of chooser"),
  "app.js": appJs({
    stepName: "style-only refactor of chooser",
    stepNumber: 4,
    renderer: "carousel@1",
    className: "chooser-v2",
    instanceKeys: ["primary"],
    withSortControl: false,
  }),
  "styles.css": baseStyles + ".chooser-v2 { display: flex; gap: var(--spacing-unit); }\n",
});

// 5. global spacing token change
commit("global spacing token change", {
  "index.html": indexHtml("global spacing token change"),
  "app.js": appJs({
    stepName: "global spacing token change",
    stepNumber: 5,
    renderer: "carousel@1",
    className: "chooser-v2",
    instanceKeys: ["primary"],
    withSortControl: false,
  }),
  "tokens.css": tokensCss(12),
});

// 6. add grid renderer (chooser supports grid@1)
commit("add grid renderer", {
  "index.html": indexHtml("add grid renderer"),
  "app.js": appJs({
    stepName: "add grid renderer",
    stepNumber: 6,
    renderer: "grid@1",
    className: "chooser-v2",
    instanceKeys: ["primary"],
    withSortControl: false,
  }),
});

// 7. repeated instances: related-products chooser (same contract, distinct instanceKey)
commit("repeated instances: add related-products chooser", {
  "index.html": indexHtml("repeated instances: add related-products chooser"),
  "app.js": appJs({
    stepName: "repeated instances: add related-products chooser",
    stepNumber: 7,
    renderer: "grid@1",
    className: "chooser-v2",
    instanceKeys: ["primary", "related"],
    withSortControl: false,
  }),
});

// 8. split: product chooser splits into chooser + sort control (two boundaries)
commit("split: product chooser splits into chooser + sort control", {
  "index.html": indexHtml("split: product chooser splits into chooser + sort control"),
  "app.js": appJs({
    stepName: "split: product chooser splits into chooser + sort control",
    stepNumber: 8,
    renderer: "grid@1",
    className: "chooser-v2",
    instanceKeys: ["primary", "related"],
    withSortControl: true,
  }),
});

// 9. merge: sort control merged back into the chooser
commit("merge: sort control merged back", {
  "index.html": indexHtml("merge: sort control merged back"),
  "app.js": appJs({
    stepName: "merge: sort control merged back",
    stepNumber: 9,
    renderer: "grid@1",
    className: "chooser-v2",
    instanceKeys: ["primary", "related"],
    withSortControl: false,
  }),
});

// 10. carousel -> grid default (visual A->B change)
commit("carousel → grid default", {
  "index.html": indexHtml("carousel → grid default"),
  "app.js": appJs({
    stepName: "carousel → grid default",
    stepNumber: 10,
    renderer: "grid@1",
    className: "chooser-v2",
    instanceKeys: ["primary", "related"],
    withSortControl: false,
  }),
});

// 11. revert to carousel default (A->B->A reversion)
commit("revert to carousel default", {
  "index.html": indexHtml("revert to carousel default"),
  "app.js": appJs({
    stepName: "revert to carousel default",
    stepNumber: 11,
    renderer: "carousel@1",
    className: "chooser-v2",
    instanceKeys: ["primary", "related"],
    withSortControl: false,
  }),
});

// 12. intentionally unbuildable revision (app.js throws during load)
commit("intentionally unbuildable revision (INTENTIONALLY_UNBUILDABLE)", {
  "index.html": indexHtml("intentionally unbuildable revision"),
  "app.js": appJs({
    stepName: "intentionally unbuildable revision",
    stepNumber: 12,
    renderer: "carousel@1",
    className: "chooser-v2",
    instanceKeys: ["primary", "related"],
    withSortControl: false,
    broken: true,
  }),
});

// 13. fix build again (back to green)
commit("fix build again", {
  "index.html": indexHtml("fix build again"),
  "app.js": appJs({
    stepName: "fix build again",
    stepNumber: 13,
    renderer: "carousel@1",
    className: "chooser-v2",
    instanceKeys: ["primary", "related"],
    withSortControl: false,
  }),
});

function anchorsFor(index) {
  const anchors = [
    "catalog.page",
    "catalog.productChooser",
    "catalog.productCard",
    "account.page",
    "account.profileForm",
  ];
  if (index === 8) anchors.push("catalog.sortControl");
  if (index >= 8) anchors.push("account.adminPanel");
  return anchors;
}

const SCENARIO_IDS = [
  "catalog-default-desktop",
  "catalog-default-mobile",
  "catalog-empty-desktop",
  "catalog-empty-mobile",
  "catalog-loading-desktop",
  "catalog-loading-mobile",
  "account-default-desktop",
  "account-default-mobile",
  "account-loading-desktop",
  "account-loading-mobile",
  "account-error-desktop",
  "account-error-mobile",
];

const groundTruth = {
  corpus: {
    commits: 13,
    scenarios: 12,
    viewports: 2,
    plannedCaptureSlots: 13 * 12,
    runnable: true,
    entry: ["index.html", "app.js", "account.html", "account.js"],
    note:
      "every buildable commit is a runnable static app (no build step); serving the commit tree IS the build; " +
      "six named route/state scenarios x 2 viewports = 12 recipes per commit",
    scenarioIds: SCENARIO_IDS,
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
    { commit: 12, message: "intentionally unbuildable revision (INTENTIONALLY_UNBUILDABLE)", buildOutcome: "unbuildable", anchors: anchorsFor(12), notes: "app.js throws during load; expected capture failure for all 12 slots" },
    { commit: 13, message: "fix build again", buildOutcome: "buildable", anchors: anchorsFor(13) },
  ],
};

writeFileSync(path.join(outDir, "ground-truth.json"), `${JSON.stringify(groundTruth, null, 2)}\n`);
writeFileSync(path.join(outDir, ".gitignore"), "node_modules/\n");

console.log(`history fixture written to ${outDir} (13 commits, runnable static app per commit)`);
