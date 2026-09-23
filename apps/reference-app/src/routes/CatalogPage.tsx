import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { UiBoundary } from "@ui-intelligence/react";
import type { FixtureKind, Product } from "../data/catalog.js";
import {
  createCartAddAction,
  createCatalogDataBinding,
  createChooserStateAdapter,
  createProductOpenAction,
  createSortStateBinding,
  fixtureFromLocation,
} from "../data/catalog.js";
import {
  catalogPageContract,
  productChooserContract,
  relatedProductsContract,
  sortControlContract,
} from "../contracts.js";
import { useAppServices } from "../Services.js";
import { PageComposer } from "../app/PageComposer.js";
import { useActivePreference, useActivePreferenceFor } from "../app/hooks.js";
import { appRendererMap } from "../kernel.js";

export function useFixture(): FixtureKind {
  return typeof window === "undefined" ? "default" : fixtureFromLocation(window.location.search);
}

export function CatalogPage() {
  const { cart, kernel } = useAppServices();
  const fixture = useFixture();
  const live = fixture === "default" && !new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search
  ).has("__fixture");

  const [drawerProduct, setDrawerProduct] = useState<Product | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  const sortState = useMemo(() => createSortStateBinding("featured"), []);
  const mainChooserState = useRef(createChooserStateAdapter());
  const relatedChooserState = useRef(createChooserStateAdapter());

  const dataBinding = useMemo(() => createCatalogDataBinding(fixture, live), [fixture, live]);
  const actions = useMemo(
    () => ({
      "product.open@1": createProductOpenAction((p) => setDrawerProduct(p)),
      "cart.add@1": createCartAddAction(cart),
    }),
    [cart]
  );

  const renderers = useMemo(() => appRendererMap(), [kernel]);

  const mainPref = useActivePreferenceFor("catalog.productChooser", "catalog.main");
  const relatedPref = useActivePreferenceFor("catalog.relatedProducts", "catalog.related");
  const sortPref = useActivePreference("catalog.sortControl");

  const regions: Record<string, React.ReactNode> = {
    chooser: (
      <UiBoundary
        contract={productChooserContract}
        bindings={{ data: dataBinding, actions, state: mainChooserState.current }}
        instanceKey="catalog.main"
        renderers={renderers}
        preferredRepresentation={mainPref?.representation}
        preferredProperties={mainPref?.properties}
        rendererOverride={
          <section className="chooser-fallback">
            <h2>Products</h2>
            <p>The canonical chooser is unavailable in this build.</p>
          </section>
        }
      />
    ),
    sort: (
      <UiBoundary
        contract={sortControlContract}
        bindings={{ data: sortState.binding, actions: { "catalog.sort@1": {
          contract: { id: "catalog.sort", version: 1, schemaDigest: "sha256:catalog-sort-1" },
          invoke: async (input) => {
            sortState.setOrder((input as { sortOrder: "featured" | "price-asc" | "price-desc" }).sortOrder);
            return { status: "succeeded", value: null };
          },
        } } }}
        renderers={renderers}
        preferredRepresentation={sortPref?.representation}
        preferredProperties={sortPref?.properties}
      />
    ),
    related: (
      <UiBoundary
        contract={relatedProductsContract}
        bindings={{ data: dataBinding, actions, state: relatedChooserState.current }}
        instanceKey="catalog.related"
        renderers={renderers}
        preferredRepresentation={relatedPref?.representation}
        preferredProperties={relatedPref?.properties}
      />
    ),
  };

  return (
    <main className="page catalog">
      <header className="page-header">
        <h1>Catalog</h1>
        <p className="muted">Current data and actions come from the host application.</p>
      </header>
      <PageComposer
        pageContract={catalogPageContract}
        defaultLayout={{
          kind: "layout",
          nodeId: "root",
          type: "stack@1",
          properties: { gap: "md", direction: "vertical" },
          children: [
            { kind: "region", nodeId: "r-sort", slotId: "sort", entityId: "catalog.sortControl" },
            { kind: "region", nodeId: "r-chooser", slotId: "chooser", entityId: "catalog.productChooser" },
            { kind: "region", nodeId: "r-related", slotId: "related", entityId: "catalog.relatedProducts" },
          ],
        }}
        regions={regions}
      />
      {drawerProduct && (
        <aside className="drawer" role="dialog" aria-label="Product detail" data-testid="product-drawer">
          <button className="drawer-close" onClick={() => setDrawerProduct(null)} aria-label="Close">✕</button>
          <div className="drawer-emoji">{drawerProduct.imageEmoji}</div>
          <h2>{drawerProduct.name}</h2>
          <p className="price">${drawerProduct.price}</p>
          <button
            className="btn primary"
            onClick={() => {
              cart.add(drawerProduct.id);
              setSavedToast(`Added ${drawerProduct.name} to cart`);
            }}
          >
            Add to cart
          </button>
        </aside>
      )}
      {savedToast && <div className="toast" role="status">{savedToast}</div>}
    </main>
  );
}
