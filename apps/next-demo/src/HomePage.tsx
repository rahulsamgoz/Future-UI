"use client";

/**
 * The Next.js demo's single route "/" (R2 stream A).
 *
 * The App Router SSRs client components during static export, but the kernel
 * and its registries are browser runtime state, so they are created with
 * useMemo inside this "use client" page — the same pattern the Vite reference
 * app uses. The `<UiBoundary>` host nodes carry `data-ui-entity` attributes,
 * so capture works against the static export unchanged.
 */
import { useMemo, useState } from "react";
import { UiBoundary, UiRuntimeProvider } from "@ui-intelligence/react";
import {
  createButtonAction,
  createChooserStateAdapter,
  createLabelDataBinding,
  createProductDataBinding,
  createProductOpenAction,
  type Product,
} from "./data";
import { buttonContract, productChooserContract } from "./contracts";
import { createDemoKernel, demoRendererMap } from "./kernel";

export function HomePage() {
  const kernel = useMemo(createDemoKernel, []);
  const renderers = useMemo(demoRendererMap, []);
  const dataBinding = useMemo(createProductDataBinding, []);
  const chooserState = useMemo(createChooserStateAdapter, []);

  // Real action bindings: product.open opens the host-owned details drawer;
  // ui.action surfaces an acknowledgment in the page chrome.
  const [drawerProduct, setDrawerProduct] = useState<Product | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invocations, setInvocations] = useState(0);
  const chooserActions = useMemo(
    () => ({ "product.open@1": createProductOpenAction((p) => setDrawerProduct(p)) }),
    [],
  );
  const labelBinding = useMemo(() => createLabelDataBinding("Toggle highlights"), []);
  const buttonActions = useMemo(
    () => ({
      "ui.action@1": createButtonAction(() => {
        setInvocations((n) => n + 1);
        setNotice("Highlights toggled");
      }),
    }),
    [],
  );

  return (
    <UiRuntimeProvider kernel={kernel}>
      <main className="page">
        <header className="page-header">
          <h1>Next.js demo</h1>
          <p className="muted">
            The same protocol contracts, runtime kernel, and approved renderers as the Vite
            reference app — proving the protocol is framework-neutral.
          </p>
        </header>
        <UiBoundary
          contract={productChooserContract}
          bindings={{ data: dataBinding, actions: chooserActions, state: chooserState }}
          instanceKey="catalog.main"
          renderers={renderers}
          rendererOverride={
            <section className="chooser-fallback">
              <h2>Products</h2>
              <p>The canonical chooser is unavailable in this build.</p>
            </section>
          }
        />
        <section className="actions-row">
          <UiBoundary
            contract={buttonContract}
            bindings={{ data: labelBinding, actions: buttonActions }}
            instanceKey="ui.toggle"
            renderers={renderers}
          />
          {notice && (
            <span role="status" data-testid="button-notice" data-invocations={invocations}>
              {notice}
            </span>
          )}
        </section>
        {drawerProduct && (
          <aside
            className="drawer"
            role="dialog"
            aria-label="Product detail"
            data-testid="product-drawer"
          >
            <button className="drawer-close" onClick={() => setDrawerProduct(null)} aria-label="Close">
              ✕
            </button>
            <div className="drawer-emoji">{drawerProduct.imageEmoji}</div>
            <h2>{drawerProduct.name}</h2>
            <p className="price">${drawerProduct.price}</p>
          </aside>
        )}
      </main>
    </UiRuntimeProvider>
  );
}
