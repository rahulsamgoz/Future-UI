/**
 * Runtime contracts (protocol section 6): semantic boundaries, data/action
 * bindings, state adapters, and the runtime manifest.
 *
 * The developer supplies the actual data provider, action functions, and
 * state handling in trusted app code. The manifest contains references, not
 * serialized executable functions.
 */
import { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const contractRefSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  schemaDigest: z.string().min(1),
});
export type ContractRef = z.infer<typeof contractRefSchema>;

export type DataSnapshot = {
  revision: string;
  status: "loading" | "ready" | "error";
  value: JsonValue;
};

export type DataBinding = {
  contract: ContractRef;
  getSnapshot(): DataSnapshot;
  subscribe(onChange: () => void): () => void;
};

export type ActionResult =
  | { status: "succeeded"; value: JsonValue }
  | { status: "rejected"; code: "denied" | "invalid_input" | "stale_data" }
  | { status: "failed"; retryable: boolean };

export type ActionBinding = {
  contract: ContractRef;
  invoke(
    input: JsonValue,
    context: { invocationId: string; dataRevision?: string; signal: AbortSignal }
  ): Promise<ActionResult>;
};

export type StateAdapter = {
  version: number;
  canSwitch(): { allowed: true } | { allowed: false; reason: string };
  exportState(): JsonValue;
  validateState(state: JsonValue, destinationRenderer: string): boolean;
  importState(state: JsonValue): void;
};

/** A versioned app operation or data binding, e.g. `catalog.products@1`. */
export type CapabilityDescriptor = {
  ref: ContractRef;
  kind: "data" | "action";
  /** JSON Schema (draft 2020-12 subset) describing value/input shape. */
  schema: { type: string; properties?: Record<string, unknown>; required?: string[] } & Record<string, unknown>;
  description?: string;
};

/** Developer-declared semantic boundary registration (protocol section 6). */
export const entityContractSchema = z.object({
  entityKey: z.string().min(1), // e.g. "catalog.productChooser"
  contractVersion: z.number().int().positive(),
  dataBinding: z.string().min(1), // e.g. "catalog.products@1"
  allowedRepresentations: z.array(z.string().min(1)).min(1),
  actions: z.array(z.string().min(1)).default([]),
  requiredFields: z.array(z.string().min(1)).default([]),
  stateFields: z.array(z.string().min(1)).default([]),
  constraints: z
    .object({
      preserveActions: z.boolean().default(true),
      preservePriceVisibility: z.boolean().default(false),
      maximumColumns: z.number().int().positive().optional(),
    })
    .passthrough()
    .default({}),
});
export type EntityContract = z.infer<typeof entityContractSchema>;

/** Page contract: slots for page composition (protocol section 7). */
export const pageContractSchema = z.object({
  pageKey: z.string().min(1),
  contractVersion: z.number().int().positive(),
  slots: z.array(
    z.object({
      slotId: z.string().min(1),
      entityKey: z.string().min(1),
      required: z.boolean().default(true),
      locked: z.boolean().default(false),
      repeatable: z.boolean().default(false),
      compatibleRenderers: z.array(z.string().min(1)).default([]),
    })
  ),
  allowedLayouts: z.array(z.enum(["stack@1", "grid@1", "split@1"])).min(1),
  maxDepth: z.number().int().positive().default(4),
  maxNodes: z.number().int().positive().default(32),
});
export type PageContract = z.infer<typeof pageContractSchema>;

/** Runtime adapter capability advertisement. */
export type AdapterCapabilities = {
  observation: boolean;
  sourceLinking: boolean;
  tokenOverrides: boolean;
  representationReplacement: boolean;
  composition: boolean;
  stateTransfer: boolean;
  historicalExecution: boolean;
};

/** Public runtime manifest: only permitted entity keys and contracts. */
export type RuntimeManifest = {
  protocolVersion: number;
  rendererVersions: Record<string, number>;
  adapterCapabilities: AdapterCapabilities;
  entities: Array<{
    entityKey: string;
    contractVersion: number;
    allowedRepresentations: string[];
    dataBinding: string;
    actions: string[];
  }>;
  pages: Array<{ pageKey: string; contractVersion: number; slots: string[] }>;
  buildId: string;
  contractDigest: string;
};
