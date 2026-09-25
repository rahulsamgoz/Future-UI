/**
 * Grounded design references (audit fix: image/history references were
 * placeholder strings in provider input). The API owns the stored capture
 * data, so the proposal processor resolves history references to the REAL
 * observation content (visible text, anchor, commit, evidence label) and the
 * capture's screenshot artifact id before the orchestrator calls the model.
 */
import type { DesignReference } from "@ui-intelligence/protocol";
import type { ProviderReference } from "@ui-intelligence/agent";
import type { Db } from "./db.js";

export type ReferenceLoader = (ref: DesignReference) => Promise<ProviderReference | null>;

/** Build a project-scoped reference loader over the SQLite store. */
export function dbReferenceLoader(db: Db, projectId: string): ReferenceLoader {
  return async (ref: DesignReference): Promise<ProviderReference | null> => {
    if (ref.kind === "history") {
      const capture = db
        .prepare("SELECT id, commit_sha, evidence_label, manifest_json FROM captures WHERE project_id = ? AND id = ?")
        .get(projectId, ref.captureId) as
        | { id: string; commit_sha: string; evidence_label: string; manifest_json: string }
        | undefined;
      if (!capture) return null;

      const occurrence = (ref.occurrenceId
        ? db
            .prepare("SELECT id, anchor, visible_text FROM occurrences WHERE project_id = ? AND id = ? AND capture_id = ?")
            .get(projectId, ref.occurrenceId, ref.captureId)
        : db
            .prepare(
              `SELECT id, anchor, visible_text FROM occurrences
               WHERE project_id = ? AND capture_id = ? AND (anchor IS NOT NULL OR visible_text IS NOT NULL)
               ORDER BY id ASC LIMIT 1`
            )
            .get(projectId, ref.captureId)) as
        | { id: string; anchor: string | null; visible_text: string | null }
        | undefined;

      // Screenshot artifact id from the capture manifest (kind screenshot-png).
      let artifactId: string | undefined;
      try {
        const manifest = JSON.parse(capture.manifest_json) as {
          artifacts?: Array<{ artifactId: string; kind: string }>;
        };
        artifactId = (manifest.artifacts ?? []).find((a) => a.kind === "screenshot-png")?.artifactId;
      } catch {
        // malformed manifest: proceed without the artifact id
      }

      const head = `${capture.evidence_label} · ${capture.commit_sha.slice(0, 8)}`;
      const summary = occurrence
        ? `${head} · ${occurrence.anchor ?? "(unanchored)"}: ${occurrence.visible_text ?? "(no text)"}`
        : head;
      return {
        kind: "history",
        summary,
        text: occurrence?.visible_text ?? undefined,
        ...(artifactId ? { artifactId } : {}),
      };
    }

    if (ref.kind === "image") {
      const artifact = db
        .prepare("SELECT id FROM artifacts WHERE project_id = ? AND id = ?")
        .get(projectId, ref.artifactId);
      if (!artifact) return null;
      // Dev object store has no presigned/public URLs — the text-first path
      // is the deliverable; vision providers require `url` (not produced here).
      return { kind: "image", summary: `design image artifact ${ref.artifactId}`, artifactId: ref.artifactId };
    }

    return null;
  };
}
