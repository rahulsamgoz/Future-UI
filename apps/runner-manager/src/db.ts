/**
 * Database open + migrate + small helpers. Mirrors apps/api/src/db.ts; the
 * lease/claim SQL below is deliberately duplicated (no cross-app imports).
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { RUNNER_SCHEMA_SQL } from "./schema.js";

export type Db = InstanceType<typeof Database>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function openDb(path: string): Db {
  const absolute = resolve(path);
  if (absolute !== ":memory:") mkdirSync(dirname(absolute), { recursive: true });
  const db = new Database(absolute);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function migrate(db: Db): void {
  db.exec(RUNNER_SCHEMA_SQL);
}
