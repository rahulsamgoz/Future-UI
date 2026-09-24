/**
 * Target resolution service (spec sections 8 step 1 and 13). Selection is
 * authoritative; text resolves over a lexical index built in memory from DB
 * rows (cached per project, invalidated when a capture is ingested);
 * screenshot grounding is honestly unsupported in the dev profile.
 */
import type { ResolveResponse, TargetQuery } from "@ui-intelligence/protocol";
import { buildLexicalIndex, resolveTargetFromText, type LexicalIndex } from "@ui-intelligence/indexing";
import type { Db } from "./db.js";
import { getEntityById } from "./store.js";

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

export function resolveTarget(db: Db, projectId: string, cache: LexicalIndexCache, query: TargetQuery): ResolveResponse {
  if (query.kind === "selection") {
    const entity = getEntityById(db, projectId, query.entityId);
    if (!entity) {
      return { status: "no_match", reason: `no entity with id or key "${query.entityId}" in this project` };
    }
    return { status: "resolved", entityId: entity.id, entityKey: entity.entityKey };
  }

  if (query.kind === "screenshot") {
    // Honest dev-profile limitation (spec section 13): no visual grounding.
    return {
      status: "no_match",
      reason: "screenshot grounding requires artifact analysis not configured in dev profile",
    };
  }

  const index = cache.get(projectId);
  return resolveTargetFromText(index, { text: query.text }, anchorSourcesForProject(db, projectId));
}
