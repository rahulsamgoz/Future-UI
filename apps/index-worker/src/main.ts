/**
 * Worker entrypoint: poll every 2s on the configured SQLite database with a
 * graceful SIGTERM shutdown. When GC_RETENTION_DAYS is configured, a daily
 * reference-aware GC pass also runs on the same interval (R2 stream G).
 */
import { openWorkerDb, migrateWorker } from "./db.js";
import { createWorker } from "./worker.js";
import { runScheduledGc } from "./gc.js";

export async function main(): Promise<void> {
  const dbPath = process.env.UI_INTEL_DB ?? "./data/ui-intelligence.sqlite";
  const db = openWorkerDb(dbPath);
  migrateWorker(db);
  const worker = createWorker(db, { intervalMs: 2000 });
  worker.start();
  // eslint-disable-next-line no-console
  console.log(`ui-intelligence index-worker polling ${dbPath}`);

  const gcRetentionDays = Number(process.env.GC_RETENTION_DAYS ?? "");
  let gcTimer: ReturnType<typeof setInterval> | null = null;
  if (Number.isFinite(gcRetentionDays) && gcRetentionDays > 0) {
    const log = (message: string) => console.log(message); // eslint-disable-line no-console
    log(`gc enabled: retention ${gcRetentionDays}d, checked daily`);
    // Immediate check + hourly re-checks; runScheduledGc skips when the
    // last successful run (gc_runs) is younger than 24h.
    try {
      runScheduledGc(db, { retentionDays: gcRetentionDays, log });
    } catch (error) {
      log(`scheduled gc failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    gcTimer = setInterval(() => {
      try {
        runScheduledGc(db, { retentionDays: gcRetentionDays, log });
      } catch (error) {
        log(`scheduled gc failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 60 * 60 * 1000);
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`index-worker received ${signal}, shutting down`);
    worker.stop();
    if (gcTimer) clearInterval(gcTimer);
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
