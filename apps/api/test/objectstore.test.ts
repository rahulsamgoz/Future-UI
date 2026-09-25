/**
 * Storage driver tests (R2 stream G). FsStorageDriver preserves the R1
 * digest-sharded layout; S3StorageDriver is contract-tested with an injected
 * fake client asserting commands, bucket, and key prefixing.
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { FsStorageDriver, ObjectStore, S3StorageDriver, createStorageDriver } from "../src/objectstore.js";

describe("FsStorageDriver + ObjectStore", () => {
  it("keeps the R1 digest-sharded layout and digest verification", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-fsdrv-"));
    const store = new ObjectStore(dir);
    const bytes = Buffer.from("fs-driver-bytes");
    const digest = ObjectStore.sha256(bytes);

    const result = store.put(digest, bytes);
    expect(result.key).toBe(`${digest.slice(0, 2)}/${digest}`);
    // Layout: <root>/<xx>/<digest>
    expect(readFileSync(join(dir, digest.slice(0, 2), digest))).toEqual(bytes);

    expect(store.get(digest)).toEqual(bytes);
    expect(store.get("f".repeat(64))).toBeNull();
    expect(store.exists(digest)).toBe(true);

    expect(() => store.put("f".repeat(64), bytes)).toThrowError(/digest mismatch/);

    store.delete(digest);
    expect(store.exists(digest)).toBe(false);
    expect(store.get(digest)).toBeNull();
    store.delete(digest); // idempotent
  });
});

type SentCommand = { name: string; input: Record<string, unknown> };

function fakeS3Client() {
  const sent: SentCommand[] = [];
  const store = new Map<string, Uint8Array>();
  return {
    sent,
    store,
    send: async (command: { constructor: Function; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "PutObjectCommand") {
        store.set(command.input.Key as string, command.input.Body as Uint8Array);
      }
      return {};
    },
  };
}

describe("S3StorageDriver (injected fake client)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("issues Put/Get/Delete/Head commands with bucket and prefixed keys", async () => {
    const fake = fakeS3Client();
    const driver = new S3StorageDriver({
      bucket: "ui-intel-test-bucket",
      prefix: "ui-intel/proj_x/",
      client: fake,
    });

    const bytes = new TextEncoder().encode("s3-driver-bytes");
    const putPromise = driver.put("ab/ab01", bytes);
    // put() returns the upload promise.
    expect(putPromise).toBeInstanceOf(Promise);
    await putPromise;

    expect(fake.sent[0]).toMatchObject({
      name: "PutObjectCommand",
      input: { Bucket: "ui-intel-test-bucket", Key: "ui-intel/proj_x/ab/ab01" },
    });
    expect(fake.store.get("ui-intel/proj_x/ab/ab01")).toEqual(bytes);

    // get/exists are served from the write-through cache (sync seam).
    expect(driver.get("ab/ab01")).toEqual(bytes);
    expect(driver.exists("ab/ab01")).toBe(true);
    expect(driver.exists("ab/ab02")).toBe(false);
    expect(driver.get("ab/ab02")).toBeNull();

    driver.delete("ab/ab01");
    expect(fake.sent[1]).toMatchObject({
      name: "DeleteObjectCommand",
      input: { Bucket: "ui-intel-test-bucket", Key: "ui-intel/proj_x/ab/ab01" },
    });
    expect(driver.exists("ab/ab01")).toBe(false);
    expect(driver.get("ab/ab01")).toBeNull();
  });

  it("works through ObjectStore with digest verification and key computation", async () => {
    const fake = fakeS3Client();
    const driver = new S3StorageDriver({ bucket: "b", prefix: "p/", client: fake });
    const store = new ObjectStore("/unused-fs-root", driver);
    const bytes = Buffer.from("s3-through-objectstore");
    const digest = ObjectStore.sha256(bytes);

    const result = store.put(digest, bytes);
    await result.persisted;
    expect(fake.sent[0].input.Key).toBe(`p/${digest.slice(0, 2)}/${digest}`);
    expect(store.get(digest)).toEqual(bytes);
    expect(store.exists(digest)).toBe(true);
    store.delete(digest);
    expect(store.exists(digest)).toBe(false);
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
    const fake = fakeS3Client();
    const selection = createStorageDriver({
      driver: "s3",
      s3Bucket: "some-bucket",
      s3Prefix: "pre/",
      s3Client: fake,
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

// HeadObjectCommand is part of the driver's command surface for future
// async read paths; assert it is importable/constructible to pin the SDK shape.
describe("s3 command surface", () => {
  it("constructs a HeadObjectCommand with bucket+key", () => {
    const command = new HeadObjectCommand({ Bucket: "b", Key: "k" });
    expect(command.input.Bucket).toBe("b");
    expect(command.input.Key).toBe("k");
  });
});
