/**
 * Fastify service (spec section 12). buildApp(db, deps) is exported for
 * tests; the listen main runs when executed directly.
 */
import { randomUUID } from "node:crypto";
import fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import { migrate, openDb } from "./db.js";
import { registerAuthAndErrors } from "./auth.js";
import { ObjectStore } from "./objectstore.js";
import { LexicalIndexCache } from "./resolve.js";
import { seedDevData } from "./seed.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { captureRoutes } from "./routes/captures.js";
import { entityRoutes, manifestRoutes, resolveRoutes } from "./routes/entities.js";
import { jobRoutes } from "./routes/jobs.js";
import { projectRoutes, historyPlanRoutes, commitRoutes } from "./routes/projects.js";
import { proposalRoutes } from "./routes/proposals.js";

export type BuildAppOptions = {
  db: Db;
  storeDir?: string;
  token?: string;
};

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { db } = options;
  const token = options.token ?? process.env.UI_INTEL_TOKEN ?? "dev-token";
  const store = new ObjectStore(options.storeDir ?? process.env.UI_INTEL_STORE ?? "./data/artifacts");

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

  registerAuthAndErrors(app, { token });

  const indexCache = new LexicalIndexCache(db);

  await app.register(projectRoutes, { db });
  await app.register(historyPlanRoutes, { db });
  await app.register(commitRoutes, { db });
  await app.register(artifactRoutes, { db, store });
  await app.register(captureRoutes, { db, indexCache });
  await app.register(manifestRoutes, { db });
  await app.register(resolveRoutes, { db, indexCache });
  await app.register(entityRoutes, { db });
  await app.register(proposalRoutes, { db, indexCache });
  await app.register(jobRoutes, { db });

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
