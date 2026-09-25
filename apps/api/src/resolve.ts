/**
 * Target resolution service (spec sections 8 step 1 and 13). Selection is
 * authoritative; text resolves over a lexical index built in memory from DB
 * rows (cached per project, invalidated when a capture is ingested);
 * screenshots are grounded by comparing the uploaded crop against occurrence
 * regions in authorized captures' screenshots. Scores are similarity ranks —
 * never displayed as confidence percentages.
 */
import type { ResolveResponse, TargetQuery } from "@ui-intelligence/protocol";
import {
  buildLexicalIndex,
  decodePng,
  groundScreenshot,
  resolveTargetFromText,
  type DecodedImage,
  type GroundCandidate,
  type LexicalIndex,
} from "@ui-intelligence/indexing";
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import type { Db } from "./db.js";
import { ObjectStore } from "./objectstore.js";
import { getArtifact, getEntityById } from "./store.js";

export class LexicalIndexCache {
  private cache = new Map<string, { index: LexicalIndex; captureCount: number }>();

  constructor(private readonly db: Db) {}

  invalidate(projectId: string): void {
    this.cache.delete(projectId);
  }

  get(projectId: string): LexicalIndex {
    const captureCount = (
      this.db.prepare("SELECT COUNT(*) AS n FROM captures WHERE project_id = ?").get(projectId) as { n: number }
    ).n;
    const cached = this.cache.get(projectId);
    if (cached && cached.captureCount === captureCount) return cached.index;

    const rows = this.db
      .prepare("SELECT id, anchor, visible_text FROM occurrences WHERE project_id = ?")
      .all(projectId) as Array<{ id: string; anchor: string | null; visible_text: string | null }>;
    const byCapture = new Map<string, Array<{ anchor?: string; visibleText?: string }>>();
    for (const row of rows) {
      const list = byCapture.get(row.id) ?? [];
      list.push({
        ...(row.anchor ? { anchor: row.anchor } : {}),
        ...(row.visible_text ? { visibleText: row.visible_text } : {}),
      });
      byCapture.set(row.id, list);
    }
    const index = buildLexicalIndex(
      [...byCapture.entries()].map(([captureId, observations]) => ({ captureId, observations }))
    );
    this.cache.set(projectId, { index, captureCount });
    return index;
  }
}

/** Max decoded screenshots kept per API process (spec: bounded work). */
const SCREENSHOT_CACHE_MAX = 16;

/**
 * Small LRU of decoded screenshots keyed by artifact digest, shared across
 * resolve calls so repeated grounding does not re-decode the same PNG.
 */
export class ScreenshotDecodeCache {
  private cache = new Map<string, DecodedImage | null>();

  get(digest: string): DecodedImage | null | undefined {
    if (!this.cache.has(digest)) return undefined;
    const value = this.cache.get(digest) as DecodedImage | null;
    this.cache.delete(digest);
    this.cache.set(digest, value);
    return value;
  }

  set(digest: string, image: DecodedImage | null): void {
    this.cache.delete(digest);
    this.cache.set(digest, image);
    while (this.cache.size > SCREENSHOT_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

/** Dependencies needed for screenshot grounding (resolved routes inject these). */
export type ScreenshotGroundingDeps = { store: ObjectStore; screenshotCache: ScreenshotDecodeCache };

/** Anchor sources per entity: the entity key plus anchored sub-elements. */
function anchorSourcesForProject(db: Db, projectId: string): Array<{ entityKey: string; entityId: string; anchors: string[] }> {
  const entities = db
    .prepare("SELECT id, entity_key FROM ui_entities WHERE project_id = ? ORDER BY entity_key")
    .all(projectId) as Array<{ id: string; entity_key: string }>;
  const anchors = db
    .prepare("SELECT DISTINCT anchor FROM occurrences WHERE project_id = ? AND anchor IS NOT NULL")
    .all(projectId) as Array<{ anchor: string }>;
  const anchorList = anchors.map((a) => a.anchor);

  return entities.map((entity) => {
    const related = anchorList.filter((a) => a === entity.entity_key || a.startsWith(`${entity.entity_key}.`));
    return { entityKey: entity.entity_key, entityId: entity.id, anchors: [entity.entity_key, ...related] };
  });
}

/** Resolve policy thresholds (spec section 13: abstain rather than mis-apply). */
const RESOLVED_SCORE = 0.9;
const RESOLVED_MARGIN = 1.15;
const AMBIGUOUS_SCORE = 0.75;
const CANDIDATE_CAP = 200;

/**
 * Screenshot grounding (spec section 13). The crop artifact must belong to
 * the authorized project. Candidates are occurrences joined with their
 * capture's screenshot artifact, bounded to the latest capture per scenario
 * per anchor and capped. When resolution is weak the caller gets a shortlist
 * or an honest no_match — never a guessed entity.
 *
 * Async (audit fix, finding 4): artifact bytes come from the awaited object
 * store. Screenshot bytes for all candidates are prefetched into `prefetched`
 * so the sync `loadScreenshot` callback consumed by the pure
 * groundScreenshot helper (packages/indexing) is always a cache hit.
 */
async function resolveScreenshotTarget(
  db: Db,
  projectId: string,
  query: Extract<TargetQuery, { kind: "screenshot" }>,
  deps: ScreenshotGroundingDeps
): Promise<ResolveResponse> {
  // Ownership check: an artifact from another project (or a missing one) is a
  // 404 so cross-project grounding never leaks existence.
  const artifact = getArtifact(db, projectId, query.artifactId);
  if (!artifact) {
    throw new UiIntelligenceError("NOT_FOUND", `artifact ${query.artifactId} not found`, { httpStatus: 404 });
  }

  let crop: DecodedImage | null = null;
  const cropBytes = await deps.store.get(artifact.digest as string);
  if (cropBytes) {
    try {
      crop = decodePng(cropBytes);
    } catch {
      crop = null;
    }
  }
  if (!crop) {
    return { status: "no_match", reason: "uploaded artifact could not be decoded as a PNG image" };
  }

  // Latest capture per (anchor, scenario) with a screenshot artifact, capped.
  const rows = db
    .prepare(
      `SELECT o.id AS occurrence_id, o.anchor, o.bounds_json,
              c.id AS capture_id, c.scenario_id, c.created_at, c.manifest_json
       FROM occurrences o JOIN captures c ON c.id = o.capture_id
       WHERE o.project_id = ? AND o.anchor IS NOT NULL
       ORDER BY o.anchor ASC, c.created_at DESC, o.id ASC`
    )
    .all(projectId) as Array<{
    occurrence_id: string;
    anchor: string;
    bounds_json: string;
    capture_id: string;
    scenario_id: string;
    manifest_json: string;
  }>;

  const entityKeys = new Set(
    (db.prepare("SELECT entity_key FROM ui_entities WHERE project_id = ?").all(projectId) as Array<{ entity_key: string }>).map(
      (r) => r.entity_key
    )
  );
  const entityKeyForAnchor = (anchor: string): string | null => {
    if (entityKeys.has(anchor)) return anchor;
    for (const key of entityKeys) {
      if (anchor.startsWith(`${key}.`)) return key;
    }
    return null;
  };

  const seen = new Set<string>();
  const candidates: GroundCandidate[] = [];
  for (const row of rows) {
    const dedupeKey = `${row.anchor} ${row.scenario_id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const entityKey = entityKeyForAnchor(row.anchor);
    if (!entityKey) continue;
    let manifest: { artifacts?: Array<{ kind: string; digest: string }>; scrollOffsets?: { x: number; y: number } };
    try {
      manifest = JSON.parse(row.manifest_json);
    } catch {
      continue;
    }
    const screenshot = (manifest.artifacts ?? []).find((a) => a.kind === "screenshot-png");
    if (!screenshot) continue;
    const boundsList = JSON.parse(row.bounds_json);
    const bounds = Array.isArray(boundsList) ? boundsList[0] : null;
    if (!bounds || typeof bounds.x !== "number" || typeof bounds.width !== "number") continue;
    candidates.push({
      occurrenceId: row.occurrence_id,
      entityKey,
      captureId: row.capture_id,
      screenshotDigest: screenshot.digest,
      bounds,
      scroll: manifest.scrollOffsets ?? { x: 0, y: 0 },
    });
    if (candidates.length >= CANDIDATE_CAP) break;
  }

  // Prefetch every candidate screenshot through the async store (deduped by
  // digest), then serve the pure matcher from the prefetched bytes.
  const prefetched = new Map<string, Uint8Array | null>();
  for (const digest of new Set(candidates.map((c) => c.screenshotDigest))) {
    if (!prefetched.has(digest)) {
      prefetched.set(digest, await deps.store.get(digest));
    }
  }

  const results = groundScreenshot(
    crop,
    candidates,
    (digest) => prefetched.get(digest) ?? null,
    deps.screenshotCache
  );
  const top = results[0];
  const second = results[1];

  if (top && top.score >= RESOLVED_SCORE && (!second || top.score >= second.score * RESOLVED_MARGIN)) {
    const entity = getEntityById(db, projectId, top.entityKey);
    if (entity) {
      return { status: "resolved", entityId: entity.id, entityKey: entity.entityKey };
    }
  }

  if (top && top.score >= AMBIGUOUS_SCORE) {
    const shortlist = results.slice(0, 3);
    return {
      status: "ambiguous",
      candidates: shortlist.map((result, i) => {
        const entity = getEntityById(db, projectId, result.entityKey);
        return {
          entityId: entity?.id ?? result.entityKey,
          entityKey: result.entityKey,
          score: result.score,
          explanation: `visual similarity rank ${i + 1} of ${shortlist.length}; select the intended region`,
        };
      }),
    };
  }

  return { status: "no_match", reason: "no visually similar region found in authorized captures" };
}

export async function resolveTarget(
  db: Db,
  projectId: string,
  cache: LexicalIndexCache,
  query: TargetQuery,
  grounding?: ScreenshotGroundingDeps
): Promise<ResolveResponse> {
  if (query.kind === "selection") {
    const entity = getEntityById(db, projectId, query.entityId);
    if (!entity) {
      return { status: "no_match", reason: `no entity with id or key "${query.entityId}" in this project` };
    }
    return { status: "resolved", entityId: entity.id, entityKey: entity.entityKey };
  }

  if (query.kind === "screenshot") {
    // Without the object store wired in, grounding is honestly unavailable.
    if (!grounding) {
      return {
        status: "no_match",
        reason: "screenshot grounding requires artifact analysis not configured in dev profile",
      };
    }
    return await resolveScreenshotTarget(db, projectId, query, grounding);
  }

  if (query.kind === "page") {
    // Page targets are resolved by identity (the proposal route handles them
    // before entity resolution); resolution of a page is the page itself.
    return { status: "resolved", entityId: `page:${query.pageKey}`, entityKey: query.pageKey };
  }

  const index = cache.get(projectId);
  return resolveTargetFromText(index, { text: query.text }, anchorSourcesForProject(db, projectId));
}
