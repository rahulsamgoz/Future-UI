/**
 * Grounded design references (audit fix: image/history references were
 * placeholder strings in provider input). The API owns the stored capture
 * data, so the proposal processor resolves history references to the REAL
 * observation content (visible text, anchor, commit, evidence label) and the
 * capture's screenshot artifact id before the orchestrator calls the model.
 *
 * Audit finding 4: image content is grounded too. The loader returns the
 * artifact's BYTES (read from the object store) so vision providers can be
 * given base64 data URLs without a network fetch, AND a fetchable absolute
 * URL built from the raw artifact endpoint plus the configured external API
 * base (UI_INTEL_PUBLIC_API_BASE, default http://localhost:8787) for the
 * bytes-absent fallback.
 */
import type { DesignReference } from "@ui-intelligence/protocol";
import type { ProviderReference } from "@ui-intelligence/agent";
import type { Db } from "./db.js";
import type { ObjectStore } from "./objectstore.js";

export type ReferenceLoader = (ref: DesignReference) => Promise<ProviderReference | null>;

export type ReferenceLoaderOptions = {
  /** Object store for artifact bytes (bytes-first vision grounding). */
  store?: ObjectStore;
  /** External base URL providers can fetch artifact URLs from. */
  publicApiBase?: string;
};

type ArtifactRow = { id: string; digest: string; mime_type: string };

/** Load one artifact's bytes + fetchable URL, or the fields that ARE available. */
async function groundArtifact(
  db: Db,
  projectId: string,
  artifactId: string,
  options: ReferenceLoaderOptions
): Promise<Pick<ProviderReference, "imageBytes" | "imageUrl" | "imageMediaType">> {
  const artifact = db
    .prepare("SELECT id, digest, mime_type FROM artifacts WHERE project_id = ? AND id = ?")
    .get(projectId, artifactId) as ArtifactRow | undefined;
  if (!artifact) return {};

  const base = (
    options.publicApiBase ??
    process.env.UI_INTEL_PUBLIC_API_BASE ??
    "http://localhost:8787"
  ).replace(/\/$/, "");
  const imageUrl = `${base}/v1/artifacts/${encodeURIComponent(artifact.id)}/raw?projectId=${encodeURIComponent(projectId)}`;

  let imageBytes: Uint8Array | undefined;
  if (options.store) {
    try {
      const bytes = await options.store.get(artifact.digest);
      if (bytes && bytes.length > 0) imageBytes = new Uint8Array(bytes);
    } catch {
      // bytes unavailable: the fetchable URL is the fallback path
    }
  }
  return {
    ...(imageBytes ? { imageBytes } : {}),
    imageUrl,
    imageMediaType: artifact.mime_type || "image/png",
  };
}

/** Build a project-scoped reference loader over the SQLite store. */
export function dbReferenceLoader(db: Db, projectId: string, options: ReferenceLoaderOptions = {}): ReferenceLoader {
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
      // Vision providers also get the screenshot artifact bytes/URL the same
      // way as image references (audit finding 4).
      const screenshot = artifactId ? await groundArtifact(db, projectId, artifactId, options) : {};
      return {
        kind: "history",
        summary,
        text: occurrence?.visible_text ?? undefined,
        ...(artifactId ? { artifactId } : {}),
        ...screenshot,
      };
    }

    if (ref.kind === "image") {
      const artifact = db
        .prepare("SELECT id FROM artifacts WHERE project_id = ? AND id = ?")
        .get(projectId, ref.artifactId);
      if (!artifact) return null;
      const grounded = await groundArtifact(db, projectId, ref.artifactId, options);
      return {
        kind: "image",
        summary: `design image artifact ${ref.artifactId}`,
        artifactId: ref.artifactId,
        ...grounded,
      };
    }

    return null;
  };
}
