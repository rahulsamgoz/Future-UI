import type { JsonValue } from "@ui-intelligence/protocol";

/**
 * The app's live view of active personal preferences. UI effects outside the
 * local preference transaction are reconciled from the confirmed revision
 * (protocol section 9): this store is only mutated after a transaction
 * finalizes, or after undo restores a confirmed previous revision.
 */
export type ActivePreference = {
  representation: string;
  properties: Record<string, JsonValue>;
  digest: string | null;
  revision: number;
};

export class ActivePreferenceStore {
  private prefs = new Map<string, ActivePreference>();
  private listeners = new Set<() => void>();
  private version = 0;

  get(scopeKey: string): ActivePreference | null {
    return this.prefs.get(scopeKey) ?? null;
  }

  set(scopeKey: string, pref: ActivePreference): void {
    this.prefs.set(scopeKey, pref);
    this.bump();
  }

  restore(scopeKey: string, pref: ActivePreference | null): void {
    if (pref) this.prefs.set(scopeKey, pref);
    else this.prefs.delete(scopeKey);
    this.bump();
  }

  /** Drop every in-memory selection (account switching, section 19). */
  clear(): void {
    this.prefs.clear();
    this.bump();
  }

  keys(): string[] {
    return [...this.prefs.keys()];
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getVersion = (): number => this.version;

  /** Force subscribers to re-read (e.g. semantic rules changed the resolution outcome). */
  touch(): void {
    this.bump();
  }

  private bump(): void {
    this.version += 1;
    this.listeners.forEach((l) => l());
  }
}
