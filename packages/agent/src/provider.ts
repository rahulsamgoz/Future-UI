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
};

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
  generate(input: ProviderInput): Promise<ProviderOutput>;
}
