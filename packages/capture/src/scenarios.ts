/**
 * Standard scenario recipes for the reference app (architecture section 16):
 * two routes (catalog, account) with loading/empty/error states across
 * desktop and mobile viewports.
 */
import type { ScenarioRecipe } from "./types.js";

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2 };

export function standardScenarios(): ScenarioRecipe[] {
  return [
    {
      id: "catalog-default-desktop",
      name: "Catalog default state, desktop",
      route: "/",
      role: "visitor",
      viewport: DESKTOP,
      locale: "en-US",
      timeZone: "UTC",
      colorScheme: "light",
      reducedMotion: false,
      featureFlags: {},
      fixture: "default",
      interactions: [],
      readiness: { selector: "[data-ui-entity='catalog.productChooser']", waitForFonts: true, stableFrames: 2 },
    },
    {
      id: "catalog-empty-desktop",
      name: "Catalog empty state, desktop",
      route: "/",
      role: "visitor",
      viewport: DESKTOP,
      locale: "en-US",
      timeZone: "UTC",
      colorScheme: "light",
      reducedMotion: false,
      featureFlags: {},
      fixture: "empty",
      interactions: [],
      readiness: { selector: "[data-ui-entity='catalog.productChooser']", waitForFonts: true, stableFrames: 2 },
    },
    {
      id: "catalog-loading-desktop",
      name: "Catalog loading state, desktop",
      route: "/",
      role: "visitor",
      viewport: DESKTOP,
      locale: "en-US",
      timeZone: "UTC",
      colorScheme: "light",
      reducedMotion: false,
      featureFlags: {},
      fixture: "loading",
      interactions: [{ name: "wait for loading state", kind: "waitFor", ms: 300 }],
      readiness: { selector: "[data-ui-entity='catalog.productChooser']", waitForFonts: true, stableFrames: 2 },
    },
    {
      id: "catalog-default-mobile",
      name: "Catalog default state, mobile",
      route: "/",
      role: "visitor",
      viewport: MOBILE,
      locale: "en-US",
      timeZone: "UTC",
      colorScheme: "light",
      reducedMotion: false,
      featureFlags: {},
      fixture: "default",
      interactions: [],
      readiness: { selector: "[data-ui-entity='catalog.productChooser']", waitForFonts: true, stableFrames: 2 },
    },
    {
      id: "account-default-desktop",
      name: "Account default state, desktop",
      route: "/#/account",
      role: "member",
      viewport: DESKTOP,
      locale: "en-US",
      timeZone: "UTC",
      colorScheme: "light",
      reducedMotion: false,
      featureFlags: {},
      fixture: "default",
      interactions: [],
      readiness: { selector: "[data-ui-entity='account.profileForm']", waitForFonts: true, stableFrames: 2 },
    },
    {
      id: "account-error-desktop",
      name: "Account error state, desktop",
      route: "/#/account",
      role: "member",
      viewport: DESKTOP,
      locale: "en-US",
      timeZone: "UTC",
      colorScheme: "light",
      reducedMotion: false,
      featureFlags: {},
      fixture: "error",
      interactions: [],
      readiness: { selector: "[data-ui-entity='account.profileForm']", waitForFonts: true, stableFrames: 2 },
    },
  ];
}
