/**
 * Pure observation-building and text-redaction logic (architecture section 5).
 * Kept free of Playwright so node unit tests can exercise it directly.
 */
import type { Observation } from "@ui-intelligence/protocol";
import type { EntityEvaluation } from "./types.js";

/** Sequences that must never appear in captured visible text. */
const REDACTION_PATTERN = /(?:sk-[A-Za-z0-9]{8,}|Bearer\s+\S+|\b\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\b)/g;

export const REDACTED_PLACEHOLDER = "[REDACTED]";

/** Remove credential-like sequences from captured visible text. */
export function redactText(text: string): string {
  return text.replace(REDACTION_PATTERN, REDACTED_PLACEHOLDER);
}

/** Normalize visible text: trim and collapse whitespace runs. */
export function sanitizeVisibleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Deterministic occurrence id: explicit anchor plus the index path of
 * data-ui-entity ancestors within document order.
 */
export function buildOccurrenceId(anchor: string, path: number[]): string {
  return `occ:${anchor}#${path.join(".")}`;
}

export type ObservationBuildInput = {
  captureId: string;
  screenshotArtifactId: string;
  elements: EntityEvaluation[];
};

/**
 * Build protocol Observation[] from the raw in-page evaluation result.
 *
 * Occurrence ids are deterministic (anchor + index path), parents are linked by
 * the evaluated ancestor paths, and repeated instances of the same anchor keep
 * distinct ids through their index paths.
 */
export function buildObservationsFromEvaluation(input: ObservationBuildInput): Observation[] {
  const ordered = [...input.elements].sort((a, b) => a.path[a.path.length - 1] - b.path[b.path.length - 1]);
  const overLimit = ordered.length > 200;
  const observations: Observation[] = [];
  for (const element of ordered) {
    const occurrenceId = buildOccurrenceId(element.anchor, element.path);
    const parentOccurrenceId =
      element.parentAnchor !== undefined && element.parentPath !== undefined
        ? buildOccurrenceId(element.parentAnchor, element.parentPath)
        : undefined;
    observations.push({
      occurrenceId,
      captureId: input.captureId,
      ...(parentOccurrenceId === undefined ? {} : { parentOccurrenceId }),
      explicitAnchor: element.anchor,
      role: element.role,
      visibleText: redactText(sanitizeVisibleText(element.visibleText)),
      bounds: [element.rect],
      coordinateSpace: "document-css-pixels",
      sourceLinks: [{ definitionId: element.anchor, evidence: "registered" }],
      screenshotArtifactId: input.screenshotArtifactId,
      completeness: overLimit ? "partial" : "complete-for-scenario",
      limitations: overLimit ? ["virtualized offscreen rows not observed"] : [],
    });
  }
  return observations;
}
