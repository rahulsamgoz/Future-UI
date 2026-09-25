/**
 * Persistent semantic rules (architecture section 8 extension, R2 plan
 * part C). A rule is a persisted HINT: given a route/viewport/entity context
 * it suggests a representation (with optional properties) for one registered
 * entity. Rules never override an explicit personal preference — the call
 * site applies preference > rule > contract default.
 */
import { z } from "zod";
import type { JsonValue } from "./contract.js";

export type RuleConditions = {
  /** Route label, e.g. "catalog" or "account". Omitted = any route. */
  route?: string;
  viewportClass?: "desktop" | "mobile";
  /** Registered entity key this rule targets. Omitted = any entity. */
  entityKey?: string;
};

export type SemanticRule = {
  ruleId: string;
  version: 1;
  name: string;
  enabled: boolean;
  conditions: RuleConditions;
  action: {
    representation: string;
    properties: Record<string, JsonValue>;
  };
  /** Contract version the rule was validated against. */
  contractVersion: number;
  createdAt: string;
};

export type RuleEvaluationContext = {
  route: string;
  viewportClass: "desktop" | "mobile";
  entityKey: string;
};

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const ruleConditionsSchema = z.object({
  route: z.string().min(1).optional(),
  viewportClass: z.enum(["desktop", "mobile"]).optional(),
  entityKey: z.string().min(1).optional(),
});

export const semanticRuleSchema: z.ZodType<SemanticRule> = z.object({
  ruleId: z.string().min(1),
  version: z.literal(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  conditions: ruleConditionsSchema,
  action: z.object({
    representation: z.string().min(1),
    properties: z.record(z.string(), jsonValueSchema),
  }),
  contractVersion: z.number().int().positive(),
  createdAt: z.string().min(1),
});
