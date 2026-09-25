/**
 * RuleEngine (R2 plan part C): evaluates persistent semantic rules against a
 * rule evaluation context and an entity contract. Rules are HINTS — the
 * engine never mutates preferences; the call site applies the deterministic
 * precedence explicit preference > rule > contract default via
 * `RuleEngine.resolveRepresentation`.
 */
import type {
  EntityContract,
  JsonValue,
  RuleEvaluationContext,
  SemanticRule,
} from "@ui-intelligence/protocol";
import type {
  RendererPropertySchema,
  RendererRegistry,
} from "./renderer.js";

export type RuleEvaluationResult = {
  representation: string;
  properties: Record<string, JsonValue>;
  ruleId: string;
};

export class RuleEngine {
  #rules: readonly SemanticRule[];
  /**
   * When a registry is supplied, a rule's action properties must conform to
   * the registered renderer's property schema; nonconforming rules are
   * skipped (never thrown). Without a registry the property check cannot
   * run and is skipped as well.
   */
  #renderers: RendererRegistry | null;

  constructor(rules: SemanticRule[], renderers?: RendererRegistry) {
    this.#rules = [...rules];
    this.#renderers = renderers ?? null;
  }

  /** Snapshot of the rules this engine was built with. */
  list(): SemanticRule[] {
    return [...this.#rules];
  }

  /**
   * Return the LAST matching enabled rule (later rules win: rules are
   * appended over time and the most recent intent wins), or null. A rule
   * matches when every present condition equals the context, its
   * representation is allowed by the contract, and its properties conform
   * to the renderer's property schema. Never throws for a nonconforming
   * rule — it is skipped.
   */
  evaluate(ctx: RuleEvaluationContext, contract: EntityContract): RuleEvaluationResult | null {
    let match: RuleEvaluationResult | null = null;
    for (const rule of this.#rules) {
      if (!rule.enabled) continue;
      if (!RuleEngine.conditionsMatch(rule, ctx)) continue;
      if (!contract.allowedRepresentations.includes(rule.action.representation)) continue;
      if (!this.#propertiesConform(rule)) continue;
      match = {
        representation: rule.action.representation,
        properties: { ...rule.action.properties },
        ruleId: rule.ruleId,
      };
    }
    return match;
  }

  /**
   * Deterministic precedence (architecture section 9, extended by R2 part C):
   * explicit personal preference > matching rule > contract default (the
   * first allowed representation). The explicit preference is returned as-is
   * — it was validated against the contract when it was applied.
   */
  static resolveRepresentation(
    explicitPref: string | null,
    engine: RuleEngine,
    ctx: RuleEvaluationContext,
    contract: EntityContract,
  ): string {
    if (explicitPref) return explicitPref;
    return engine.evaluate(ctx, contract)?.representation ?? contract.allowedRepresentations[0]!;
  }

  static conditionsMatch(rule: SemanticRule, ctx: RuleEvaluationContext): boolean {
    const { conditions } = rule;
    if (conditions.route !== undefined && conditions.route !== ctx.route) return false;
    if (conditions.viewportClass !== undefined && conditions.viewportClass !== ctx.viewportClass) {
      return false;
    }
    if (conditions.entityKey !== undefined && conditions.entityKey !== ctx.entityKey) return false;
    return true;
  }

  #propertiesConform(rule: SemanticRule): boolean {
    if (!this.#renderers) return true;
    let descriptor;
    try {
      descriptor = this.#renderers.get(rule.action.representation);
    } catch {
      // Unregistered renderer: cannot verify the property schema — skip.
      return false;
    }
    return propertiesConformToSchema(rule.action.properties, descriptor.propertySchema);
  }
}

/** Strict schema check (mirrors the proposal validator's property invariant). */
function propertiesConformToSchema(
  properties: Record<string, JsonValue>,
  propertySchema: Record<string, RendererPropertySchema>,
): boolean {
  for (const [key, value] of Object.entries(properties)) {
    const schema = propertySchema[key];
    if (!schema) return false; // unknown properties cannot add executable power
    switch (schema.type) {
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) return false;
        if (
          (schema.min !== undefined && value < schema.min) ||
          (schema.max !== undefined && value > schema.max)
        ) {
          return false;
        }
        break;
      case "string":
        if (typeof value !== "string") return false;
        break;
      case "boolean":
        if (typeof value !== "boolean") return false;
        break;
      case "enum":
        if (!(schema.values ?? []).includes(value as string | number)) return false;
        break;
    }
  }
  return true;
}
