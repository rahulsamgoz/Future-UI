/**
 * The demo's own live data and action bindings (architecture section 6):
 * the host application owns data and actions; renderers only present them.
 * A small static catalog with a no-op subscribe is enough for a static
 * export — the shape is the protocol's, so the runtime cannot tell the
 * difference from a database-backed binding.
 */
import type {
  ActionBinding,
  ActionResult,
  DataBinding,
  JsonValue,
  StateAdapter,
} from "@ui-intelligence/protocol";

export type Product = {
  id: string;
  name: string;
  price: number;
  imageEmoji: string;
};

export const PRODUCTS: Product[] = [
  { id: "n1", name: "Nimbus Lamp", price: 75, imageEmoji: "💡" },
  { id: "n2", name: "Tide Vase", price: 39, imageEmoji: "🌊" },
  { id: "n3", name: "Slate Clock", price: 120, imageEmoji: "🕰️" },
];

const PRODUCTS_CONTRACT = { id: "catalog.products", version: 1, schemaDigest: "sha256:next-demo-products-1" };
const LABEL_CONTRACT = { id: "ui.label", version: 1, schemaDigest: "sha256:next-demo-label-1" };

/** Static, ready data binding over the demo's own product array. */
export function createProductDataBinding(): DataBinding {
  return {
    contract: PRODUCTS_CONTRACT,
    getSnapshot: () => ({
      revision: "next-demo-products-1",
      status: "ready",
      value: PRODUCTS as unknown as JsonValue,
    }),
    // The demo data never changes at runtime; a real host would push
    // revisions through this channel.
    subscribe: () => () => undefined,
  };
}

/** Live action binding: product.open opens the host's detail drawer. */
export function createProductOpenAction(onOpen: (product: Product) => void): ActionBinding {
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

/** Live action binding: ui.action surfaces an acknowledgment in the page. */
export function createButtonAction(onInvoke: (message: string) => void): ActionBinding {
  return {
    contract: { id: "ui.action", version: 1, schemaDigest: "sha256:ui-action-1" },
    async invoke(input) {
      const label = (input as { label?: string })?.label;
      onInvoke(typeof label === "string" ? label : "Button invoked");
      return { status: "succeeded", value: null };
    },
  };
}

/** Static, ready data binding for the button's label. */
export function createLabelDataBinding(label: string): DataBinding {
  return {
    contract: LABEL_CONTRACT,
    getSnapshot: () => ({ revision: "next-demo-label-1", status: "ready", value: label }),
    subscribe: () => () => undefined,
  };
}

/** Declared view state adapter for the product chooser (protocol section 6). */
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
