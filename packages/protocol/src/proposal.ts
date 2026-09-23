/**
 * Executable UI proposals (protocol section 7).
 *
 * Two distinct representations:
 *  1. Observed UI graph: permissive, partial, descriptive evidence.
 *  2. Executable presentation specification: validated composition of
 *     approved types, bindings, tokens, and actions.
 *
 * A proposal contains no arbitrary JavaScript, event-handler strings, URLs,
 * CSS expressions, or backend credentials.
 */
import { z } from "zod";
import type { JsonValue } from "./contract.js";

export const presentationSchema = z.object({
  type: z.string().min(1), // e.g. "grid@1"
  properties: z.record(z.unknown()).default({}),
  dataBinding: z.string().min(1),
  actions: z.array(z.string().min(1)).default([]),
});
export type Presentation = z.infer<typeof presentationSchema>;

export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("layout"),
      nodeId: z.string().min(1),
      type: z.enum(["stack@1", "grid@1", "split@1"]),
      properties: z.record(z.custom<JsonValue>(() => true)).default({}),
      children: z.array(layoutNodeSchema),
    }),
    z.object({
      kind: z.literal("region"),
      nodeId: z.string().min(1),
      slotId: z.string().min(1),
      entityId: z.string().min(1),
      representationId: z.string().optional(),
    }),
  ])
);
export type LayoutNode =
  | {
      kind: "layout";
      nodeId: string;
      type: "stack@1" | "grid@1" | "split@1";
      properties: Record<string, JsonValue>;
      children: LayoutNode[];
    }
  | {
      kind: "region";
      nodeId: string;
      slotId: string;
      entityId: string;
      representationId?: string;
    };

export const targetScopeSchema = z.enum(["entity", "instance", "page", "batch"]);
export type TargetScope = z.infer<typeof targetScopeSchema>;

export const proposalSchema = z.object({
  schemaVersion: z.literal(1),
  proposalId: z.string().min(1),
  target: z.object({
    entityId: z.string().min(1),
    entityVersionId: z.string().min(1),
    scope: targetScopeSchema,
    lockedEntityIds: z.array(z.string().min(1)).default([]),
    /** For batch scope: every participating target. */
    batchTargets: z
      .array(z.object({ entityId: z.string().min(1), entityVersionId: z.string().min(1) }))
      .default([]),
  }),
  preconditions: z.object({
    appBuildId: z.string().min(1),
    contractDigest: z.string().min(1),
    policyVersion: z.number().int().nonnegative(),
    preferenceRevision: z.number().int().nonnegative(),
  }),
  presentation: z.unknown(), // Presentation for entity scope, LayoutNode root for page scope
  origin: z.object({
    kind: z.enum(["generated", "historical_adaptation", "recorded_history"]),
    referenceIds: z.array(z.string()).default([]),
  }),
});
export type Proposal = z.infer<typeof proposalSchema>;

export type TargetReadSet = {
  appBuildId: string;
  contractDigest: string;
  policyVersion: number;
  preferenceRevision: number;
  entityVersions: Record<string, string>;
};

export type CheckedInvariant =
  | "schema"
  | "supported_type"
  | "property_ranges"
  | "binding_version"
  | "required_fields"
  | "locked_regions"
  | "scope"
  | "slot_membership"
  | "unique_node_ids"
  | "allowed_children"
  | "depth_bound"
  | "node_count_bound"
  | "representation_compatibility";

export type ValidationReport = {
  schemaVersion: number;
  validatorVersion: string;
  policyRevision: number;
  targetReadSet: TargetReadSet;
  checkedInvariants: CheckedInvariant[];
  unsupportedChecks: string[];
  passed: boolean;
  errors: Array<{ code: string; message: string; path?: string }>;
  specificationDigest: string;
};

export type ProposalStatus =
  | "queued"
  | "resolving"
  | "needs_selection"
  | "generating"
  | "validating"
  | "ready"
  | "failed"
  | "cancelled";

export type ProposalCandidate = {
  candidateId: string;
  presentation: unknown; // Presentation or LayoutNode
  origin: Proposal["origin"];
  validation: ValidationReport;
  summary: string;
};
