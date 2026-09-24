/**
 * Local filesystem object store (dev profile). Objects are keyed by their
 * sha-256 digest; writes verify the digest, reads return the bytes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { UiIntelligenceError } from "@ui-intelligence/protocol";

export class ObjectStore {
  constructor(private readonly rootDir: string) {
    mkdirSync(resolve(rootDir), { recursive: true });
  }

  private pathFor(digest: string): string {
    return join(resolve(this.rootDir), digest.slice(0, 2), digest);
  }

  static sha256(bytes: Buffer | Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  /** Store bytes under their digest; throws when the digest does not match. */
  put(digest: string, bytes: Buffer): { key: string; byteSize: number } {
    const actual = ObjectStore.sha256(bytes);
    if (actual !== digest) {
      throw new UiIntelligenceError("SCHEMA_INVALID", `artifact digest mismatch: expected ${digest}, got ${actual}`, {
        httpStatus: 422,
      });
    }
    const path = this.pathFor(digest);
    mkdirSync(join(resolve(this.rootDir), digest.slice(0, 2)), { recursive: true });
    writeFileSync(path, bytes);
    return { key: path, byteSize: bytes.byteLength };
  }

  get(digest: string): Buffer | null {
    try {
      return readFileSync(this.pathFor(digest));
    } catch {
      return null;
    }
  }
}
