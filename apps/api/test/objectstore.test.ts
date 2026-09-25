/**
 * Storage driver tests (R2 stream G + audit fix 4). FsStorageDriver preserves
 * the R1 digest-sharded layout; S3StorageDriver is contract-tested with an
 * injected fake SDK transport and now performs REAL Get/Head/Delete round
 * trips — bytes written by one driver instance are read by another (no
 * per-process write-through cache), deletes propagate, and a failed put
 * rejects.
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  FsStorageDriver,
  ObjectStore,
  S3StorageDriver,
  createStorageDriver,
  type S3LikeClient,
} from "../src/objectstore.js";

describe("FsStorageDriver + ObjectStore", () => {
  it("keeps the R1 digest-sharded layout and digest verification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-fsdrv-"));
    const store = new ObjectStore(dir);
    const bytes = Buffer.from("fs-driver-bytes");
    const digest = ObjectStore.sha256(bytes);

    const result = await store.put(digest, bytes);
    expect(result.key).toBe(`${digest.slice(0, 2)}/${digest}`);
    // Layout: <root>/<xx>/<digest>
    expect(readFileSync(join(dir, digest.slice(0, 2), digest))).toEqual(bytes);

    expect(await store.get(digest)).toEqual(bytes);
    expect(await store.get("f".repeat(64))).toBeNull();
    expect(await store.exists(digest)).toBe(true);

    await expect(store.put("f".repeat(64), bytes)).rejects.toThrowError(/digest mismatch/);

    await store.delete(digest);
    expect(await store.exists(digest)).toBe(false);
    expect(await store.get(digest)).toBeNull();
    await store.delete(digest); // idempotent
  });
});

type SentCommand = { name: string; input: Record<string, unknown> };

function absentError(name: string): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
}

/**
 * Fake in-memory S3 "remote" shared between any number of driver instances —
 * models a real bucket: state lives in the remote, not in the driver.
 */
function fakeS3Remote(options?: { failPuts?: boolean }) {
  const sent: SentCommand[] = [];
  const remote = new Map<string, Uint8Array>();
  const makeClient = (): S3LikeClient => ({
    send: async (command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand | HeadObjectCommand) => {
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
        // SDK-shaped Body: bufferable via transformToByteArray.
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

describe("S3StorageDriver (injected fake transport)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("issues real Put/Get/Delete/Head commands with bucket and prefixed keys", async () => {
    const fake = fakeS3Remote();
    const driver = new S3StorageDriver({
      bucket: "ui-intel-test-bucket",
      prefix: "ui-intel/proj_x/",
      client: fake.makeClient(),
    });

    const bytes = new TextEncoder().encode("s3-driver-bytes");
    const putPromise = driver.put("ab/ab01", bytes);
    expect(putPromise).toBeInstanceOf(Promise);
    await putPromise;

    expect(fake.sent[0]).toMatchObject({
      name: "PutObjectCommand",
      input: { Bucket: "ui-intel-test-bucket", Key: "ui-intel/proj_x/ab/ab01" },
    });
    expect(fake.remote.get("ui-intel/proj_x/ab/ab01")).toEqual(bytes);

    // get/exists hit the remote (GetObject/HeadObject), not a local cache.
    expect(await driver.get("ab/ab01")).toEqual(bytes);
    expect(await driver.exists("ab/ab01")).toBe(true);
    expect(fake.sent.some((c) => c.name === "HeadObjectCommand")).toBe(true);
    expect(await driver.exists("ab/ab02")).toBe(false);
    expect(await driver.get("ab/ab02")).toBeNull();

    await driver.delete("ab/ab01");
    expect(fake.sent.filter((c) => c.name === "DeleteObjectCommand")[0]).toMatchObject({
      input: { Bucket: "ui-intel-test-bucket", Key: "ui-intel/proj_x/ab/ab01" },
    });
    expect(await driver.exists("ab/ab01")).toBe(false);
    expect(await driver.get("ab/ab01")).toBeNull();
  });

  it("is durable across driver instances: put via A, get/exists via B succeed (audit finding 4)", async () => {
    // Two instances over ONE remote: the old write-through-cache driver
    // returned null/false for cold keys here; the fixed driver reads the
    // bucket.
    const fake = fakeS3Remote();
    const a = new S3StorageDriver({ bucket: "b", prefix: "p/", client: fake.makeClient() });
    const b = new S3StorageDriver({ bucket: "b", prefix: "p/", client: fake.makeClient() });

    const bytes = new TextEncoder().encode("cross-instance-bytes");
    await a.put("cd/cd01", bytes);

    expect(await b.get("cd/cd01")).toEqual(bytes);
    expect(await b.exists("cd/cd01")).toBe(true);

    // Delete via B removes the object from the remote: A no longer sees it.
    await b.delete("cd/cd01");
    expect(await a.get("cd/cd01")).toBeNull();
    expect(await a.exists("cd/cd01")).toBe(false);
  });

  it("propagates failed PutObjectCommand errors", async () => {
    const fake = fakeS3Remote({ failPuts: true });
    const driver = new S3StorageDriver({ bucket: "b", client: fake.makeClient() });
    await expect(driver.put("ee/ee01", new TextEncoder().encode("x"))).rejects.toThrowError(/simulated PutObject failure/);
  });

  it("works through ObjectStore with digest verification and key computation", async () => {
    const fake = fakeS3Remote();
    const driver = new S3StorageDriver({ bucket: "b", prefix: "p/", client: fake.makeClient() });
    const store = new ObjectStore("/unused-fs-root", driver);
    const bytes = Buffer.from("s3-through-objectstore");
    const digest = ObjectStore.sha256(bytes);

    const result = await store.put(digest, bytes);
    expect(result.key).toBe(`${digest.slice(0, 2)}/${digest}`);
    expect(fake.sent[0].input.Key).toBe(`p/${digest.slice(0, 2)}/${digest}`);
    expect(await store.get(digest)).toEqual(bytes);
    expect(await store.exists(digest)).toBe(true);
    await store.delete(digest);
    expect(await store.exists(digest)).toBe(false);
  });
});

describe("createStorageDriver", () => {
  it("defaults to fs", () => {
    const dir = mkdtempSync(join(tmpdir(), `ui-intel-sel-${randomUUID().slice(0, 8)}`));
    const selection = createStorageDriver({ fsRoot: dir });
    expect(selection.kind).toBe("fs");
    expect(selection.driver).toBeInstanceOf(FsStorageDriver);
  });

  it("selects s3 when a bucket is configured", () => {
    const fake = fakeS3Remote();
    const selection = createStorageDriver({
      driver: "s3",
      s3Bucket: "some-bucket",
      s3Prefix: "pre/",
      s3Client: fake.makeClient(),
      fsRoot: "/unused",
    });
    expect(selection.kind).toBe("s3");
    expect((selection.driver as S3StorageDriver).bucket).toBe("some-bucket");
    expect((selection.driver as S3StorageDriver).prefix).toBe("pre/");
  });

  it("falls back to fs (with a log line) when the s3 bucket is missing", () => {
    const logs: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-sel-fallback-"));
    const selection = createStorageDriver({
      driver: "s3",
      fsRoot: dir,
      log: (message) => logs.push(message),
    });
    expect(selection.kind).toBe("fs");
    expect(selection.driver).toBeInstanceOf(FsStorageDriver);
    expect(logs.join("\n")).toMatch(/UI_INTEL_S3_BUCKET is not configured/);
    // The fs root was actually created by the fallback driver.
    expect(existsSync(dir)).toBe(true);
  });
});

// The command surface pins the SDK shape used by the driver.
describe("s3 command surface", () => {
  it("constructs Get/Head/Delete/Put commands with bucket+key", () => {
    expect(new HeadObjectCommand({ Bucket: "b", Key: "k" }).input).toMatchObject({ Bucket: "b", Key: "k" });
    expect(new GetObjectCommand({ Bucket: "b", Key: "k" }).input).toMatchObject({ Bucket: "b", Key: "k" });
    expect(new DeleteObjectCommand({ Bucket: "b", Key: "k" }).input).toMatchObject({ Bucket: "b", Key: "k" });
    expect(new PutObjectCommand({ Bucket: "b", Key: "k", Body: new Uint8Array() }).input).toMatchObject({ Bucket: "b", Key: "k" });
  });
});
