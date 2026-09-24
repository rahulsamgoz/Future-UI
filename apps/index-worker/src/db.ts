/** Minimal local SQLite helpers (duplicated from apps/api — cross-app imports are not allowed). */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

export type WorkerDb = InstanceType<typeof Database>;

export function openWorkerDb(path: string): WorkerDb {
  const absolute = resolve(path);
  if (absolute !== ":memory:") mkdirSync(dirname(absolute), { recursive: true });
  const db = new Database(absolute);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export { migrateWorker } from "./worker.js";
