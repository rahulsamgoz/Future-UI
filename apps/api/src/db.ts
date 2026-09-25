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
}

export function getJson<T>(row: unknown, column: string): T | null {
  const rec = row as Record<string, unknown> | undefined;
  if (!rec || rec[column] === undefined || rec[column] === null) return null;
  return JSON.parse(rec[column] as string) as T;
}
