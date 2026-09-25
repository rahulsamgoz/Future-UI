import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db.js";
import { migrate, openDb } from "../src/db.js";
import { seedDevData } from "../src/seed.js";
import { buildApp, type BuildAppOptions } from "../src/server.js";

export type { CaptureManifest } from "@ui-intelligence/protocol";
export type FastifyInstanceLike = FastifyInstance & { db: Db };

export async function buildTestApp(
  dir: string,
  overrides?: Partial<BuildAppOptions>
): Promise<{ app: FastifyInstanceLike; cleanup: () => void }> {
  const db = openDb(join(dir, "test.sqlite"));
  migrate(db);
  seedDevData(db);
  const app = (await buildApp({
    db,
    storeDir: join(dir, "artifacts"),
    token: "dev-token",
    ...overrides,
  })) as FastifyInstanceLike;
  (app as unknown as { db: Db }).db = db;
  return {
    app: app as FastifyInstanceLike,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

export function post(app: FastifyInstance, url: string, body: unknown): Promise<{ statusCode: number; body: string }> {
  return app.inject({ method: "POST", url, headers: { "content-type": "application/json", authorization: "Bearer dev-token" }, payload: body ?? {} });
}

export function put(app: FastifyInstance, url: string, body: Buffer): Promise<{ statusCode: number; body: string }> {
  return app.inject({ method: "PUT", url, headers: { "content-type": "application/octet-stream", authorization: "Bearer dev-token" }, payload: body });
}

export { tmpdir };
