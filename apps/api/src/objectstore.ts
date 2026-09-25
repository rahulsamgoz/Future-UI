/**
 * Object storage (spec section 12, R2 stream G). Objects are keyed by their
 * sha-256 digest; ObjectStore verifies digests and delegates byte storage to
 * a pluggable StorageDriver (fs default, S3 optional).
 *
 * The driver contract is synchronous per the dev-profile reference design:
 * FsStorageDriver is genuinely synchronous; S3StorageDriver issues the real
 * SDK commands (put awaits the upload and returns its promise) while
 * get/exists are answered from a write-through cache of the current process
 * — cold keys that were never written by this process report missing. A
 * production deployment would replace the sync reads with presigned URLs or
 * an async driver API; the dev profile keeps the single sync seam.
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
 * Byte-storage seam (R2 stream G). `key` is driver-relative (e.g.
 * "ab/ab34…" under the fs root or the S3 prefix). ObjectStore owns digest
 * verification and key computation.
 */
export interface StorageDriver {
  put(key: string, bytes: Uint8Array): Promise<void> | void;
  get(key: string): Uint8Array | null;
  delete(key: string): void;
  exists(key: string): boolean;
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

  put(key: string, bytes: Uint8Array): void {
    const path = join(this.#root, key);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  }

  get(key: string): Uint8Array | null {
    try {
      return readFileSync(join(this.#root, key));
    } catch {
      return null;
    }
  }

  delete(key: string): void {
    try {
      rmSync(join(this.#root, key), { force: true });
    } catch {
      // Deleting a missing object is a no-op (idempotent delete).
    }
  }

  exists(key: string): boolean {
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

/**
 * S3 driver (AWS SDK v3). put() uploads asynchronously and returns the
 * upload promise so durable callers can await it; get/exists are answered
 * from the write-through cache (see module doc); delete issues a
 * DeleteObjectCommand and drops the cached copy.
 */
export class S3StorageDriver implements StorageDriver {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #client: S3LikeClient;
  // Write-through cache: bytes written (or successfully HEADed) by this
  // process, keyed by the full S3 key.
  readonly #cache = new Map<string, Uint8Array>();

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

  put(key: string, bytes: Uint8Array): Promise<void> {
    const fullKey = this.fullKey(key);
    this.#cache.set(fullKey, bytes);
    return this.#client.send(
      new PutObjectCommand({ Bucket: this.#bucket, Key: fullKey, Body: bytes }),
    ).then(() => undefined);
  }

  get(key: string): Uint8Array | null {
    return this.#cache.get(this.fullKey(key)) ?? null;
  }

  delete(key: string): void {
    const fullKey = this.fullKey(key);
    this.#cache.delete(fullKey);
    // Fire-and-forget: deletion is idempotent and the cache keeps the
    // synchronous contract; errors surface on the next process log.
    void this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: fullKey })).catch(() => undefined);
  }

  exists(key: string): boolean {
    return this.#cache.has(this.fullKey(key));
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
 * Digest-verified object store facade. The public API is unchanged from R1;
 * byte storage is delegated to a StorageDriver. `delete`/`exists` support
 * reference-aware garbage collection (R2 stream G).
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

  /** Store bytes under their digest; throws when the digest does not match. */
  put(digest: string, bytes: Buffer): { key: string; byteSize: number; persisted?: Promise<void> } {
    const actual = ObjectStore.sha256(bytes);
    if (actual !== digest) {
      throw new UiIntelligenceError("SCHEMA_INVALID", `artifact digest mismatch: expected ${digest}, got ${actual}`, {
        httpStatus: 422,
      });
    }
    const key = ObjectStore.keyFor(digest);
    const persisted = this.#driver.put(key, bytes);
    return { key, byteSize: bytes.byteLength, ...(persisted instanceof Promise ? { persisted } : {}) };
  }

  get(digest: string): Buffer | null {
    const bytes = this.#driver.get(ObjectStore.keyFor(digest));
    return bytes === null ? null : Buffer.from(bytes);
  }

  /** Remove object bytes (garbage collection). Idempotent. */
  delete(digest: string): void {
    this.#driver.delete(ObjectStore.keyFor(digest));
  }

  exists(digest: string): boolean {
    return this.#driver.exists(ObjectStore.keyFor(digest));
  }
}
