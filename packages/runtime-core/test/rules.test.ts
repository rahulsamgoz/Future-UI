/**
 * RuleEngine unit tests (R2 plan part C): condition matching, disabled
 * rules, contract/renderer conformance filtering, later-rule-wins, and the
 * resolveRepresentation precedence (explicit preference > rule > default).
 */
import { describe, expect, it } from "vitest";
import { RendererRegistry, RuleEngine } from "../src/index.js";
import type { RendererDescriptor } from "../src/index.js";
import type { EntityContract, SemanticRule } from "@ui-intelligence/protocol";

const buttonDescriptor: RendererDescriptor = {
  id: "button.compact@1",
  version: 1,
  propertySchema: {
    label: { type: "string", default: "" },
    variant: { type: "enum", values: ["default", "compact"], default: "compact" },
  },
  compatibleWith: (c) => c.entityKey === "ui.primaryButton",
};

const buttonDefaultDescriptor: RendererDescriptor = {
  ...buttonDescriptor,
  id: "button.default@1",
  propertySchema: {
    label: { type: "string", default: "" },
    variant: { type: "enum", values: ["default", "compact"], default: "default" },
  },
};

function makeRegistry(): RendererRegistry {
  const registry = new RendererRegistry();
  registry.register(buttonDescriptor);
  registry.register(buttonDefaultDescriptor);
  return registry;
}

const contract: EntityContract = {
  entityKey: "ui.primaryButton",
  contractVersion: 1,
  dataBinding: "ui.label@1",
  allowedRepresentations: ["button.default@1", "button.compact@1"],
  actions: [],
  requiredFields: ["label"],
  stateFields: [],
  constraints: { preserveActions: true, preservePriceVisibility: false },
};

const ctx = { route: "catalog", viewportClass: "mobile" as const, entityKey: "ui.primaryButton" };

let seq = 0;
function makeRule(over: Partial<SemanticRule> = {}): SemanticRule {
  seq += 1;
  return {
    ruleId: `rule_${seq}`,
    version: 1,
    name: `Rule ${seq}`,
    enabled: true,
    conditions: { entityKey: "ui.primaryButton" },
    action: { representation: "button.compact@1", properties: {} },
    contractVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("RuleEngine matching", () => {
  it("matches a rule whose route, viewport, and entity conditions all equal the context", () => {
    const engine = new RuleEngine(
      [
        makeRule({
          conditions: { route: "catalog", viewportClass: "mobile", entityKey: "ui.primaryButton" },
        }),
      ],
      makeRegistry(),
    );
    expect(engine.evaluate(ctx, contract)).toEqual({
      representation: "button.compact@1",
      properties: {},
      ruleId: "rule_1",
    });
  });

  it("does not match when the route differs", () => {
    const engine = new RuleEngine(
      [makeRule({ conditions: { route: "account", entityKey: "ui.primaryButton" } })],
      makeRegistry(),
    );
    expect(engine.evaluate(ctx, contract)).toBeNull();
  });

  it("does not match when the viewport class differs", () => {
    const engine = new RuleEngine(
      [makeRule({ conditions: { viewportClass: "desktop", entityKey: "ui.primaryButton" } })],
      makeRegistry(),
    );
    expect(engine.evaluate(ctx, contract)).toBeNull();
  });

  it("does not match when the entity key differs", () => {
    const engine = new RuleEngine(
      [makeRule({ conditions: { entityKey: "catalog.productChooser" } })],
      makeRegistry(),
    );
    expect(engine.evaluate(ctx, contract)).toBeNull();
  });

  it("treats absent conditions as always matching", () => {
    const engine = new RuleEngine([makeRule({ conditions: {} })], makeRegistry());
    expect(
      engine.evaluate({ route: "account", viewportClass: "desktop", entityKey: "ui.primaryButton" }, contract),
    ).not.toBeNull();
  });
});

describe("RuleEngine conformance filtering", () => {
  it("skips disabled rules", () => {
    const engine = new RuleEngine([makeRule({ enabled: false })], makeRegistry());
    expect(engine.evaluate(ctx, contract)).toBeNull();
  });

  it("skips rules whose representation is not allowed by the contract", () => {
    const engine = new RuleEngine(
      [makeRule({ action: { representation: "list.virtual@1", properties: {} } })],
      makeRegistry(),
    );
    expect(engine.evaluate(ctx, contract)).toBeNull();
  });

  it("skips rules whose properties violate the renderer property schema", () => {
    const badVariant = new RuleEngine(
      [makeRule({ action: { representation: "button.compact@1", properties: { variant: "gigantic" } } })],
      makeRegistry(),
    );
    expect(badVariant.evaluate(ctx, contract)).toBeNull();

    const unknownKey = new RuleEngine(
      [makeRule({ action: { representation: "button.compact@1", properties: { nope: true } } })],
      makeRegistry(),
    );
    expect(unknownKey.evaluate(ctx, contract)).toBeNull();
  });

  it("skips rules whose representation is not registered (cannot verify schema)", () => {
    const engine = new RuleEngine(
      [makeRule({ action: { representation: "button.default@1", properties: {} } })],
      // Registry without button.default@1 registered.
      (() => {
        const registry = new RendererRegistry();
        registry.register(buttonDescriptor);
        return registry;
      })(),
    );
    expect(engine.evaluate(ctx, contract)).toBeNull();
  });

  it("passes conforming rule properties through to the result", () => {
    const engine = new RuleEngine(
      [makeRule({ action: { representation: "button.compact@1", properties: { variant: "compact" } } })],
      makeRegistry(),
    );
    expect(engine.evaluate(ctx, contract)?.properties).toEqual({ variant: "compact" });
  });

  it("skips the property check (without failing) when no registry is supplied", () => {
    const engine = new RuleEngine([
      makeRule({ action: { representation: "button.compact@1", properties: { whatever: 1 } } }),
    ]);
    expect(engine.evaluate(ctx, contract)).not.toBeNull();
  });
});

describe("RuleEngine precedence within rules", () => {
  it("returns the LAST matching rule: later rules win over earlier ones", () => {
    const engine = new RuleEngine(
      [
        makeRule({
          ruleId: "rule_early",
          action: { representation: "button.compact@1", properties: {} },
        }),
        makeRule({
          ruleId: "rule_late",
          action: { representation: "button.default@1", properties: { variant: "default" } },
        }),
      ],
      makeRegistry(),
    );
    const result = engine.evaluate(ctx, contract);
    expect(result?.representation).toBe("button.default@1");
    expect(result?.ruleId).toBe("rule_late");
    expect(result?.properties).toEqual({ variant: "default" });
  });

  it("later disabled rules lose to an earlier enabled match", () => {
    const engine = new RuleEngine(
      [
        makeRule({ action: { representation: "button.compact@1", properties: {} } }),
        makeRule({ enabled: false, action: { representation: "button.default@1", properties: {} } }),
      ],
      makeRegistry(),
    );
    expect(engine.evaluate(ctx, contract)?.representation).toBe("button.compact@1");
  });
});

describe("RuleEngine.resolveRepresentation precedence", () => {
  it("explicit preference wins over a matching rule", () => {
    const engine = new RuleEngine([makeRule()], makeRegistry());
    expect(RuleEngine.resolveRepresentation("button.default@1", engine, ctx, contract)).toBe(
      "button.default@1",
    );
  });

  it("a matching rule wins over the contract default", () => {
    const engine = new RuleEngine([makeRule()], makeRegistry());
    expect(RuleEngine.resolveRepresentation(null, engine, ctx, contract)).toBe("button.compact@1");
  });

  it("falls back to the contract default (first allowed representation) when nothing matches", () => {
    const engine = new RuleEngine([], makeRegistry());
    expect(RuleEngine.resolveRepresentation(null, engine, ctx, contract)).toBe("button.default@1");
    expect(
      RuleEngine.resolveRepresentation(null, engine, {
        route: "account",
        viewportClass: "desktop",
        entityKey: "ui.primaryButton",
      }, contract),
    ).toBe("button.default@1");
  });
});

describe("RuleEngine.list", () => {
  it("returns a copy of the rules it was built with", () => {
    const rules = [makeRule()];
    const engine = new RuleEngine(rules, makeRegistry());
    expect(engine.list()).toEqual(rules);
    engine.list().pop();
    expect(engine.list()).toHaveLength(1);
  });
});
