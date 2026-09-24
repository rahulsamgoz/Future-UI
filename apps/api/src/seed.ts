/**
 * Dev seed data: the "reference-app" project with registered entity keys and
 * the public runtime manifest (renderer property schemas embedded so the
 * SpecValidator can check generated candidates).
 */
import type { AdapterCapabilities, RuntimeManifest } from "@ui-intelligence/protocol";
import type { RendererPropertySchema } from "@ui-intelligence/agent";
import { syncDigest } from "@ui-intelligence/agent";
import type { Db } from "./db.js";
import { nowIso } from "./db.js";

export const DEV_TENANT = "local";
export const REFERENCE_PROJECT_ID = "proj_reference_app";
export const REFERENCE_PROJECT_NAME = "reference-app";

/** Six declared scenarios across the two reference routes (spec section 16). */
export const DECLARED_SCENARIOS = [
  "catalog-desktop-signed-in",
  "catalog-mobile-guest",
  "catalog-desktop-empty",
  "catalog-desktop-error",
  "account-desktop-signed-in",
  "account-mobile-signed-in",
];

const density: RendererPropertySchema = {
  type: "enum",
  values: ["comfortable", "compact"],
  default: "comfortable",
};

/**
 * Renderer property schemas. These MUST mirror the renderers the reference
 * app actually registers (packages/renderers + apps/reference-app/src/renderers);
 * server-side proposal validation is only as trustworthy as this alignment.
 */
export const RENDERER_SCHEMAS: Record<string, Record<string, RendererPropertySchema>> = {
  // packages/renderers product presentations
  "carousel@1": { perView: { type: "number", min: 1, max: 4, default: 3 }, density },
  "grid@1": { columns: { type: "number", min: 1, max: 4, default: 3 }, density },
  "table@1": { density, showPrice: { type: "boolean", default: true }, zebra: { type: "boolean", default: true } },
  // packages/renderers buttons
  "button.default@1": { label: { type: "string", default: "" }, variant: { type: "enum", values: ["default", "compact"], default: "default" } },
  "button.compact@1": { label: { type: "string", default: "" }, variant: { type: "enum", values: ["default", "compact"], default: "compact" } },
  // app-owned presentations (apps/reference-app/src/renderers/registry.ts)
  "sort.select@1": { align: { type: "enum", values: ["left", "right"], default: "left" } },
  "sort.segments@1": { align: { type: "enum", values: ["left", "right"], default: "left" } },
  "form.standard@1": { showBio: { type: "boolean", default: true } },
  "form.compact@1": { showBio: { type: "boolean", default: false } },
  "panel.standard@1": { emphasis: { type: "enum", values: ["normal", "high"], default: "normal" } },
  "list.virtual@1": { rowHeight: { type: "number", min: 32, max: 96, default: 48 } },
};

type ManifestEntity = RuntimeManifest["entities"][number];

const ENTITIES: Array<ManifestEntity & { id: string }> = [
  {
    id: "ent_catalog_product_chooser",
    entityKey: "catalog.productChooser",
    contractVersion: 1,
    allowedRepresentations: ["carousel@1", "grid@1", "table@1"],
    dataBinding: "catalog.products@1",
    actions: ["product.open@1", "cart.add@1"],
  },
  {
    id: "ent_catalog_sort_control",
    entityKey: "catalog.sortControl",
    contractVersion: 1,
    allowedRepresentations: ["sort.select@1", "sort.segments@1"],
    dataBinding: "catalog.sortState@1",
    actions: ["catalog.sort@1"],
  },
  {
    id: "ent_account_profile_form",
    entityKey: "account.profileForm",
    contractVersion: 1,
    allowedRepresentations: ["form.standard@1", "form.compact@1"],
    dataBinding: "account.profile@1",
    actions: ["account.saveProfile@1"],
  },
];

const ADAPTER_CAPABILITIES: AdapterCapabilities = {
  observation: true,
  sourceLinking: true,
  tokenOverrides: true,
  representationReplacement: true,
  composition: true,
  stateTransfer: true,
  historicalExecution: false,
};

export function buildReferenceRuntimeManifest(): RuntimeManifest & {
  rendererSchemas: Record<string, Record<string, RendererPropertySchema>>;
} {
  const manifest: RuntimeManifest = {
    protocolVersion: 1,
    rendererVersions: Object.fromEntries(Object.keys(RENDERER_SCHEMAS).map((id) => [id, 1])),
    adapterCapabilities: ADAPTER_CAPABILITIES,
    entities: ENTITIES.map(({ id, ...e }) => ({ ...e, contractVersion: e.contractVersion })),
    pages: [
      { pageKey: "catalog", contractVersion: 1, slots: ["catalog.products", "catalog.sort"] },
      { pageKey: "account", contractVersion: 1, slots: ["account.profile"] },
    ],
    buildId: "build_reference_dev_1",
    contractDigest: "",
  };
  manifest.contractDigest = syncDigest(manifest.entities);
  return { ...manifest, rendererSchemas: RENDERER_SCHEMAS };
}

/** Idempotent dev seed. */
export function seedDevData(db: Db): void {
  const existing = db.prepare("SELECT id FROM projects WHERE id = ?").get(REFERENCE_PROJECT_ID);
  if (existing) return;

  const now = nowIso();
  const insertProject = db.prepare(
    "INSERT INTO projects (id, tenant_id, name, repository, policy_revision, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  insertProject.run(
    REFERENCE_PROJECT_ID,
    DEV_TENANT,
    REFERENCE_PROJECT_NAME,
    "https://github.com/example/reference-app",
    1,
    JSON.stringify({ declaredScenarios: DECLARED_SCENARIOS }),
    now
  );

  const insertEntity = db.prepare(
    "INSERT OR IGNORE INTO ui_entities (id, project_id, entity_key, created_at) VALUES (?, ?, ?, ?)"
  );
  for (const entity of ENTITIES) {
    insertEntity.run(entity.id, REFERENCE_PROJECT_ID, entity.entityKey, now);
  }

  const manifest = buildReferenceRuntimeManifest();
  db.prepare("INSERT INTO runtime_manifests (project_id, manifest_json) VALUES (?, ?)").run(
    REFERENCE_PROJECT_ID,
    JSON.stringify(manifest)
  );
}
