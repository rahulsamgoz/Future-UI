/**
 * Model provider interface (spec section 8: "Provider selection is
 * configurable, and validation does not trust the provider's claim of
 * correctness"). No LLM SDK dependency — providers are plain interfaces.
 */

export type RendererPropertySchema = {
  type: string;
  values?: (string | number)[];
  min?: number;
  max?: number;
  default?: unknown;
};

export type RendererSchema = {
  id: string; // e.g. "grid@1"
  propertySchema: Record<string, RendererPropertySchema>;
};

export type ProviderTargetContract = {
  entityKey: string;
  allowedRepresentations: string[];
  dataBinding: string;
  actions: string[];
};

export type ProviderReference = {
  kind: "history" | "image" | "text";
  summary: string;
  /**
   * Grounded observation content (history references): the real captured
   * visible text. Text-first providers consume this via the summary/text;
   * it is never a placeholder string when a reference loader ran.
   */
  text?: string;
  /** Grounded artifact id: the capture's screenshot (history) or the image itself. */
  artifactId?: string;
  /**
   * Fetchable URL for the artifact (e.g. presigned/public). Populated only
   * when the caller's reference loader can produce one. Vision-declaring
   * providers attach it as an image_url part; the text-first path (e.g. the
   * text-only space-bunny-free model) never requires it and stays default.
   */
  url?: string;
  /**
   * Grounded artifact BYTES (audit finding 4): the reference loader reads the
   * object store so vision providers can be given a base64 data URL directly
   * — bytes-first, no network fetch by the provider is needed. Absent when
   * no object store is available to the loader.
   */
  imageBytes?: Uint8Array;
  /**
   * Fetchable URL for the grounded artifact (closure-2 GAP A): previously
   * populated with the auth-gated `/v1/artifacts/:id/raw` endpoint, but
   * external model providers fetch WITHOUT credentials and receive 401, making
   * the URL unusable. The field is kept in the type for a future short-lived
   * signed-URL fallback, but for now bytes-first is the only supported
   * delivery mechanism and this field is NOT populated by the reference loader.
   */
  imageUrl?: string;
  /** Media type of imageBytes/imageUrl (default "image/png"). */
  imageMediaType?: string;
};

/**
 * True when a reference carries image content a vision provider can attach —
 * the exact conditions the OpenAI-compatible provider's vision path uses
 * (bytes first, then fetchable imageUrl, then the legacy `url` for image
 * refs). Shared by the orchestrator's degraded-note accounting so a dropped
 * image is never under-counted (closure review).
 */
export function referenceHasImageContent(reference: ProviderReference): boolean {
  if ((reference.imageBytes?.length ?? 0) > 0) return true;
  if (typeof reference.imageUrl === "string" && reference.imageUrl.length > 0) return true;
  return (
    reference.kind === "image" &&
    typeof reference.url === "string" &&
    reference.url.length > 0
  );
}

export type ProviderInput = {
  instruction: string;
  targetContract: ProviderTargetContract;
  rendererSchemas: RendererSchema[];
  references: ProviderReference[];
  requestedCandidateCount: number;
  seed?: number;
};

export type ProviderOriginKind = "generated" | "historical_adaptation" | "recorded_history";

export type ProviderCandidate = {
  type: string;
  properties: Record<string, unknown>;
  originKind: ProviderOriginKind;
  summary: string;
};

export type ProviderOutput = {
  candidates: ProviderCandidate[];
  /** Set when the provider could not produce candidates (e.g. network error). */
  degraded?: string;
};

export interface ModelProvider {
  readonly id: string;
  /**
   * Declared capabilities (optional; undeclared = text-only). The
   * orchestrator reads this to surface an honest "N image references
   * ignored: provider not vision-capable" note instead of silently dropping
   * image references (audit finding 4).
   */
  readonly capabilities?: { vision?: boolean };
  generate(input: ProviderInput): Promise<ProviderOutput>;
}
