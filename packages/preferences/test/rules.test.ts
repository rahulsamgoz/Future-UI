/**
 * Semantic rule persistence (R2 plan part C): the whole per-profile rule
 * list lives in ONE record under the reserved scopeKey "__rules__"
 * (scope "app"), validated on write with SCHEMA_INVALID for malformed rules.
 * Both store implementations must behave identically.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import type { SemanticRule } from "@ui-intelligence/protocol";
import { IdbPreferenceStore, MemoryPreferenceStore } from "../src/index.js";
import type { PreferenceStore } from "../src/index.js";
import { installFakeIndexedDB, uninstallFakeIndexedDB } from "./fake-idb.js";

function makeRule(over: Partial<SemanticRule> = {}): SemanticRule {
  return {
    ruleId: `rule_${Math.random().toString(16).slice(2, 8)}`,
    version: 1,
    name: "Compact on mobile",
    enabled: true,
    conditions: { viewportClass: "mobile", entityKey: "ui.primaryButton" },
    action: { representation: "button.compact@1", properties: { variant: "compact" } },
    contractVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function defineStoreSuites(makeStore: () => PreferenceStore, closeStore: (store: PreferenceStore) => void | Promise<void>): void {
  describe("semantic rule persistence", () => {
    let store: PreferenceStore;
    beforeEach(() => {
      store = makeStore();
    });
    afterEach(async () => {
      await closeStore(store);
    });

    it("returns an empty list when no rules were stored", async () => {
      expect(await store.getRules("profile_a", "project_1")).toEqual([]);
    });

    it("stores and reads back the whole rule list as one record", async () => {
      const rules = [makeRule(), makeRule({ name: "Grid on catalog" })];
      await store.putRules("profile_a", "project_1", rules);
      expect(await store.getRules("profile_a", "project_1")).toEqual(rules);
    });

    it("replaces the previous list wholesale", async () => {
      await store.putRules("profile_a", "project_1", [makeRule()]);
      const next = [makeRule(), makeRule()];
      await store.putRules("profile_a", "project_1", next);
      const readBack = await store.getRules("profile_a", "project_1");
      expect(readBack).toEqual(next);
    });

    it("isolates rules by profile and project", async () => {
      await store.putRules("profile_a", "project_1", [makeRule()]);
      expect(await store.getRules("profile_b", "project_1")).toEqual([]);
      expect(await store.getRules("profile_a", "project_2")).toEqual([]);
    });

    it("rejects malformed rules with SCHEMA_INVALID and stores nothing", async () => {
      const invalid = makeRule({ name: "" });
      await expect(store.putRules("profile_a", "project_1", [invalid])).rejects.toMatchObject({
        name: "UiIntelligenceError",
        code: "SCHEMA_INVALID",
      });
      expect(await store.getRules("profile_a", "project_1")).toEqual([]);

      const badAction = makeRule({ action: { representation: "", properties: {} } });
      await expect(store.putRules("profile_a", "project_1", [badAction])).rejects.toMatchObject({
        code: "SCHEMA_INVALID",
      });

      const badVersion = makeRule({ version: 2 as unknown as 1 });
      await expect(store.putRules("profile_a", "project_1", [badVersion])).rejects.toMatchObject({
        code: "SCHEMA_INVALID",
      });
    });

    it("carries the rules record through export/import bundles", async () => {
      const rules = [makeRule()];
      await store.putRules("profile_a", "project_1", rules);
      const bundle = await store.exportBundle("profile_a", "project_1");
      const target = makeStore();
      try {
        await target.importBundle(bundle);
        expect(await target.getRules("profile_a", "project_1")).toEqual(rules);
      } finally {
        await closeStore(target);
      }
    });
  });
}

describe("MemoryPreferenceStore rules", () => {
  let store: MemoryPreferenceStore;
  defineStoreSuites(
    () => {
      store = new MemoryPreferenceStore();
      return store;
    },
    (s) => s.close(),
  );
});

describe("IdbPreferenceStore rules", () => {
  beforeEach(() => {
    installFakeIndexedDB();
  });
  afterEach(() => {
    uninstallFakeIndexedDB();
  });

  let store: IdbPreferenceStore | null = null;
  defineStoreSuites(
    () => {
      store = new IdbPreferenceStore();
      return store;
    },
    async (s) => {
      await s.close();
      store = null;
    },
  );
});
