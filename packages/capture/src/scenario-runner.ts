/**
 * Scenario execution against a running app build (architecture section 5).
 * Playwright is imported lazily (inside execute) so node unit tests can import
 * this package without browsers installed.
 */
import type { Page } from "playwright";
import { PROTOCOL_VERSION, captureRequestKey, digestOf, newId } from "@ui-intelligence/protocol";
import type {
  ArtifactId,
  CaptureEnvironment,
  CaptureManifest,
  CaptureSpec,
  Observation,
} from "@ui-intelligence/protocol";
import { buildObservationsFromEvaluation } from "./observations.js";
import type { EntityEvaluation, RedactionPolicy, ScenarioRecipe } from "./types.js";

export type { RedactionPolicy, ScenarioRecipe } from "./types.js";
export { buildObservationsFromEvaluation, redactText, sanitizeVisibleText } from "./observations.js";

export type RunOptions = {
  projectId: string;
  commitSha: string;
  buildArtifactDigest: string;
  environment: CaptureEnvironment;
};

export type ExecuteResult = {
  manifest: CaptureManifest;
  screenshotBytes: Uint8Array;
};

/** SHA-256 hex digest of raw bytes. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build the immutable CaptureSpec from recipe + build + environment inputs. */
export async function buildCaptureSpec(args: {
  recipe: ScenarioRecipe;
  projectId: string;
  commitSha: string;
  buildArtifactDigest: string;
  environment: CaptureEnvironment;
  redactionPolicy: RedactionPolicy;
}): Promise<CaptureSpec> {
  const recipe = args.recipe;
  const [recipeDigest, fixtureDigest, featureFlagsDigest] = await Promise.all([
    digestOf({
      id: recipe.id,
      route: recipe.route,
      role: recipe.role,
      interactions: recipe.interactions,
      readiness: recipe.readiness,
      colorScheme: recipe.colorScheme,
      reducedMotion: recipe.reducedMotion,
      locale: recipe.locale,
      timeZone: recipe.timeZone,
      viewport: recipe.viewport,
    }),
    digestOf(recipe.fixture),
    digestOf(recipe.featureFlags),
  ]);
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: args.projectId,
    commitSha: args.commitSha,
    buildArtifactDigest: args.buildArtifactDigest,
    scenario: {
      id: recipe.id,
      recipeDigest,
      route: recipe.route,
      fixtureDigest,
      role: recipe.role,
      featureFlagsDigest,
      viewport: recipe.viewport,
      locale: recipe.locale,
      timeZone: recipe.timeZone,
      colorScheme: recipe.colorScheme,
      reducedMotion: recipe.reducedMotion,
    },
    environment: { ...args.environment, redactionPolicyDigest: await digestOf(args.redactionPolicy) },
  };
}

/** Append fixture + feature flag query params to a base URL + route. */
export function buildCaptureUrl(baseUrl: string, recipe: ScenarioRecipe): string {
  const url = new URL(recipe.route, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.searchParams.set("__fixture", recipe.fixture);
  for (const [flag, enabled] of Object.entries(recipe.featureFlags)) {
    url.searchParams.set(`__flag_${flag}`, enabled ? "true" : "false");
  }
  return url.toString();
}

/** In-page collection of registered boundary elements (runs via page.evaluate). */
function collectEntitiesInPage(maskedSelectors: string[] = []): EntityEvaluation[] {
  // Self-contained: page.evaluate serializes this function body only, so all
  // helpers must live inside it.
  // Masked elements (redaction policy) report "[REDACTED]" text so the secret
  // never enters observation text — masking pixels alone is not enough
  // (spec section 14).
  const maskedElements = new Set<Element>();
  for (const selector of maskedSelectors) {
    try {
      document.querySelectorAll(selector).forEach((el) => maskedElements.add(el));
    } catch {
      // Invalid selector for this document: skip.
    }
  }
  const isMasked = (el: Element): boolean => {
    let cursor: Element | null = el;
    while (cursor) {
      if (maskedElements.has(cursor)) return true;
      cursor = cursor.parentElement;
    }
    return false;
  };
  function implicitRole(node: HTMLElement): string | undefined {
    const tag = node.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    return undefined;
  }

  function entityChainIndices(node: Element, indexOf: Map<Element, number>): number[] {
    const chain: Element[] = [];
    let cursor: Element | null = node;
    while (cursor) {
      if (cursor.hasAttribute("data-ui-entity")) chain.push(cursor);
      cursor = cursor.parentElement;
    }
    return chain.reverse().map((el) => indexOf.get(el) ?? -1);
  }

  const nodes = Array.from(document.querySelectorAll("[data-ui-entity]")) as HTMLElement[];
  const indexOf = new Map<Element, number>();
  nodes.forEach((node, index) => indexOf.set(node, index));
  return nodes.map((node, index) => {
    const rect = node.getBoundingClientRect();
    const parent = node.parentElement?.closest("[data-ui-entity]") as HTMLElement | null;
    const role = node.getAttribute("role") ?? implicitRole(node);
    const parentPath = parent ? entityChainIndices(parent, indexOf) : undefined;
    return {
      anchor: node.dataset.uiEntity ?? "",
      ...(node.dataset.uiInstance === undefined ? {} : { instanceKey: node.dataset.uiInstance }),
      ...(role === undefined ? {} : { role }),
      visibleText: isMasked(node) ? "[REDACTED]" : (node.textContent ?? "").trim(),
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      path: entityChainIndices(node, indexOf),
      ...(parent && parentPath ? { parentAnchor: parent.dataset.uiEntity ?? "", parentPath } : {}),
    };
  });
}

export class ScenarioRunner {
  private readonly baseUrl: string;
  private readonly redactionPolicy: RedactionPolicy;

  constructor(opts: { baseUrl: string; adapterVersion: string; redactionPolicy: RedactionPolicy }) {
    this.baseUrl = opts.baseUrl;
    this.redactionPolicy = opts.redactionPolicy;
  }

  /** Specified entry point: returns the manifest only. */
  async run(recipe: ScenarioRecipe, opts: RunOptions): Promise<CaptureManifest> {
    const { manifest } = await this.execute(recipe, opts);
    return manifest;
  }

  /** Full execution: manifest plus raw screenshot bytes for upload. */
  async execute(recipe: ScenarioRecipe, opts: RunOptions): Promise<ExecuteResult> {
    const { chromium } = await import("playwright");
    const spec = await buildCaptureSpec({
      recipe,
      projectId: opts.projectId,
      commitSha: opts.commitSha,
      buildArtifactDigest: opts.buildArtifactDigest,
      environment: opts.environment,
      redactionPolicy: this.redactionPolicy,
    });
    const captureId = newId("capture");
    const screenshotArtifactId = newId("artifact");

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: recipe.viewport.width, height: recipe.viewport.height },
        deviceScaleFactor: recipe.viewport.deviceScaleFactor,
        locale: recipe.locale,
        timezoneId: recipe.timeZone,
        colorScheme: recipe.colorScheme,
        reducedMotion: recipe.reducedMotion ? "reduce" : "no-preference",
      });
      const page: Page = await context.newPage();
      await page.goto(buildCaptureUrl(this.baseUrl, recipe), { waitUntil: "load" });
      await this.performInteractions(page, recipe);
      await this.waitForReadiness(page, recipe);

      const scrollOffsets = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));

      // Redaction: record mask rects, hide masked elements, restore afterwards.
      const maskRects: Array<{ x: number; y: number; width: number; height: number }> = [];
      const restoreFns: Array<() => Promise<void>> = [];
      for (const mask of this.redactionPolicy.masks) {
        const rects = await page.$$eval(mask.selector, (els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
          })
        );
        maskRects.push(...rects);
        const previous = await page.$$eval(mask.selector, (els) =>
          els.map((el) => {
            const prior = el.style.visibility;
            el.style.visibility = "hidden";
            return prior;
          })
        );
        const selector = mask.selector;
        restoreFns.push(async () => {
          await page.$$eval(
            selector,
            (els, priors) => {
              els.forEach((el, i) => {
                el.style.visibility = priors[i] ?? "";
              });
            },
            previous
          );
        });
      }

      const screenshotBytes = new Uint8Array(await page.screenshot({ fullPage: true, type: "png" }));

      // Collect observations WHILE masks are still applied: masked elements
      // are redacted from pixels AND from observation text (spec section 14 —
      // masking pixels alone does not remove the secret from DOM text).
      const maskedSelectorList = this.redactionPolicy.masks.map((m) => m.selector);
      const evaluated = await page.evaluate(collectEntitiesInPage, maskedSelectorList);
      for (const restore of restoreFns) await restore();
      const observations: Observation[] = buildObservationsFromEvaluation({
        captureId,
        screenshotArtifactId,
        elements: evaluated,
      });

      const artifact = {
        artifactId: screenshotArtifactId as ArtifactId,
        kind: "screenshot-png" as const,
        digest: await hashBytes(screenshotBytes),
        byteSize: screenshotBytes.byteLength,
        mimeType: "image/png",
      };

      const manifest: CaptureManifest = {
        captureId,
        spec,
        capturedAt: new Date().toISOString(),
        gitParents: [],
        observations,
        artifacts: [artifact],
        buildOutcome: "succeeded",
        redactionMasks: maskRects,
        scrollOffsets,
        idempotencyKey: captureRequestKey(spec),
      };
      return { manifest, screenshotBytes };
    } finally {
      await browser.close();
    }
  }

  private async performInteractions(page: Page, recipe: ScenarioRecipe): Promise<void> {
    for (const step of recipe.interactions) {
      switch (step.kind) {
        case "click":
          if (step.selector) await page.click(step.selector);
          break;
        case "type":
          if (step.selector && step.text !== undefined) await page.fill(step.selector, step.text);
          break;
        case "waitFor":
          if (step.selector) await page.waitForSelector(step.selector, { state: "visible" });
          else await page.waitForTimeout(step.ms ?? 250);
          break;
        case "scroll":
          await page.evaluate((y) => window.scrollTo(0, y), step.ms ?? 0);
          break;
      }
    }
  }

  private async waitForReadiness(page: Page, recipe: ScenarioRecipe): Promise<void> {
    if (recipe.readiness.selector) {
      await page.waitForSelector(recipe.readiness.selector, { state: "visible" });
    }
    if (recipe.readiness.waitForFonts) {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
    }
    // Consecutive stable animation frames via double requestAnimationFrame.
    const pairs = Math.max(1, recipe.readiness.stableFrames);
    await page.evaluate(async (count) => {
      const doubleRaf = () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      for (let i = 0; i < count; i += 1) {
        await doubleRaf();
      }
    }, pairs);
  }
}
