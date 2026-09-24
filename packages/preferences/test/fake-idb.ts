/**
 * Test-only in-memory IndexedDB shim (~subset of the API used by
 * IdbPreferenceStore). Transactions execute requests in microtasks and commit
 * on a macrotask; abort restores the transaction's snapshot, so revision
 * checks inside a transaction have real rollback semantics.
 */

type Snapshot = Map<string, Map<string, unknown>>;

function extractKey(keyPath: string | string[], value: unknown): string {
  const paths = Array.isArray(keyPath) ? keyPath : [keyPath];
  const parts = paths.map((path) =>
    path
      .split(".")
      .reduce<unknown>((acc, segment) => {
        if (acc === null || acc === undefined) return undefined;
        return (acc as Record<string, unknown>)[segment];
      }, value),
  );
  if (parts.some((p) => p === undefined)) {
    throw new Error("DataError: could not evaluate key path on value");
  }
  return JSON.stringify(parts);
}

function keyToIdentity(key: IDBValidKey | IDBValidKey[]): string {
  return JSON.stringify(Array.isArray(key) ? key : [key]);
}

export class FakeIDBRequest<T = unknown> {
  result: T;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(result: T) {
    this.result = result;
  }
  #settle(): void {
    queueMicrotask(() => {
      if (this.error) this.onerror?.();
      else this.onsuccess?.();
    });
  }
  static immediate<T>(compute: () => T, transaction: FakeIDBTransaction): FakeIDBRequest<T> {
    const request = new FakeIDBRequest<T>(undefined as T);
    queueMicrotask(() => {
      if (transaction.state !== "active") {
        request.error = new Error("TransactionInactiveError: transaction is not active");
        request.#settle();
        return;
      }
      try {
        request.result = compute();
      } catch (error) {
        request.error = error instanceof Error ? error : new Error(String(error));
      }
      request.#settle();
    });
    return request;
  }
  static failed(transaction: FakeIDBTransaction, error: Error): FakeIDBRequest<never> {
    const request = new FakeIDBRequest<never>(undefined as never);
    request.error = error;
    request.#settle();
    void transaction;
    return request;
  }
}

export class FakeIDBTransaction {
  state: "active" | "committed" | "aborted" = "active";
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  #snapshot: Snapshot;
  #db: FakeIDBDatabase;
  #commitScheduled = false;
  #objectStores = new Map<string, FakeIDBObjectStore>();

  objectStore(name: string): FakeIDBObjectStore {
    const store = this.#objectStores.get(name);
    if (!store) throw new Error(`NotFoundError: store "${name}" not part of this transaction`);
    return store;
  }

  constructor(
    db: FakeIDBDatabase,
    readonly mode: IDBTransactionMode,
    storeNames: string | string[],
  ) {
    this.#db = db;
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    for (const name of names) {
      const keyPath = db.keyPaths.get(name);
      if (!keyPath) throw new Error(`NotFoundError: store "${name}" does not exist`);
      this.#objectStores.set(name, new FakeIDBObjectStore(db, this, name, keyPath));
    }
    this.#snapshot = new Map();
    for (const [name, map] of db.stores) {
      this.#snapshot.set(name, new Map(map));
    }
    // Commit after the microtask queue drains (all awaited requests ran).
    queueMicrotask(() => {
      if (this.#commitScheduled || this.state !== "active") return;
      this.#commitScheduled = true;
      setTimeout(() => {
        if (this.state !== "active") return;
        this.state = "committed";
        this.oncomplete?.();
      }, 0);
    });
  }

  abort(): void {
    if (this.state !== "active") return;
    this.state = "aborted";
    for (const [name, snapshot] of this.#snapshot) {
      this.#db.stores.set(name, snapshot);
    }
    this.onabort?.();
  }
}

export class FakeIDBObjectStore {
  constructor(
    private readonly db: FakeIDBDatabase,
    private readonly tx: FakeIDBTransaction,
    readonly name: string,
    private readonly keyPath: string | string[],
  ) {}

  get transaction(): FakeIDBTransaction {
    return this.tx;
  }

  #store(): Map<string, unknown> {
    return this.db.stores.get(this.name)!;
  }

  get(key: IDBValidKey | IDBValidKey[]): FakeIDBRequest<unknown> {
    return FakeIDBRequest.immediate(() => this.#store().get(keyToIdentity(key)) ?? undefined, this.tx);
  }

  getAll(): FakeIDBRequest<unknown[]> {
    return FakeIDBRequest.immediate(() => [...this.#store().values()], this.tx);
  }

  put(value: unknown): FakeIDBRequest<IDBValidKey> {
    return FakeIDBRequest.immediate(() => {
      const identity = extractKey(this.keyPath, value);
      this.#store().set(identity, structuredClone(value));
      return identity;
    }, this.tx);
  }

  delete(key: IDBValidKey | IDBValidKey[]): FakeIDBRequest<undefined> {
    return FakeIDBRequest.immediate(() => {
      this.#store().delete(keyToIdentity(key));
      return undefined;
    }, this.tx);
  }
}

export class FakeIDBDatabase {
  stores = new Map<string, Map<string, unknown>>();
  keyPaths = new Map<string, string | string[]>();
  #names: string[] = [];
  closed = false;

  constructor(readonly name: string, readonly version: number) {}

  get objectStoreNames(): { contains: (name: string) => boolean } {
    const names = this.#names;
    return { contains: (n: string) => names.includes(n) };
  }

  createObjectStore(name: string, options: { keyPath: string | string[] }): void {
    this.stores.set(name, new Map());
    this.keyPaths.set(name, options.keyPath);
    this.#names.push(name);
  }

  transaction(storeNames: string | string[], mode: IDBTransactionMode): FakeIDBTransaction {
    if (this.closed) throw new Error("InvalidStateError: database connection is closed");
    return new FakeIDBTransaction(this, mode, storeNames);
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeIDBOpenDBRequest {
  result: FakeIDBDatabase | undefined;
  error: Error | null = null;
  onupgradeneeded: ((event: { oldVersion: number; newVersion: number }) => void) | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

export class FakeIDBFactory {
  #databases = new Map<string, FakeIDBDatabase>();

  open(name: string, version = 1): FakeIDBOpenDBRequest {
    const request = new FakeIDBOpenDBRequest();
    queueMicrotask(() => {
      let db = this.#databases.get(name);
      if (!db || db.version < version) {
        const oldVersion = db?.version ?? 0;
        db = new FakeIDBDatabase(name, version);
        this.#databases.set(name, db);
        request.result = db;
        request.onupgradeneeded?.({ oldVersion, newVersion: version });
      } else {
        request.result = db;
      }
      request.onsuccess?.();
    });
    return request;
  }
}

/** Install a fresh fake factory; call before creating each store under test. */
export function installFakeIndexedDB(): void {
  (globalThis as { indexedDB?: FakeIDBFactory }).indexedDB = new FakeIDBFactory();
}

/** Remove the fake so non-IDB behavior can be tested. */
export function uninstallFakeIndexedDB(): void {
  delete (globalThis as { indexedDB?: FakeIDBFactory }).indexedDB;
}
