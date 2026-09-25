/**
 * Request protocol (protocol section 8). Target evidence stays separate from
 * design references so a reference from an unrelated app cannot silently
 * become a target identity.
 */
import { z } from "zod";
import { pageContractSchema } from "./contract.js";

export const targetQuerySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selection"), entityId: z.string().min(1), runtimeInstanceId: z.string().min(1) }),
  z.object({ kind: z.literal("text"), text: z.string().min(1) }),
  z.object({ kind: z.literal("screenshot"), artifactId: z.string().min(1), cropId: z.string().optional() }),
  // Page scope (audit fix: the proposal API supports page targets). The
  // client supplies its page contract; layout candidates are validated
  // against it server-side AND revalidated against the app's own contracts
  // at acceptance (PageComposer), so a permissive submitted contract cannot
  // reach the rendered page.
  z.object({ kind: z.literal("page"), pageKey: z.string().min(1), pageContract: pageContractSchema }),
]);
export type TargetQuery = z.infer<typeof targetQuerySchema>;

export const designReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("history"), captureId: z.string().min(1), occurrenceId: z.string().optional() }),
  z.object({ kind: z.literal("image"), artifactId: z.string().min(1) }),
  z.object({ kind: z.literal("text"), text: z.string().min(1) }),
]);
export type DesignReference = z.infer<typeof designReferenceSchema>;

export const uiRequestSchema = z.object({
  requestId: z.string().min(1),
  operation: z.enum(["show_history", "compare", "propose_change"]),
  target: targetQuerySchema,
  references: z.array(designReferenceSchema).default([]),
  instruction: z.string().default(""),
  appBuildId: z.string().min(1),
  requestedCandidateCount: z.number().int().min(1).max(8).default(4),
});
export type UiRequest = z.infer<typeof uiRequestSchema>;

export type ResolveCandidate = {
  entityId: string;
  entityKey: string;
  score: number; // uncalibrated similarity rank input, not a probability
  explanation: string;
};

export type ResolveResponse =
  | { status: "resolved"; entityId: string; entityKey: string }
  | { status: "ambiguous"; candidates: ResolveCandidate[] }
  | { status: "no_match"; reason: string };
