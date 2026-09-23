/**
 * Worker entrypoint: poll every 2s on the configured SQLite database with a
 * graceful SIGTERM shutdown.
 */
import { openWorkerDb, migrateWorker } from "./db.js";
import { createWorker } from "./worker.js";

export async function main(): Promise<void> {
  const dbPath = process.env.UI_INTEL_DB ?? "./data/ui-intelligence.sqlite";
  const db = openWorkerDb(dbPath);
  migrateWorker(db);
  const worker = createWorker(db, { intervalMs: 2000 });
  worker.start();
  // eslint-disable-next-line no-console
  console.log(`ui-intelligence index-worker polling ${dbPath}`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`index-worker received ${signal}, shutting down`);
    worker.stop();
    setTimeout(() => {
      db.close();
      process.exit(0);
    }, 100);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
