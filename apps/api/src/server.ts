/**
 * Fastify service (spec section 12). buildApp(db, deps) is exported for
 * tests; the listen main runs when executed directly.
 */
import { randomUUID } from "node:crypto";
import fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import { migrate, openDb } from "./db.js";
import { registerAuthAndErrors, sendError } from "./auth.js";
import { userRoutes } from "./routes/users.js";
import { requireRole } from "./authz.js";
import { ObjectStore, createStorageDriver, type S3LikeClient } from "./objectstore.js";
import { LexicalIndexCache, ScreenshotDecodeCache } from "./resolve.js";
import { seedDevData } from "./seed.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { captureRoutes } from "./routes/captures.js";
import { entityRoutes, manifestRoutes, resolveRoutes } from "./routes/entities.js";
import { gcRoutes } from "./routes/gc.js";
import { jobRoutes } from "./routes/jobs.js";
import { projectRoutes, historyPlanRoutes, commitRoutes } from "./routes/projects.js";
import { proposalRoutes } from "./routes/proposals.js";
import { syncRoutes } from "./routes/sync.js";

export type BuildAppOptions = {
  db: Db;
  storeDir?: string;
  token?: string;
  /** Storage driver override for tests ("fs" | "s3"); env otherwise. */
  storageDriver?: string;
  /** Injected S3 client for tests (used when the s3 driver is selected). */
  s3Client?: S3LikeClient;
};

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { db } = options;
  const token = options.token ?? process.env.UI_INTEL_TOKEN ?? "dev-token";
  const fsRoot = options.storeDir ?? process.env.UI_INTEL_STORE ?? "./data/artifacts";
  // Storage driver selection (R2 stream G): fs default, s3 when configured.
  const selection = createStorageDriver({
    driver: options.storageDriver ?? process.env.UI_INTEL_STORAGE_DRIVER,
    s3Bucket: process.env.UI_INTEL_S3_BUCKET,
    s3Prefix: process.env.UI_INTEL_S3_PREFIX,
    ...(options.s3Client ? { s3Client: options.s3Client } : {}),
    fsRoot,
    log: (message) => console.log(message), // eslint-disable-line no-console
  });
  const store = new ObjectStore(fsRoot, selection.driver);

  const app = fastify({
    logger: false,
    bodyLimit: 25 * 1024 * 1024,
  });

  // Raw-byte parsers for artifact uploads.
  const rawParser = (_req: unknown, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
    done(null, body);
  };
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, rawParser);
  app.addContentTypeParser("image/png", { parseAs: "buffer" }, rawParser);

  registerAuthAndErrors(app, { token, db });

  // Canonicalize the project URL identifier: accept the stored project id or
  // the project name (e.g. "reference-app" → "proj_reference_app") so every
  // route and its foreign keys see the same id. Runs after auth.
  app.addHook("preHandler", async (request, reply) => {
    const params = request.params as { p?: string } | undefined;
    if (params?.p) {
      const row = (await db)
        .prepare("SELECT id FROM projects WHERE id = ? OR name = ?")
        .get(params.p, params.p) as { id: string } | undefined;
      if (row) params.p = row.id;

      // Role enforcement (R2 stream F): every project-scoped route requires at
      // least viewer; mutating methods require member. Management routes
      // (key/user provisioning) stay operator-only and live outside :p.
      const principal = request.principal;
      if (principal) {
        const minimum = request.method === "GET" || request.method === "OPTIONS" ? "viewer" : "member";
        const check = requireRole(principal, params.p, minimum);
        if (!check.ok) {
          sendError(reply, request.traceId, 403, "FORBIDDEN", check.reason);
          return reply as never;
        }
      }
    }
  });

  const indexCache = new LexicalIndexCache(db);
  const screenshotCache = new ScreenshotDecodeCache();

  await app.register(projectRoutes, { db });
  await app.register(historyPlanRoutes, { db });
  await app.register(commitRoutes, { db });
  await app.register(artifactRoutes, { db, store });
  await app.register(captureRoutes, { db, indexCache, store });
  await app.register(manifestRoutes, { db });
  await app.register(resolveRoutes, { db, indexCache, store, screenshotCache });
  await app.register(entityRoutes, { db });
  await app.register(proposalRoutes, { db, indexCache, store, screenshotCache });
  await app.register(jobRoutes, { db });
  await app.register(userRoutes, { db });
  await app.register(syncRoutes, { db });
  await app.register(gcRoutes, { db, store });

  app.get("/health", async () => ({ ok: true, traceId: randomUUID() }));

  return app;
}

export async function main(): Promise<void> {
  const dbPath = process.env.UI_INTEL_DB ?? "./data/ui-intelligence.sqlite";
  const port = Number(process.env.PORT ?? 8787);
  const db = openDb(dbPath);
  migrate(db);
  seedDevData(db);
  const app = await buildApp({ db });
  await app.listen({ port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`ui-intelligence api listening on http://localhost:${port} (db: ${dbPath})`);
}

const invokedDirectly =
  typeof process !== "undefined" && process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
