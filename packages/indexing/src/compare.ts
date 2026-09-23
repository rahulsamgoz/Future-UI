/**
 * Capture comparison (spec section 13: comparison, lineage candidates,
 * retrieval indexes). Pure functions over observations — no database access.
 */
import type { Observation } from "@ui-intelligence/protocol";

export type CaptureChangeKind = "added" | "removed" | "text_changed" | "bounds_changed";

export type CaptureChange = {
  anchorA?: string;
  anchorB?: string;
  kind: CaptureChangeKind;
};

export type CaptureComparison = {
  changed: boolean;
  changes: CaptureChange[];
};

/** Bounds differences above this many pixels (on any edge) count as changed. */
export const BOUNDS_TOLERANCE_PX = 2;

/**
 * Matching key: the explicit anchor when present, otherwise the observation's
 * path index within its capture (structural fallback for unanchored nodes).
 */
function matchKey(obs: Observation, index: number): string {
  return obs.explicitAnchor ?? `#path:${index}`;
}

function boundsChanged(a: Observation, b: Observation): boolean {
  // Compare the primary bounds rect of each observation.
  const ra = a.bounds[0];
  const rb = b.bounds[0];
  if (!ra || !rb) return true;
  return (
    Math.abs(ra.x - rb.x) > BOUNDS_TOLERANCE_PX ||
    Math.abs(ra.y - rb.y) > BOUNDS_TOLERANCE_PX ||
    Math.abs(ra.width - rb.width) > BOUNDS_TOLERANCE_PX ||
    Math.abs(ra.height - rb.height) > BOUNDS_TOLERANCE_PX
  );
}

/**
 * Compare two captures' observations. Matching is by explicitAnchor plus path
 * index (for observations without an explicit anchor). Reports additions,
 * removals, and text/bounds changes for matched pairs.
 */
export function compareCaptures(a: Observation[], b: Observation[]): CaptureComparison {
  const changes: CaptureChange[] = [];

  const aByKey = new Map<string, { obs: Observation; index: number }>();
  a.forEach((obs, index) => aByKey.set(matchKey(obs, index), { obs, index }));
  const bByKey = new Map<string, { obs: Observation; index: number }>();
  b.forEach((obs, index) => bByKey.set(matchKey(obs, index), { obs, index }));

  for (const [key, entryA] of aByKey) {
    const entryB = bByKey.get(key);
    if (!entryB) {
      changes.push({ anchorA: entryA.obs.explicitAnchor, kind: "removed" });
      continue;
    }
    const textA = entryA.obs.visibleText ?? "";
    const textB = entryB.obs.visibleText ?? "";
    if (textA !== textB) {
      changes.push({
        anchorA: entryA.obs.explicitAnchor,
        anchorB: entryB.obs.explicitAnchor,
        kind: "text_changed",
      });
    }
    if (boundsChanged(entryA.obs, entryB.obs)) {
      changes.push({
        anchorA: entryA.obs.explicitAnchor,
        anchorB: entryB.obs.explicitAnchor,
        kind: "bounds_changed",
      });
    }
  }

  for (const [key, entryB] of bByKey) {
    if (!aByKey.has(key)) {
      changes.push({ anchorB: entryB.obs.explicitAnchor, kind: "added" });
    }
  }

  return { changed: changes.length > 0, changes };
}
