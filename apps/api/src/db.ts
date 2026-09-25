/**
 * Database open + migrate + small helpers.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { AUTH_SCHEMA_SQL } from "./authz.js";

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
  db.exec(SCHEMA_SQL)
  db.exec(AUTH_SCHEMA_SQL);
  // Graceful migration: add degraded_json to proposals if the table was created
  // before this column existed (closure-2 GAP B). SQLite has no IF NOT EXISTS
  // for ADD COLUMN, so we probe table_info and ignore the expected duplicate error.
  const hasDegraded = db.prepare("SELECT name FROM pragma_table_info('proposals') WHERE name = 'degraded_json'").get() as { name: string } | undefined;
  if (!hasDegraded) {
    try {
      db.exec("ALTER TABLE proposals ADD COLUMN degraded_json TEXT");
    } catch {
      // best effort — another process may have raced the ALTER
    }
  }
}

export function getJson<T>(row: unknown, column: string): T | null {
  const rec = row as Record<string, unknown> | undefined;
  if (!rec || rec[column] === undefined || rec[column] === null) return null;
  return JSON.parse(rec[column] as string) as T;
}
