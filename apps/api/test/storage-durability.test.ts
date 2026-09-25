/**
 * Storage durability route tests (audit fix, finding 4).
 * - A failed PutObject rejects the upload route with 500 and leaves the slot
 *   open (the same slot succeeds on a healthy driver instance over the same
 *   DB — which also proves route-level cross-instance durability).
 * - Capture ingest refuses (422) a manifest referencing an artifact whose
 *   bytes were never uploaded (the old "pending artifact accepted before
 *   byte upload" hole), and accepts it after the bytes arrive.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb, migrate, type Db } from "../src/db.js";
import { seedDevData } from "../src/seed.js";
import { buildApp, type BuildAppOptions } from "../src/server.js";
import type { S3LikeClient } from "../src/objectstore.js";
import type { CaptureManifest } from "./helpers.js";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const PROJECT = "proj_reference_app";
const AUTH = { authorization: "Bearer dev-token" };
const JSON_HEADERS = { "content-type": "application/json", ...AUTH };

const PREV_BUCKET = process.env.UI_INTEL_S3_BUCKET;
beforeAll(() => {
  process.env.UI_INTEL_S3_BUCKET = "durability-test-bucket";
});
afterEach(() => {
  if (PREV_BUCKET === undefined) delete process.env.UI_INTEL_S3_BUCKET;
  else process.env.UI_INTEL_S3_BUCKET = PREV_BUCKET;
});

type SentCommand = { name: string; input: Record<string, unknown> };

function fakeS3Client(options?: { failPuts?: boolean }) {
  const sent: SentCommand[] = [];
  const remote = new Map<string, Uint8Array>();
  const client: S3LikeClient = {
    send: async (command: { constructor: Function; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      const input = command.input;
      sent.push({ name, input });
      if (name === "PutObjectCommand") {
        if (options?.failPuts) throw new Error("injected durable-publication failure");
        remote.set(input.Key as string, input.Body as Uint8Array);
        return {};
      }
      if (name === "GetObjectCommand") {
        const body = remote.get(input.Key as string);
        if (body === undefined) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
      if (name === "HeadObjectCommand") {
        if (!remote.has(input.Key as string)) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
        return {};
      }
      remote.delete(input.Key as string);
      return {};
    },
  };
  return { client, sent, remote };
}

async function buildOnDb(
  db: Db,
  dir: string,
  s3Client: S3LikeClient
): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const options: BuildAppOptions = {
    db,
    storeDir: join(dir, "unused-fs-root"),
    token: "dev-token",
    storageDriver: "s3",
    s3Client,
  };
  const app = await buildApp(options);
  return { app, close: () => app.close() };
}

function manifestFor(artifactId: string, digest: string, byteSize: number): CaptureManifest {
  return {
    captureId: "cap_durability_1",
    spec: {
      protocolVersion: 1,
      projectId: PROJECT,
      commitSha: "deadbeef",
      buildArtifactDigest: "bd_1",
      scenario: {
        id: "catalog-desktop-signed-in",
        recipeDigest: "rd1",
        route: "/catalog",
        fixtureDigest: "fd1",
        role: "shopper",
        featureFlagsDigest: "ff1",
        viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
        locale: "en-US",
        timeZone: "UTC",
        colorScheme: "light",
        reducedMotion: false,
      },
      environment: {
        runnerImageDigest: "ri",
        browserRevision: "br",
        fontsDigest: "fo",
        adapterVersion: "av",
        captureToolVersion: "ct",
        redactionPolicyDigest: "rp",
      },
    },
    capturedAt: "2026-01-15T10:00:00.000Z",
    gitParents: [],
    observations: [
      {
        occurrenceId: "occ_1",
        captureId: "cap_durability_1",
        explicitAnchor: "catalog.productChooser",
        visibleText: "product chooser with widgets and prices",
        bounds: [{ x: 0, y: 0, width: 600, height: 400 }],
        coordinateSpace: "document-css-pixels",
        sourceLinks: [],
        completeness: "complete-for-scenario",
        limitations: [],
      },
    ],
    artifacts: [{ artifactId, kind: "screenshot-png", digest, byteSize, mimeType: "image/png" }],
    buildOutcome: "succeeded",
    redactionMasks: [],
    scrollOffsets: { x: 0, y: 0 },
    idempotencyKey: "cap-durability-1",
  };
}

describe("durable artifact publication (audit finding 4)", () => {
  let dir: string;
  let db: Db;
  let cleanupDir: () => void;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ui-intel-durable-"));
    db = openDb(join(dir, "test.sqlite"));
    migrate(db);
    seedDevData(db);
    cleanupDir = () => {
      try {
        db.close();
      } catch {
        // already closed
      }
    };
  });

  afterAll(() => {
    cleanupDir();
  });

  it("a failed PutObject rejects the upload route (500) and leaves the slot open; a healthy instance over the same DB succeeds", async () => {
    const failing = fakeS3Client({ failPuts: true });
    const { app: failingApp } = await buildOnDb(db, dir, failing.client);
    const healthy = fakeS3Client();
    const { app: healthyApp } = await buildOnDb(db, dir, healthy.client);

    try {
      const bytes = Buffer.from("durable-publication-bytes");
      const digest = sha256(bytes);
      const slot = await failingApp.inject({
        method: "POST",
        url: `/v1/projects/${PROJECT}/artifact-uploads`,
        headers: JSON_HEADERS,
        payload: { mediaType: "application/json", byteSize: bytes.byteLength, digest },
      });
      expect(slot.statusCode).toBe(201);
      const { slotId } = JSON.parse(slot.body) as { slotId: string };

      const failed = await failingApp.inject({
        method: "PUT",
        url: `/v1/artifacts/${slotId}`,
        headers: { "content-type": "application/octet-stream", ...AUTH },
        payload: bytes,
      });
      expect(failed.statusCode).toBe(500);
      expect(JSON.parse(failed.body).error.message).toMatch(/injected durable-publication failure/);

      // The slot is still open: the artifacts row was never created and the
      // slot was never marked filled.
      expect(
        (db.prepare("SELECT status FROM upload_slots WHERE id = ?").get(slotId) as { status: string }).status
      ).toBe("open");
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE digest = ?").get(digest) as { n: number }).n
      ).toBe(0);

      // A second driver instance over the SAME remote/DB fills the slot —
      // durable publication is not per-process.
      const retry = await healthyApp.inject({
        method: "PUT",
        url: `/v1/artifacts/${slotId}`,
        headers: { "content-type": "application/octet-stream", ...AUTH },
        payload: bytes,
      });
      expect(retry.statusCode).toBe(200);
      const { artifactId } = JSON.parse(retry.body) as { artifactId: string };

      // The bytes are readable back through the healthy instance.
      const raw = await healthyApp.inject({
        method: "GET",
        url: `/v1/artifacts/${artifactId}/raw?projectId=${PROJECT}`,
        headers: AUTH,
      });
      expect(raw.statusCode).toBe(200);
      expect(raw.body).toEqual(bytes.toString());
    } finally {
      await failingApp.close();
      await healthyApp.close();
    }
  });

  it("capture ingest rejects a manifest whose artifact has no uploaded bytes (422), accepts after upload", async () => {
    const { client } = fakeS3Client();
    const { app } = await buildOnDb(db, dir, client);
    try {
      const bytes = Buffer.from("capture-byte-verification");
      const digest = sha256(bytes);
      const artifactId = `artifact_${digest.slice(0, 16)}`;
      const slot = await app.inject({
        method: "POST",
        url: `/v1/projects/${PROJECT}/artifact-uploads`,
        headers: JSON_HEADERS,
        payload: { mediaType: "image/png", byteSize: bytes.byteLength, digest, artifactId },
      });
      expect(slot.statusCode).toBe(201);

      // The slot is open — the artifact id is reserved ('pending') but the
      // bytes were never uploaded. The capture must NOT be accepted.
      const rejected = await app.inject({
        method: "POST",
        url: `/v1/projects/${PROJECT}/captures`,
        headers: { ...JSON_HEADERS, "idempotency-key": "cap-durability-1" },
        payload: manifestFor(artifactId, digest, bytes.byteLength),
      });
      expect(rejected.statusCode).toBe(422);
      expect(JSON.parse(rejected.body).error.message).toMatch(/no uploaded bytes/);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM captures WHERE id = 'cap_durability_1'").get() as { n: number }).n
      ).toBe(0);

      // Upload the bytes; the same manifest is now acceptable.
      const fill = await app.inject({
        method: "PUT",
        url: `/v1/artifacts/${(JSON.parse(slot.body) as { slotId: string }).slotId}`,
        headers: { "content-type": "application/octet-stream", ...AUTH },
        payload: bytes,
      });
      expect(fill.statusCode).toBe(200);

      const accepted = await app.inject({
        method: "POST",
        url: `/v1/projects/${PROJECT}/captures`,
        headers: { ...JSON_HEADERS, "idempotency-key": "cap-durability-1" },
        payload: manifestFor(artifactId, digest, bytes.byteLength),
      });
      expect(accepted.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});
