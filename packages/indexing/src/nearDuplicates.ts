/**
 * Near-duplicate capture grouping (spec section 13: "For historical
 * alternatives, group near-duplicate captures but retain the underlying
 * evidence"). Grouping is a presentation optimization only — members are
 * never dropped from the input data.
 */
import type { CaptureRecord } from "@ui-intelligence/protocol";
import { BOUNDS_TOLERANCE_PX } from "./compare.js";

export type NearDuplicateGroup = {
  representativeId: string;
  memberIds: string[];
};

function sortedAnchors(record: CaptureRecord): string[] {
  return record.manifest.observations
    .map((o) => o.explicitAnchor)
    .filter((a): a is string => typeof a === "string")
    .sort();
}

/**
 * Multiset of visible texts: sorted so identical multisets produce identical
 * keys regardless of observation order.
 */
function textMultisetKey(record: CaptureRecord): string {
  return record.manifest.observations
    .map((o) => o.visibleText ?? "")
    .sort()
    .join("\u0000");
}

function boundsWithin(a: number[] | undefined, b: number[] | undefined): boolean {
  if (!a || !b) return false;
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  return (
    Math.abs(ax - bx) <= BOUNDS_TOLERANCE_PX &&
    Math.abs(ay - by) <= BOUNDS_TOLERANCE_PX &&
    Math.abs(aw - bw) <= BOUNDS_TOLERANCE_PX &&
    Math.abs(ah - bh) <= BOUNDS_TOLERANCE_PX
  );
}

function primaryRects(record: CaptureRecord): Map<string, number[]> {
  const rects = new Map<string, number[]>();
  for (const obs of record.manifest.observations) {
    if (!obs.explicitAnchor) continue;
    const rect = obs.bounds[0];
    if (rect) rects.set(obs.explicitAnchor, [rect.x, rect.y, rect.width, rect.height]);
  }
  return rects;
}

function capturesNearDuplicate(a: CaptureRecord, b: CaptureRecord): boolean {
  const rectsA = primaryRects(a);
  const rectsB = primaryRects(b);
  if (rectsA.size !== rectsB.size) return false;
  for (const [anchor, rectA] of rectsA) {
    if (!boundsWithin(rectA, rectsB.get(anchor))) return false;
  }
  return true;
}

/**
 * Group captures of the same scenario whose anchor set and visible-text
 * multiset are identical and whose observation bounds are within 2px.
 * The representative is the earliest capture in the group.
 */
export function groupNearDuplicates(captures: CaptureRecord[]): NearDuplicateGroup[] {
  const sorted = [...captures].sort((a, b) =>
    a.createdAt === b.createdAt ? a.captureId.localeCompare(b.captureId) : a.createdAt.localeCompare(b.createdAt)
  );

  const buckets = new Map<string, CaptureRecord[]>();
  for (const record of sorted) {
    const key = [
      record.scenarioId,
      sortedAnchors(record).join("\u0001"),
      textMultisetKey(record),
    ].join("\u0002");
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record);
    else buckets.set(key, [record]);
  }

  const groups: NearDuplicateGroup[] = [];
  for (const bucket of buckets.values()) {
    const openGroups: Array<{ representative: CaptureRecord; memberIds: string[] }> = [];
    for (const record of bucket) {
      const target = openGroups.find((g) => capturesNearDuplicate(g.representative, record));
      if (target) {
        target.memberIds.push(record.captureId);
      } else {
        openGroups.push({ representative: record, memberIds: [record.captureId] });
      }
    }
    for (const g of openGroups) groups.push({ representativeId: g.representative.captureId, memberIds: g.memberIds });
  }

  return groups;
}
