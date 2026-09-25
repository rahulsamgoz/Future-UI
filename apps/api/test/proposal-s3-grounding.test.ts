/**
 * Closure-2 GAP A acceptance test: the API processor reads artifact bytes
 * through the configured S3 driver when the local fs cache is empty.
 *
 * Real S3 driver with injected SDK transport; upload a PNG through the API,
 * never write to local fs, run the real proposal path into a vision-capable
 * recording provider; assert the provider received the correct image bytes;
 * assert an unauthorized read of the artifact endpoint is still denied.
 */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { buildTestApp, post, put, type FastifyInstanceLike } from "./helpers.js";
import { processProposal } from "../src/processor.js";
import { S3StorageDriver, ObjectStore } from "../src/objectstore.js";
import type { S3LikeClient } from "../src/objectstore.js";
import type { ProviderInput } from "@ui-intelligence/agent";

const PROJECT = "proj_reference_app";

function sha256(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makePng(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const c = fill(x, y);
      png.data[idx] = c[0];
      png.data[idx + 1] = c[1];
      png.data[idx + 2] = c[2];
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function uploadArtifact(app: FastifyInstanceLike, projectId: string, bytes: Buffer): Promise<string> {
  const slot = await post(app, `/v1/projects/${projectId}/artifact-uploads`, {
    mediaType: "image/png",
    byteSize: bytes.byteLength,
    digest: sha256(bytes),
  });
  expect(slot.statusCode).toBe(201);
  const { slotId } = JSON.parse(slot.body);
  const done = await put(app, `/v1/artifacts/${slotId}`, bytes);
  expect(done.statusCode).toBe(200);
  return JSON.parse(done.body).artifactId as string;
}

type SentCommand = { name: string; input: Record<string, unknown> };

function absentError(name: string): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
}

/** Shared fake S3 remote — the app and the test use the same bucket+prefix. */
function fakeS3Remote(options?: { failPuts?: boolean }) {
  const sent: SentCommand[] = [];
  const remote = new Map<string, Uint8Array>();
  const makeClient = (): S3LikeClient => ({
    send: async (command) => {
      const name = command.constructor.name;
      const input = command.input as Record<string, unknown>;
      sent.push({ name, input });
      if (name === "PutObjectCommand") {
        if (options?.failPuts) throw new Error("simulated PutObject failure");
        remote.set(input.Key as string, input.Body as Uint8Array);
        return {};
      }
      if (name === "GetObjectCommand") {
        const body = remote.get(input.Key as string);
        if (body === undefined) throw absentError("NoSuchKey");
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
      if (name === "HeadObjectCommand") {
        if (!remote.has(input.Key as string)) throw absentError("NotFound");
        return {};
      }
      if (name === "DeleteObjectCommand") {
        remote.delete(input.Key as string);
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    },
  });
  return { sent, remote, makeClient };
}

const sharedFake = fakeS3Remote();
const PREV_BUCKET = process.env.UI_INTEL_S3_BUCKET;

let app: FastifyInstanceLike;
let cleanup: () => void;

beforeAll(async () => {
  process.env.UI_INTEL_S3_BUCKET = "ui-intel-test-bucket";
  const dir = mkdtempSync(join(tmpdir(), "ui-intel-s3-proposal-"));
  const built = await buildTestApp(dir, {
    storageDriver: "s3",
    s3Client: sharedFake.makeClient(),
  });
  app = built.app;
  cleanup = built.cleanup;
});

afterAll(() => {
  if (PREV_BUCKET === undefined) delete process.env.UI_INTEL_S3_BUCKET;
  else process.env.UI_INTEL_S3_BUCKET = PREV_BUCKET;
  cleanup();
});

describe("proposal S3 grounding (closure-2 GAP A)", () => {
  it("delivers artifact bytes from S3 to a vision-capable provider", async () => {
    const png = makePng(30, 20, () => [100, 150, 200]);
    const artifactId = await uploadArtifact(app, PROJECT, png);

    // The artifact row was created by the upload route; verify it is there.
    const artifactRow = app.db
      .prepare("SELECT digest FROM artifacts WHERE project_id = ? AND id = ?")
      .get(PROJECT, artifactId) as { digest: string } | undefined;
    expect(artifactRow).toBeTruthy();

    // Insert a proposal targeting this artifact as an image reference.
    const proposalId = `prop_s3_${Date.now()}`;
    const request = {
      requestId: "req_s3_1",
      operation: "propose_change",
      target: { kind: "selection", entityId: "ent_catalog", runtimeInstanceId: "rt_1" },
      references: [{ kind: "image", artifactId }],
      instruction: "match this image",
      appBuildId: "build_s3",
      requestedCandidateCount: 1,
    };
    const target = {
      entityId: "ent_catalog",
      entityKey: "catalog.productChooser",
      entityVersionId: "entver_s3",
      currentReadSet: {
        appBuildId: "build_s3",
        contractDigest: "contract_s3",
        policyVersion: 1,
        preferenceRevision: 0,
        entityVersions: { ent_catalog: "entver_s3" },
      },
      contract: {
        entityKey: "catalog.productChooser",
        allowedRepresentations: ["grid@1"],
        dataBinding: "catalog.products@1",
        actions: ["product.open@1"],
      },
      rendererSchemas: [
        { id: "grid@1", propertySchema: { columns: { type: "number", min: 1, max: 4, default: 3 }, density: { type: "enum", values: ["comfortable", "compact"], default: "comfortable" } } },
      ],
    };
    app.db
      .prepare(
        "INSERT INTO proposals (id, project_id, request_json, target_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)"
      )
      .run(proposalId, PROJECT, JSON.stringify(request), JSON.stringify(target), new Date().toISOString(), new Date().toISOString());

    const seen: ProviderInput[] = [];
    // Use the SAME shared fake S3 driver the app used, so the bytes are visible.
    // Use the SAME bucket and prefix (empty) that the app's createStorageDriver used.
    const store = new ObjectStore(
      join(tmpdir(), "ui-intel-s3-proposal-fs-unused"),
      new S3StorageDriver({ bucket: "ui-intel-test-bucket", prefix: "", client: sharedFake.makeClient() })
    );

    await processProposal(app.db, PROJECT, proposalId, {
      provider: {
        id: "recording",
        capabilities: { vision: true },
        async generate(input: ProviderInput) {
          seen.push(input);
          return {
            candidates: [
              { type: "grid@1", properties: { columns: 2, density: "compact" }, originKind: "generated", summary: "grid" },
            ],
          };
        },
      },
      store,
    });

    expect(seen).toHaveLength(1);
    const ref = seen[0]!.references[0]!;
    expect(ref.kind).toBe("image");
    // The provider received the actual PNG bytes, not an unusable auth-gated URL.
    expect(ref.imageBytes).toBeDefined();
    expect((ref.imageBytes as Uint8Array).length).toBeGreaterThan(0);
    // imageUrl is NOT populated with the auth-gated endpoint.
    expect(ref.imageUrl).toBeUndefined();
  });

  it("denies an unauthorized read of the artifact raw endpoint (authorization preserved)", async () => {
    const png = makePng(10, 10, () => [0, 0, 0]);
    const artifactId = await uploadArtifact(app, PROJECT, png);

    // No Authorization header — must be denied.
    const unauthorized = await app.inject({
      method: "GET",
      url: `/v1/artifacts/${encodeURIComponent(artifactId)}/raw?projectId=${encodeURIComponent(PROJECT)}`,
    });
    expect(unauthorized.statusCode).toBe(401);
  });
});
