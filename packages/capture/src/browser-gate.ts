/**
 * Browser availability gate for tests that exercise the REAL capture path
 * (audit finding 6): a missing Playwright Chromium must be LOUD, never a
 * silent skip. Shared by the capture-runner, runner-manager, and api test
 * suites so every browser-dependent suite gets the same diagnostic.
 *
 * - available → run;
 * - missing + UI_INTEL_ALLOW_NO_BROWSER=1 → skip with an explicit visible
 *   reason (constrained-environment opt-out);
 * - missing otherwise → FAIL loudly, pointing at the install step.
 */

/** Env var documented for constrained environments: explicit no-browser opt-out. */
export const ALLOW_NO_BROWSER_ENV = "UI_INTEL_ALLOW_NO_BROWSER";

/** A pluggable browser probe: resolves when a headless Chromium can launch. */
export type BrowserProbe = () => Promise<void>;

/** The real probe: launch + close through Playwright (the same code path the capture runner uses). */
export async function launchHeadlessChromium(): Promise<void> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  await browser.close();
}

export type BrowserAvailability = { available: boolean; detail: string };

/**
 * Probe browser availability by attempting a real headless launch (catches
 * e.g. a missing chromium_headless_shell even when the headed build exists).
 */
export async function probeChromium(probe: BrowserProbe = launchHeadlessChromium): Promise<BrowserAvailability> {
  try {
    await probe();
    return { available: true, detail: "headless chromium launch succeeded" };
  } catch (error) {
    return { available: false, detail: (error as Error)?.message ?? String(error) };
  }
}

export type BrowserGateDecision = { action: "run" | "skip" | "fail"; message: string };

/** Gate decision for browser-dependent tests (see file header). */
export function browserGate(availability: BrowserAvailability, env: NodeJS.ProcessEnv = process.env): BrowserGateDecision {
  if (availability.available) {
    return { action: "run", message: availability.detail };
  }
  if (env[ALLOW_NO_BROWSER_ENV] === "1") {
    return { action: "skip", message: "browser not installed (UI_INTEL_ALLOW_NO_BROWSER=1)" };
  }
  return {
    action: "fail",
    message:
      "Chromium is not installed for Playwright — a capture-path test cannot run. " +
      "Fix the environment: run `npx playwright install --with-deps chromium` (the CI workflow " +
      "does this before tests; see .github/workflows/ci.yml). This test fails loudly instead of " +
      `silently skipping. To explicitly opt out in a constrained environment set ${ALLOW_NO_BROWSER_ENV}=1. ` +
      `Probe detail: ${availability.detail}`,
  };
}
