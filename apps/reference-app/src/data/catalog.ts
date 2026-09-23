import type {
  ActionBinding,
  ActionResult,
  DataBinding,
  DataSnapshot,
  JsonValue,
  StateAdapter,
} from "@ui-intelligence/protocol";
import { newId } from "@ui-intelligence/protocol";

export type Product = {
  id: string;
  name: string;
  price: number;
  imageEmoji: string;
};

export const PRODUCTS: Product[] = [
  { id: "p1", name: "Aurora Lamp", price: 89, imageEmoji: "🛋️" },
  { id: "p2", name: "Drift Chair", price: 249, imageEmoji: "🪑" },
  { id: "p3", name: "Halo Mirror", price: 159, imageEmoji: "🪞" },
  { id: "p4", name: "Pebble Rug", price: 120, imageEmoji: "🧶" },
  { id: "p5", name: "Nova Shelf", price: 210, imageEmoji: "🪟" },
  { id: "p6", name: "Echo Vase", price: 45, imageEmoji: "🏺" },
];

export type FixtureKind = "default" | "empty" | "loading" | "error";

/** Capture scenarios seed app state through ?__fixture=<id> (no code execution). */
export function fixtureFromLocation(search: string): FixtureKind {
  const kind = new URLSearchParams(search).get("__fixture");
  if (kind === "empty" || kind === "loading" || kind === "error" || kind === "default") return kind;
  return "default";
}

const CATALOG_CONTRACT = { id: "catalog.products", version: 1, schemaDigest: "sha256:catalog-products-1" };

/**
 * Current-data binding for the product catalog. The renderer subscribes to
 * CURRENT data; a historical screenshot never freezes products or prices.
 * An optional live price ticker demonstrates continued subscription after a
 * representation switch (disabled in capture mode via `live=false`).
 */
export function createCatalogDataBinding(fixture: FixtureKind, live = true): DataBinding {
  let products = PRODUCTS.map((p) => ({ ...p }));
  let revision = `catalog-${fixture}-1`;
  const listeners = new Set<() => void>();
  let tick = 1;
  let timer: ReturnType<typeof setInterval> | null = null;

  const snapshot = (): DataSnapshot => ({
    revision,
    status: fixture === "loading" ? "loading" : fixture === "error" ? "error" : "ready",
    value:
      fixture === "empty"
        ? []
        : (products.map((p) => ({ ...p })) as unknown as JsonValue[]),
  });

  if (live && fixture === "default" && typeof window !== "undefined") {
    timer = setInterval(() => {
      tick += 1;
      products = products.map((p, i) => ({
        ...p,
        price: Math.max(5, Math.round(p.price + (i % 2 === 0 ? 1 : -1))),
      }));
      revision = `catalog-${fixture}-${tick}`;
      listeners.forEach((l) => l());
    }, 20_000);
  }

  return {
    contract: CATALOG_CONTRACT,
    getSnapshot: snapshot,
    subscribe(onChange: () => void): () => void {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

/** Sort state binding: current declared view state, shared by renderers. */
export function createSortStateBinding(initial: "featured" | "price-asc" | "price-desc"): {
  binding: DataBinding;
  setOrder: (order: "featured" | "price-asc" | "price-desc") => void;
} {
  let order = initial;
  let revision = "sort-1";
  const listeners = new Set<() => void>();
  return {
    binding: {
      contract: { id: "catalog.sortState", version: 1, schemaDigest: "sha256:catalog-sort-1" },
      getSnapshot: () => ({ revision, status: "ready", value: { sortOrder: order } }),
      subscribe(onChange) {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
    },
    setOrder(next) {
      order = next;
      revision = `sort-${revision.split("-").length + 1}`;
      listeners.forEach((l) => l());
    },
  };
}

/** Live business action: open a product detail drawer. */
export function createProductOpenAction(
  onOpen: (product: Product) => void
): ActionBinding {
  return {
    contract: { id: "product.open", version: 1, schemaDigest: "sha256:product-open-1" },
    async invoke(input) {
      const productId = (input as { productId?: string })?.productId;
      const product = PRODUCTS.find((p) => p.id === productId);
      if (!product) return { status: "rejected", code: "invalid_input" } satisfies ActionResult;
      onOpen(product);
      return { status: "succeeded", value: null };
    },
  };
}

/** Live business action: add to cart (host business behavior, never a preview stub). */
export function createCartAddAction(cart: { add(id: string): void }): ActionBinding {
  return {
    contract: { id: "cart.add", version: 1, schemaDigest: "sha256:cart-add-1" },
    async invoke(input, ctx) {
      const productId = (input as { productId?: string })?.productId;
      if (!productId) return { status: "rejected", code: "invalid_input" } satisfies ActionResult;
      cart.add(productId);
      return { status: "succeeded", value: { invocationId: ctx.invocationId } };
    },
  };
}

/** Declared view state adapter for the product chooser. */
export function createChooserStateAdapter(): StateAdapter {
  let selectedProductId: string | null = null;
  let scrollIndex = 0;
  return {
    version: 1,
    canSwitch: () => ({ allowed: true }),
    exportState: () => ({ selectedProductId, scrollIndex }),
    validateState: (state) => {
      const s = state as { selectedProductId?: unknown; scrollIndex?: unknown };
      return (
        (s.selectedProductId === null || typeof s.selectedProductId === "string") &&
        typeof s.scrollIndex === "number"
      );
    },
    importState(state) {
      const s = state as { selectedProductId?: string | null; scrollIndex?: number };
      selectedProductId = s.selectedProductId ?? null;
      scrollIndex = s.scrollIndex ?? 0;
    },
  };
}

/** Simple cart store used by the host app chrome. */
export type Cart = ReturnType<typeof createCart>;

export function createCart() {
  const items: string[] = [];
  const listeners = new Set<() => void>();
  return {
    add(id: string) {
      items.push(id);
      listeners.forEach((l) => l());
    },
    get count() {
      return items.length;
    },
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

export function invocationId(): string {
  return newId("inv");
}
