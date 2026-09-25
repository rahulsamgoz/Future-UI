/**
 * Standard scenario recipes for the reference app (architecture section 16):
 * SIX named route/state scenarios (catalog default/empty/loading, account
 * default/loading/error) across BOTH viewports (desktop and mobile) — 12
 * recipes, matching the spec's "six named route/state scenarios across two
 * viewports" arithmetic (12 commits x 6 scenarios x 2 viewports = 144 planned
 * slots; this corpus has 13 commits -> 156).
 *
 * Routes are real routes: the catalog lives at "/" and the account page at
 * "/#/account" (hash route served by the same document). Readiness selectors
 * match the anchors those pages actually declare.
 */
import type { ScenarioRecipe } from "./types.js";

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2 };

type RecipeSpec = Pick<ScenarioRecipe, "id" | "name" | "route" | "fixture" | "interactions" | "readiness">;

function recipe(spec: RecipeSpec, viewport: ScenarioRecipe["viewport"]): ScenarioRecipe {
  const kind = viewport === MOBILE ? "mobile" : "desktop";
  return {
    role: "visitor",
    locale: "en-US",
    timeZone: "UTC",
    colorScheme: "light",
    reducedMotion: false,
    featureFlags: {},
    ...spec,
    id: spec.id.endsWith(`-${kind}`) ? spec.id : `${spec.id}-${kind}`,
    name: `${spec.name}, ${kind}`,
    viewport,
  };
}

const CATALOG_READINESS = {
  selector: "[data-ui-entity='catalog.productChooser']",
  waitForFonts: true,
  stableFrames: 2,
} as const;
const ACCOUNT_READINESS = {
  selector: "[data-ui-entity='account.profileForm']",
  waitForFonts: true,
  stableFrames: 2,
} as const;

const CATALOG_SCENARIOS: RecipeSpec[] = [
  {
    id: "catalog-default",
    name: "Catalog default state",
    route: "/",
    fixture: "default",
    interactions: [],
    readiness: CATALOG_READINESS,
  },
  {
    id: "catalog-empty",
    name: "Catalog empty state",
    route: "/",
    fixture: "empty",
    interactions: [],
    readiness: CATALOG_READINESS,
  },
  {
    id: "catalog-loading",
    name: "Catalog loading state",
    route: "/",
    fixture: "loading",
    interactions: [{ name: "wait for loading state", kind: "waitFor", ms: 300 }],
    readiness: CATALOG_READINESS,
  },
];

const ACCOUNT_SCENARIOS: RecipeSpec[] = [
  {
    id: "account-default",
    name: "Account default state",
    route: "/#/account",
    fixture: "default",
    interactions: [],
    readiness: ACCOUNT_READINESS,
  },
  {
    id: "account-loading",
    name: "Account loading state",
    route: "/#/account",
    fixture: "loading",
    interactions: [{ name: "wait for loading state", kind: "waitFor", ms: 300 }],
    readiness: ACCOUNT_READINESS,
  },
  {
    id: "account-error",
    name: "Account error state",
    route: "/#/account",
    fixture: "error",
    interactions: [],
    readiness: ACCOUNT_READINESS,
  },
];

/** The six named route/state scenarios, each in desktop AND mobile variants. */
export function standardScenarios(): ScenarioRecipe[] {
  return [...CATALOG_SCENARIOS, ...ACCOUNT_SCENARIOS].flatMap((spec) => [
    recipe(spec, DESKTOP),
    recipe(spec, MOBILE),
  ]);
}
