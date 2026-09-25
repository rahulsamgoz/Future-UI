/**
 * Object storage (spec section 12, R2 stream G). Objects are keyed by their
 * sha-256 digest; ObjectStore verifies digests and delegates byte storage to
 * a pluggable StorageDriver (fs default, S3 optional).
 *
 * The driver contract is async-first (audit fix, finding 4): every method
 * returns a Promise and the S3 driver issues REAL SDK commands for all four
 * operations — Get/Head/Delete are no longer answered from a per-process
 * write-through cache, so bytes written by one process are readable by
 * another and object durability matches the remote store. ObjectStore awaits
 * the driver end to end; callers (artifact upload/read routes, resolve
 * grounding, GC) await it in turn.
 *
 * Shared between apps/api and apps/index-worker so both services read bytes
 * through the same configured driver (closure-2 GAP A).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { UiIntelligenceError } from "@ui-intelligence/protocol";

/**
 * Byte-storage seam (R2 stream G, async contract). `key` is driver-relative
 * (e.g. "ab/ab34…" under the fs root or the S3 prefix). ObjectStore owns
 * digest verification and key computation.
 */
export interface StorageDriver {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** Filesystem driver: digest-sharded layout <root>/<xx>/<digest> (R1 layout, unchanged). */
export class FsStorageDriver implements StorageDriver {
  readonly #root: string;

  constructor(rootDir: string) {
    this.#root = resolve(rootDir);
    mkdirSync(this.#root, { recursive: true });
  }

  get root(): string {
    return this.#root;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = join(this.#root, key);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return readFileSync(join(this.#root, key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      rmSync(join(this.#root, key), { force: true });
    } catch {
      // Deleting a missing object is a no-op (idempotent delete).
    }
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(join(this.#root, key));
  }
}

/** Minimal structural type the S3 driver needs — the real S3Client satisfies it. */
export type S3LikeClient = {
  send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand | HeadObjectCommand): Promise<unknown>;
};

export type S3StorageDriverOptions = {
  bucket: string;
  /** Key prefix inside the bucket, e.g. "ui-intel/proj_x/". Empty by default. */
  prefix?: string;
  /** Injected for tests; a real S3Client is created when omitted. */
  client?: S3LikeClient;
  /** AWS region for the default client (ignored when client is injected). */
  region?: string;
};

/** True for the SDK's "key absent" errors (GetObject NoSuchKey, HeadObject NotFound, 404 status). */
function isKeyAbsent(error: unknown): boolean {
  const err = error as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    err?.name === "NoSuchKey" ||
    err?.name === "NotFound" ||
    err?.Code === "NoSuchKey" ||
    err?.Code === "NotFound" ||
    err?.code === "NoSuchKey" ||
    err?.code === "NotFound" ||
    err?.$metadata?.httpStatusCode === 404
  );
}

/** Buffer an SDK object Body (Node stream or transformToByteArray-shaped) into bytes. */
async function readBody(body: unknown): Promise<Uint8Array> {
  if (body === null || body === undefined) return new Uint8Array(0);
  const shaped = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof shaped.transformToByteArray === "function") {
    return shaped.transformToByteArray();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<unknown>) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * S3 driver (AWS SDK v3). All four operations issue the real SDK command and
 * await it: put uploads, get fetches and buffers the Body (null on NoSuchKey),
 * exists HEADs (false on NotFound), delete issues DeleteObjectCommand and
 * propagates errors. No per-process cache: state lives in the bucket.
 */
export class S3StorageDriver implements StorageDriver {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #client: S3LikeClient;

  constructor(options: S3StorageDriverOptions) {
    this.#bucket = options.bucket;
    this.#prefix = options.prefix ?? "";
    this.#client = options.client ?? new S3Client(options.region ? { region: options.region } : {});
  }

  get bucket(): string {
    return this.#bucket;
  }

  get prefix(): string {
    return this.#prefix;
  }

  /** Full S3 key for a driver-relative key (prefix + key). */
  fullKey(key: string): string {
    return `${this.#prefix}${key}`;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({ Bucket: this.#bucket, Key: this.fullKey(key), Body: bytes }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const output = (await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: this.fullKey(key) }),
      )) as { Body?: unknown };
      return await readBody(output?.Body);
    } catch (error) {
      if (isKeyAbsent(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: this.fullKey(key) }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: this.fullKey(key) }));
      return true;
    } catch (error) {
      if (isKeyAbsent(error)) return false;
      throw error;
    }
  }
}

export type StorageDriverSelection = {
  driver: StorageDriver;
  kind: "fs" | "s3";
};

/**
 * Choose the storage driver from the environment:
 * - UI_INTEL_STORAGE_DRIVER = fs (default) | s3
 * - UI_INTEL_S3_BUCKET      — required for s3; when unset/empty with the s3
 *   selection, the factory logs and FALLS BACK to fs (dev profile never
 *   fails startup over missing cloud config).
 * - UI_INTEL_S3_PREFIX      — optional S3 key prefix.
 */
export function createStorageDriver(options: {
  driver?: string;
  s3Bucket?: string;
  s3Prefix?: string;
  s3Client?: S3LikeClient;
  fsRoot: string;
  log?: (message: string) => void;
}): StorageDriverSelection {
  const log = options.log ?? (() => undefined);
  const kind = options.driver === "s3" ? "s3" : "fs";
  if (kind === "s3") {
    if (options.s3Bucket) {
      log(`object storage: s3 driver (bucket ${options.s3Bucket})`);
      return {
        driver: new S3StorageDriver({
          bucket: options.s3Bucket,
          prefix: options.s3Prefix ?? "",
          ...(options.s3Client ? { client: options.s3Client } : {}),
        }),
        kind: "s3",
      };
    }
    log("object storage: UI_INTEL_STORAGE_DRIVER=s3 but UI_INTEL_S3_BUCKET is not configured — falling back to the fs driver");
  }
  return { driver: new FsStorageDriver(options.fsRoot), kind: "fs" };
}

/**
 * Digest-verified object store facade. All operations are async end to end
 * (audit fix, finding 4): the fs driver stays genuinely synchronous inside
 * its promises; the s3 driver performs real round trips. `delete`/`exists`
 * support reference-aware garbage collection (R2 stream G).
 */
export class ObjectStore {
  readonly #driver: StorageDriver;

  constructor(rootDir: string, driver?: StorageDriver) {
    this.#driver = driver ?? new FsStorageDriver(rootDir);
  }

  static sha256(bytes: Buffer | Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  /** Driver-relative key for a digest (sharded by the first two hex chars). */
  static keyFor(digest: string): string {
    return `${digest.slice(0, 2)}/${digest}`;
  }

  /** Store bytes under their digest; rejects when the digest does not match. */
  async put(digest: string, bytes: Buffer): Promise<{ key: string; byteSize: number }> {
    const actual = ObjectStore.sha256(bytes);
    if (actual !== digest) {
      throw new UiIntelligenceError("SCHEMA_INVALID", `artifact digest mismatch: expected ${digest}, got ${actual}`, {
        httpStatus: 422,
      });
    }
    const key = ObjectStore.keyFor(digest);
    await this.#driver.put(key, bytes);
    return { key, byteSize: bytes.byteLength };
  }

  async get(digest: string): Promise<Buffer | null> {
    const bytes = await this.#driver.get(ObjectStore.keyFor(digest));
    return bytes === null ? null : Buffer.from(bytes);
  }

  /** Remove object bytes (garbage collection). Idempotent; errors propagate. */
  async delete(digest: string): Promise<void> {
    await this.#driver.delete(ObjectStore.keyFor(digest));
  }

  async exists(digest: string): Promise<boolean> {
    return this.#driver.exists(ObjectStore.keyFor(digest));
  }
}
