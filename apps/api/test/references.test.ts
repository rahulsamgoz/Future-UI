import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ProviderInput } from "@ui-intelligence/agent";
import { processProposal } from "../src/processor.js";
import { dbReferenceLoader } from "../src/references.js";
import { ObjectStore } from "../src/objectstore.js";
import { buildTestApp } from "./helpers.js";

const PROJECT = "proj_reference_app";

/**
 * API wiring for grounded references (audit fix): processProposal resolves
 * history references to the stored observation content (captures/occurrences/
 * artifacts are the API's data) before the provider is called.
 */
describe("proposal processor reference grounding", () => {
  const dir = mkdtempSync(join("/tmp", "ui-intel-refs-"));
  const appRef = buildTestApp(dir);
  let cleanup: () => void;

  afterAll(() => {
    cleanup?.();
  });

  it("dbReferenceLoader resolves a history reference to real observation text + screenshot artifact", async () => {
    const { app, cleanup: done } = await appRef;
    cleanup = done;
    const db = app.db;
    const now = new Date().toISOString();
    db.prepare(
      "INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES ('build_ref1', ?, 'feed1234', 'ad', 'succeeded', ?)"
    ).run(PROJECT, now);
    db.prepare(
      "INSERT INTO captures (id, project_id, build_id, scenario_id, commit_sha, evidence_label, manifest_json, manifest_digest, request_key, created_at) VALUES ('cap_ref1', ?, 'build_ref1', 'catalog-desktop', 'feed1234', 'captured_at_build', ?, 'md', 'rk_ref1', ?)"
    ).run(
      PROJECT,
      JSON.stringify({ artifacts: [{ artifactId: "art_shot_ref1", kind: "screenshot-png", digest: "dg", byteSize: 5, mimeType: "image/png" }] }),
      now
    );
    db.prepare(
      "INSERT INTO occurrences (id, project_id, capture_id, anchor, visible_text, bounds_json, completeness, created_at) VALUES ('occ_ref1', ?, 'cap_ref1', 'catalog.productChooser.grid', 'Grid of 24 products with prices', '[]', 'complete-for-scenario', ?)"
    ).run(PROJECT, now);

    const load = dbReferenceLoader(db, PROJECT);
    const grounded = await load({ kind: "history", captureId: "cap_ref1" });
    expect(grounded).not.toBeNull();
    expect(grounded!.summary).toContain("captured_at_build");
    expect(grounded!.summary).toContain("feed1234");
    expect(grounded!.summary).toContain("catalog.productChooser.grid");
    expect(grounded!.summary).toContain("Grid of 24 products with prices");
    expect(grounded!.text).toBe("Grid of 24 products with prices");
    expect(grounded!.artifactId).toBe("art_shot_ref1");

    // Unresolvable references stay null (orchestrator falls back to placeholder).
    expect(await load({ kind: "history", captureId: "cap_nope" })).toBeNull();
  });

  it("returns bytes through the configured store and emits no auth-gated URL (closure-2 GAP A)", async () => {
    const { app, cleanup: done } = await appRef;
    cleanup = done;
    const db = app.db;
    const store = new ObjectStore(join(dir, "artifacts"));

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
    const digest = createHash("sha256").update(png).digest("hex");
    await store.put(digest, Buffer.from(png));
    db.prepare(
      "INSERT INTO artifacts (id, project_id, kind, digest, mime_type, byte_size, visibility, retention, created_at) VALUES ('art_img_1', ?, 'image', ?, 'image/png', ?, 'project', 'standard', ?)"
    ).run(PROJECT, digest, png.byteLength, new Date().toISOString());

    const load = dbReferenceLoader(db, PROJECT, { store });

    // Image reference: BYTES first; no auth-gated URL emitted.
    const grounded = await load({ kind: "image", artifactId: "art_img_1" });
    expect(grounded).not.toBeNull();
    expect(grounded!.artifactId).toBe("art_img_1");
    expect(Array.from(grounded!.imageBytes!)).toEqual(Array.from(png));
    expect(grounded!.imageMediaType).toBe("image/png");
    expect(grounded!.imageUrl).toBeUndefined();

    // Without an injected store, bytes are absent and no URL is emitted.
    const noStore = dbReferenceLoader(db, PROJECT);
    const groundedNoStore = await noStore({ kind: "image", artifactId: "art_img_1" });
    expect(groundedNoStore!.imageBytes).toBeUndefined();
    expect(groundedNoStore!.imageUrl).toBeUndefined();
  });

  it("attaches the screenshot artifact bytes through the store and emits no auth-gated URL (closure-2 GAP A)", async () => {
    const { app } = await appRef;
    const db = app.db;
    const now = new Date().toISOString();

    const png = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const digest = createHash("sha256").update(png).digest("hex");
    await new ObjectStore(join(dir, "artifacts")).put(digest, Buffer.from(png));
    db.prepare(
      "INSERT INTO artifacts (id, project_id, kind, digest, mime_type, byte_size, visibility, retention, created_at) VALUES ('art_shot_9', ?, 'screenshot', ?, 'image/png', ?, 'project', 'standard', ?)"
    ).run(PROJECT, digest, png.byteLength, now);

    db.prepare(
      "INSERT OR IGNORE INTO builds (id, project_id, commit_sha, artifact_digest, outcome, created_at) VALUES ('build_ref9', ?, 'cafe5678', 'ad', 'succeeded', ?)"
    ).run(PROJECT, now);
    db.prepare(
      "INSERT INTO captures (id, project_id, build_id, scenario_id, commit_sha, evidence_label, manifest_json, manifest_digest, request_key, created_at) VALUES ('cap_ref9', ?, 'build_ref9', 'catalog-desktop', 'cafe5678', 'captured_at_build', ?, 'md', 'rk_ref9', ?)"
    ).run(
      PROJECT,
      JSON.stringify({ artifacts: [{ artifactId: "art_shot_9", kind: "screenshot-png", digest, byteSize: png.byteLength, mimeType: "image/png" }] }),
      now
    );

    const load = dbReferenceLoader(db, PROJECT, { store: new ObjectStore(join(dir, "artifacts")) });
    const grounded = await load({ kind: "history", captureId: "cap_ref9" });
    expect(grounded!.artifactId).toBe("art_shot_9");
    expect(Array.from(grounded!.imageBytes!)).toEqual(Array.from(png));
    // Auth-gated URL is no longer emitted — external providers fetch without
    // credentials and receive 401, so the URL is unusable.
    expect(grounded!.imageUrl).toBeUndefined();
  });


  it("processProposal hands the grounded reference content to the provider", async () => {
    const { app } = await appRef;
    const db = app.db;
    const now = new Date().toISOString();

    const manifestRow = db.prepare("SELECT manifest_json FROM runtime_manifests LIMIT 1").get() as { manifest_json: string };
    const manifest = JSON.parse(manifestRow.manifest_json) as {
      rendererSchemas: Record<string, Record<string, unknown>>;
    };
    const entity = db
      .prepare("SELECT id, entity_key FROM ui_entities WHERE entity_key = 'catalog.productChooser'")
      .get() as { id: string; entity_key: string };
    const actions = ["product.open@1", "cart.add@1"];

    const target = {
      entityId: entity.id,
      entityKey: entity.entity_key,
      entityVersionId: "entver_ref1",
      currentReadSet: {
        appBuildId: "build_dev",
        contractDigest: "contract_digest_current",
        policyVersion: 1,
        preferenceRevision: 0,
        entityVersions: { [entity.id]: "entver_ref1" },
      },
      contract: {
        entityKey: entity.entity_key,
        allowedRepresentations: Object.keys(manifest.rendererSchemas),
        dataBinding: "catalog.products@1",
        actions,
      },
      rendererSchemas: Object.entries(manifest.rendererSchemas).map(([id, propertySchema]) => ({ id, propertySchema })),
    };
    const request = {
      requestId: "req_ref1",
      operation: "propose_change",
      target: { kind: "selection", entityId: entity.id, runtimeInstanceId: "rt_ref1" },
      references: [{ kind: "history", captureId: "cap_ref1" }],
      instruction: "match the captured grid",
      appBuildId: "build_dev",
      requestedCandidateCount: 2,
    };
    db.prepare(
      "INSERT INTO proposals (id, project_id, request_json, target_json, status, created_at, updated_at) VALUES ('prop_ref1', ?, ?, ?, 'queued', ?, ?)"
    ).run(PROJECT, JSON.stringify(request), JSON.stringify(target), now, now);

    const seen: ProviderInput[] = [];
    await processProposal(db, PROJECT, "prop_ref1", {
      provider: {
        id: "recording",
        async generate(input: ProviderInput) {
          seen.push(input);
          const type = input.targetContract.allowedRepresentations[0]!;
          const schema = input.rendererSchemas.find((s) => s.id === type)!;
          const properties: Record<string, unknown> = {};
          for (const [key, prop] of Object.entries(schema.propertySchema)) {
            properties[key] = prop.default;
          }
          return { candidates: [{ type, properties, originKind: "generated", summary: "one" }] };
        },
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.references[0]!.kind).toBe("history");
    expect(seen[0]!.references[0]!.summary).toContain("Grid of 24 products with prices");
    expect(seen[0]!.references[0]!.artifactId).toBe("art_shot_ref1");

    const row = db.prepare("SELECT status FROM proposals WHERE id = 'prop_ref1'").get() as { status: string };
    expect(row.status).toBe("ready");
  });
});
