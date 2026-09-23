/**
 * Scenario recipe and redaction types (architecture section 5).
 */

export type ScenarioInteraction = {
  name: string;
  kind: "click" | "type" | "waitFor" | "scroll";
  selector?: string;
  text?: string;
  ms?: number;
};

export type ScenarioReadiness = {
  selector?: string;
  waitForFonts: boolean;
  stableFrames: number;
};

export type ScenarioViewport = {
  width: number;
  height: number;
  deviceScaleFactor: number;
};

export type ScenarioRecipe = {
  id: string;
  name: string;
  route: string;
  role: string;
  viewport: ScenarioViewport;
  locale: string;
  timeZone: string;
  colorScheme: "light" | "dark";
  reducedMotion: boolean;
  featureFlags: Record<string, boolean>;
  /** Fixture id used to seed app state via the ?__fixture=<id> query param. */
  fixture: string;
  interactions: ScenarioInteraction[];
  readiness: ScenarioReadiness;
};

export type RedactionMask = { selector: string };

export type RedactionPolicy = {
  version: string;
  masks: RedactionMask[];
};

/** What the in-page evaluation returns for each registered boundary element. */
export type EntityEvaluation = {
  anchor: string;
  instanceKey?: string;
  role?: string;
  visibleText: string;
  rect: { x: number; y: number; width: number; height: number };
  /** Document-order indices of this element's data-ui-entity ancestors (root first) and itself. */
  path: number[];
  /** Anchor of the nearest ancestor data-ui-entity element, if any. */
  parentAnchor?: string;
  /** Path of the nearest ancestor data-ui-entity element, if any. */
  parentPath?: number[];
};
