import type {
  ActionBinding,
  DataBinding,
  DataSnapshot,
  JsonValue,
  StateAdapter,
} from "@ui-intelligence/protocol";
import type { FixtureKind } from "./catalog.js";

export type Profile = { name: string; email: string; bio: string };

const PROFILE: Profile = {
  name: "Riley Chen",
  email: "riley@example.com",
  bio: "Product designer. Likes calm interfaces.",
};

export type Transaction = { id: string; label: string; amount: number; date: string };

export const TRANSACTIONS: Transaction[] = Array.from({ length: 200 }, (_, i) => ({
  id: `t${(i + 1).toString().padStart(3, "0")}`,
  label: `Order #${1000 + i} — ${["Aurora Lamp", "Drift Chair", "Halo Mirror", "Pebble Rug"][i % 4]}`,
  amount: [89, 249, 159, 120][i % 4],
  date: `2026-0${(i % 8) + 1}-${((i % 27) + 1).toString().padStart(2, "0")}`,
}));

const STATS = { activeUsers: 1284, conversion: 0.034, openCarts: 42 };

export function createProfileDataBinding(fixture: FixtureKind): DataBinding {
  return {
    contract: { id: "account.profile", version: 1, schemaDigest: "sha256:account-profile-1" },
    getSnapshot: (): DataSnapshot => ({
      revision: "profile-1",
      status: fixture === "error" ? "error" : fixture === "loading" ? "loading" : "ready",
      value: { ...PROFILE } as unknown as JsonValue,
    }),
    subscribe() {
      return () => {};
    },
  };
}

export function createAdminStatsBinding(): DataBinding {
  return {
    contract: { id: "account.adminStats", version: 1, schemaDigest: "sha256:account-stats-1" },
    getSnapshot: () => ({ revision: "stats-1", status: "ready", value: { ...STATS } }),
    subscribe() {
      return () => {};
    },
  };
}

export function createTransactionsBinding(): DataBinding {
  return {
    contract: { id: "account.transactions", version: 1, schemaDigest: "sha256:account-tx-1" },
    getSnapshot: () => ({
      revision: "tx-1",
      status: "ready",
      value: TRANSACTIONS as unknown as JsonValue[],
    }),
    subscribe() {
      return () => {};
    },
  };
}

/** Label binding for the registered primary button. */
export function createLabelBinding(label: string): DataBinding {
  return {
    contract: { id: "ui.label", version: 1, schemaDigest: "sha256:ui-label-1" },
    getSnapshot: () => ({ revision: `label-${label}`, status: "ready", value: { label } }),
    subscribe() {
      return () => {};
    },
  };
}

export function createSaveProfileAction(onSave: (p: Profile) => void): ActionBinding {
  return {
    contract: { id: "account.saveProfile", version: 1, schemaDigest: "sha256:save-profile-1" },
    async invoke(input) {
      const p = input as Partial<Profile>;
      if (!p?.name || !p?.email) return { status: "rejected", code: "invalid_input" };
      onSave({ name: p.name, email: p.email, bio: p.bio ?? "" });
      return { status: "succeeded", value: null };
    },
  };
}

/** Form state adapter: declared state that survives representation switches. */
export function createFormStateAdapter(initial: Profile): StateAdapter {
  let value: Profile = { ...initial };
  let dirty = false;
  return {
    version: 1,
    canSwitch: () => ({ allowed: true }),
    exportState: () => ({ ...value, dirty } as unknown as JsonValue),
    validateState: (state) => {
      const s = state as Partial<Profile> & { dirty?: boolean };
      return typeof s?.name === "string" && typeof s?.email === "string";
    },
    importState(state) {
      const s = state as Partial<Profile> & { dirty?: boolean };
      value = { name: s.name ?? value.name, email: s.email ?? value.email, bio: s.bio ?? value.bio };
      dirty = s.dirty ?? dirty;
    },
    get current() {
      return { ...value, dirty };
    },
  } as StateAdapter & { current: Profile & { dirty: boolean } };
}

/** Virtualized list state: scroll position transfers across remounts. */
export function createListStateAdapter(): StateAdapter {
  let scrollTop = 0;
  return {
    version: 1,
    canSwitch: () => ({ allowed: true }),
    exportState: () => ({ scrollTop }),
    validateState: (s) => typeof (s as { scrollTop?: unknown }).scrollTop === "number",
    importState(s) {
      scrollTop = (s as { scrollTop: number }).scrollTop ?? 0;
    },
    get current() {
      return scrollTop;
    },
  } as StateAdapter & { current: number };
}
