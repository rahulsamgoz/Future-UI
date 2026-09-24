/**
 * API-layer strictness end-to-end (spec section 19, generation row): the
 * SpecValidator that the proposal processor seeds from the stored runtime
 * manifest must fail a presentation carrying an unknown property key —
 * injected properties ("style", "onclick", ...) cannot slip through the same
 * validation the API applies to every generated candidate.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SpecValidator } from "@ui-intelligence/agent";
import type { TargetReadSet } from "@ui-intelligence/protocol";
import { buildTestApp } from "./helpers.js";

const ENTITY_ID = "ent_catalog_product_chooser";

describe("manifest-seeded SpecValidator (proposal processor wiring)", () => {
  it("fails a presentation with an unknown property key and passes the equivalent clean one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-specval-"));
    const { app, cleanup } = await buildTestApp(dir);
    try {
      // Seed the validator exactly like apps/api/src/processor.ts does:
      // property schemas come from the stored runtime manifest.
      const row = app.db.prepare("SELECT manifest_json FROM runtime_manifests LIMIT 1").get() as {
        manifest_json: string;
      };
      const manifest = JSON.parse(row.manifest_json) as {
        rendererSchemas: Record<string, Record<string, { type: string; min?: number; max?: number; values?: string[]; default?: unknown }>>;
      };
      const entityRow = app.db
        .prepare("SELECT entity_key FROM ui_entities WHERE id = ?")
        .get(ENTITY_ID) as { entity_key: string };
      expect(entityRow.entity_key).toBe("catalog.productChooser");

      const validator = new SpecValidator({
        allowedRepresentations: Object.keys(manifest.rendererSchemas),
        propertySchemas: manifest.rendererSchemas,
        dataBinding: "catalog.products@1",
        allowedActions: ["product.open@1", "cart.add@1"],
      });

      const readSet: TargetReadSet = {
        appBuildId: "build_reference_dev_1",
        contractDigest: "contract_digest_current",
        policyVersion: 1,
        preferenceRevision: 7,
        entityVersions: { [ENTITY_ID]: "entver_current" },
      };

      const envelope = (properties: Record<string, unknown>) => ({
        schemaVersion: 1,
        proposalId: "proposal_adv_1",
        target: {
          entityId: ENTITY_ID,
          entityVersionId: "entver_current",
          scope: "entity" as const,
          lockedEntityIds: [],
          batchTargets: [],
        },
        preconditions: {
          appBuildId: "build_reference_dev_1",
          contractDigest: "contract_digest_current",
          policyVersion: 1,
          preferenceRevision: 7,
        },
        presentation: {
          type: "grid@1",
          properties,
          dataBinding: "catalog.products@1",
          actions: ["product.open@1", "cart.add@1"],
        },
        origin: { kind: "generated" as const, referenceIds: [] },
      });

      // Negative control: the clean presentation passes.
      const clean = validator.validate(envelope({ columns: 3, density: "compact" }), readSet, 1);
      expect(clean.passed).toBe(true);

      // Adversarial: unknown keys carrying executable content must fail.
      const hostile = validator.validate(
        envelope({ columns: 3, density: "compact", style: "position:fixed", onclick: "alert(1)", innerHTML: "<img src=x>" }),
        readSet,
        1
      );
      expect(hostile.passed).toBe(false);
      const messages = hostile.errors.map((e) => `${e.code}:${e.message}`).join("; ");
      for (const key of ["style", "onclick", "innerHTML"]) {
        expect(messages).toContain(`unknown property "${key}"`);
      }

      // Out-of-range value on the manifest schema (grid columns max 4).
      const outOfRange = validator.validate(envelope({ columns: 999, density: "compact" }), readSet, 1);
      expect(outOfRange.passed).toBe(false);
      expect(outOfRange.errors.some((e) => e.code === "property_range")).toBe(true);
    } finally {
      await app.close();
      cleanup();
    }
  });
});
