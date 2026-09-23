/**
 * Approved product chooser presentations (spec section 7): carousel, grid,
 * table. Pure presentational components driven by `RendererProps`; all
 * actions flow through declared `ActionBinding`s — no arbitrary code.
 */
import { newId } from "@ui-intelligence/protocol";
import type { ActionBinding, ActionResult, DataSnapshot, EntityContract, JsonValue } from "@ui-intelligence/protocol";
import type { CSSProperties, ReactNode } from "react";
import {
  booleanProperty,
  clamp,
  enumProperty,
  formatPrice,
  numberProperty,
  parseProducts,
  type ProductView,
} from "./products.js";
import type { RendererEntry, RendererProps } from "./types.js";

/** Invoke a declared action; renderers never throw on missing bindings. */
export async function invokeAction(
  actions: Record<string, ActionBinding>,
  actionId: string,
  input: JsonValue,
  data: DataSnapshot,
  onActionComplete?: () => void,
): Promise<ActionResult | null> {
  const binding = actions[actionId];
  if (!binding) return null;
  try {
    return await binding.invoke(input, {
      invocationId: newId<string>("inv"),
      dataRevision: data.revision,
      signal: new AbortController().signal,
    });
  } catch {
    return null;
  } finally {
    onActionComplete?.();
  }
}

/**
 * Price visibility: the contract constraint always wins over renderer
 * properties (spec section 6 — a presentation may change only within the
 * constraints the app declares).
 */
export function priceVisible(contract: EntityContract, properties: Record<string, JsonValue>): boolean {
  if (contract.constraints.preservePriceVisibility === true) return true;
  return booleanProperty(properties, "showPrice", true);
}

const DENSITIES = ["comfortable", "compact"] as const;

function ProductStateShell({
  data,
  children,
}: {
  data: DataSnapshot;
  children: (products: ProductView[]) => ReactNode;
}) {
  if (data.status === "loading") {
    return (
      <div className="ui-products__status" role="status">
        Loading products…
      </div>
    );
  }
  if (data.status === "error") {
    return (
      <div className="ui-products__status ui-products__status--error" role="alert">
        Failed to load products.
      </div>
    );
  }
  const products = parseProducts(data.value);
  if (products.length === 0) {
    return (
      <div className="ui-products__status" role="status">
        No products yet.
      </div>
    );
  }
  return <>{children(products)}</>;
}

type CardProps = {
  product: ProductView;
  actions: Record<string, ActionBinding>;
  data: DataSnapshot;
  onActionComplete?: () => void;
};

function makeCardHandlers({ product, actions, data, onActionComplete }: CardProps) {
  const open = () => {
    void invokeAction(actions, "product.open@1", { productId: product.id }, data, onActionComplete);
  };
  const addToCart = () => {
    void invokeAction(actions, "cart.add@1", { productId: product.id }, data, onActionComplete);
  };
  return { open, addToCart };
}

function Price({ value }: { value: number }) {
  return <span className="ui-product-card__price">{formatPrice(value)}</span>;
}

export function CarouselRenderer({
  contract,
  data,
  actions,
  properties,
  onActionComplete,
}: RendererProps) {
  const perView = clamp(numberProperty(properties, "perView", 3), 1, 4);
  const density = enumProperty(properties, "density", DENSITIES, "comfortable");
  const showPrice = priceVisible(contract, properties);
  const cardStyle: CSSProperties = { flexBasis: `calc(${(100 / perView).toFixed(4)}% - 12px)` };
  return (
    <ProductStateShell data={data}>
      {(products) => (
        <div
          className={`ui-carousel ui-carousel--${density}`}
          style={{
            display: "flex",
            gap: "12px",
            overflowX: "auto",
            scrollSnapType: "x mandatory",
            padding: density === "compact" ? "4px 0" : "8px 0",
          }}
          role="list"
        >
          {products.map((product) => {
            const { open, addToCart } = makeCardHandlers({ product, actions, data, onActionComplete });
            return (
              <div key={product.id} role="listitem" className="ui-carousel__card" style={{ ...cardStyle, scrollSnapAlign: "start" }}>
                <button
                  type="button"
                  className="ui-product-card__open"
                  onClick={open}
                  style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", textAlign: "left", cursor: "pointer" }}
                >
                  <span aria-hidden="true" className="ui-product-card__image">
                    {product.imageEmoji ?? "📦"}
                  </span>
                  <span className="ui-product-card__name">{product.name}</span>
                  {showPrice ? <Price value={product.price} /> : null}
                </button>
                <button type="button" className="ui-product-card__cart" onClick={addToCart} style={{ cursor: "pointer" }}>
                  Add to cart
                </button>
              </div>
            );
          })}
        </div>
      )}
    </ProductStateShell>
  );
}

export function GridRenderer({
  contract,
  data,
  actions,
  properties,
  onActionComplete,
}: RendererProps) {
  const maxColumns =
    typeof contract.constraints.maximumColumns === "number" ? contract.constraints.maximumColumns : 4;
  const columns = clamp(numberProperty(properties, "columns", 3), 1, maxColumns);
  const density = enumProperty(properties, "density", DENSITIES, "comfortable");
  const showPrice = priceVisible(contract, properties);
  return (
    <ProductStateShell data={data}>
      {(products) => (
        <div
          className={`ui-product-grid ui-product-grid--${density}`}
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: density === "compact" ? "8px" : "16px",
          }}
          role="list"
        >
          {products.map((product) => {
            const { open, addToCart } = makeCardHandlers({ product, actions, data, onActionComplete });
            return (
              <div key={product.id} role="listitem" className="ui-product-grid__cell" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <button
                  type="button"
                  className="ui-product-card__open"
                  onClick={open}
                  style={{ display: "flex", flexDirection: "column", gap: "4px", textAlign: "left", cursor: "pointer" }}
                >
                  <span aria-hidden="true" className="ui-product-card__image">
                    {product.imageEmoji ?? "📦"}
                  </span>
                  <span className="ui-product-card__name">{product.name}</span>
                  {showPrice ? <Price value={product.price} /> : null}
                </button>
                <button type="button" className="ui-product-card__cart" onClick={addToCart} style={{ cursor: "pointer" }}>
                  Add to cart
                </button>
              </div>
            );
          })}
        </div>
      )}
    </ProductStateShell>
  );
}

export function TableRenderer({
  contract,
  data,
  actions,
  properties,
  onActionComplete,
}: RendererProps) {
  const density = enumProperty(properties, "density", DENSITIES, "comfortable");
  const zebra = booleanProperty(properties, "zebra", true);
  const showPrice = priceVisible(contract, properties);
  return (
    <ProductStateShell data={data}>
      {(products) => (
        <table
          className={`ui-products-table ui-products-table--${density}${zebra ? " ui-products-table--zebra" : ""}`}
          style={{ borderCollapse: "collapse", width: "100%" }}
        >
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: "left", padding: "6px" }}>
                Name
              </th>
              {showPrice ? (
                <th scope="col" style={{ textAlign: "right", padding: "6px" }}>
                  Price
                </th>
              ) : null}
              <th scope="col" style={{ padding: "6px" }}>
                <span className="ui-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => {
              const { open, addToCart } = makeCardHandlers({ product, actions, data, onActionComplete });
              return (
                <tr key={product.id}>
                  <td style={{ padding: density === "compact" ? "2px 6px" : "6px 6px" }}>
                    <button type="button" className="ui-product-card__open" onClick={open} style={{ cursor: "pointer" }}>
                      <span aria-hidden="true" style={{ marginRight: "6px" }}>
                        {product.imageEmoji ?? "📦"}
                      </span>
                      <span className="ui-product-card__name">{product.name}</span>
                    </button>
                  </td>
                  {showPrice ? (
                    <td className="ui-product-card__price" style={{ textAlign: "right", padding: density === "compact" ? "2px 6px" : "6px 6px" }}>
                      {formatPrice(product.price)}
                    </td>
                  ) : null}
                  <td style={{ textAlign: "right", padding: density === "compact" ? "2px 6px" : "6px 6px" }}>
                    <button type="button" className="ui-product-card__cart" onClick={addToCart} style={{ cursor: "pointer" }}>
                      Add to cart
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </ProductStateShell>
  );
}

const PRODUCT_COMPATIBLE_BINDING = /^catalog\.products@\d+$/;

function productChooserCompatible(representationId: string) {
  return (contract: EntityContract): boolean =>
    contract.allowedRepresentations.includes(representationId) &&
    PRODUCT_COMPATIBLE_BINDING.test(contract.dataBinding);
}

const PRODUCT_PROPERTY_DENSITY = {
  type: "enum" as const,
  values: ["comfortable", "compact"],
  default: "comfortable",
};

export const productChooserRenderers: Record<string, RendererEntry> = {
  "carousel@1": {
    component: CarouselRenderer,
    descriptor: {
      id: "carousel@1",
      version: 1,
      propertySchema: {
        perView: { type: "number", min: 1, max: 4, default: 3 },
        density: PRODUCT_PROPERTY_DENSITY,
      },
      compatibleWith: productChooserCompatible("carousel@1"),
      rendersFields: ["product.id", "product.name", "product.price"],
    },
  },
  "grid@1": {
    component: GridRenderer,
    descriptor: {
      id: "grid@1",
      version: 1,
      propertySchema: {
        columns: { type: "number", min: 1, max: 4, default: 3 },
        density: PRODUCT_PROPERTY_DENSITY,
      },
      compatibleWith: productChooserCompatible("grid@1"),
      rendersFields: ["product.id", "product.name", "product.price"],
    },
  },
  "table@1": {
    component: TableRenderer,
    descriptor: {
      id: "table@1",
      version: 1,
      propertySchema: {
        density: PRODUCT_PROPERTY_DENSITY,
        showPrice: { type: "boolean", default: true },
        zebra: { type: "boolean", default: true },
      },
      compatibleWith: productChooserCompatible("table@1"),
      rendersFields: ["product.id", "product.name", "product.price"],
    },
  },
};
