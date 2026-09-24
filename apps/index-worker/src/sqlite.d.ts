/**
 * Minimal ambient declarations for better-sqlite3 (no @types package is
 * installed in the dev workspace). Only the API surface used by this app.
 */
declare module "better-sqlite3" {
  export interface RunResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  }

  export interface Transaction {
    (...args: unknown[]): unknown;
    deferred(...args: unknown[]): unknown;
  }

  export default class Database {
    constructor(path: string, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number });
    readonly open: boolean;
    inTransaction: boolean;
    exec(sql: string): this;
    prepare(sql: string): Statement;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    transaction(fn: (...args: unknown[]) => unknown): Transaction;
    close(): this;
  }
}
