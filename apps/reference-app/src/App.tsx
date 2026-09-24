import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { UiRuntimeProvider } from "@ui-intelligence/react";
import { ServicesContext, type AppServices } from "./Services.js";
import { createAppKernel } from "./kernel.js";
import { PreferenceService } from "./app/PreferenceService.js";
import { LocalGenerator } from "./editor/LocalGenerator.js";
import { createCart } from "./data/catalog.js";
import { CatalogPage } from "./routes/CatalogPage.js";
import { AccountPage } from "./routes/AccountPage.js";
import { Editor } from "./editor/Editor.js";
import { allEntityContracts } from "./contracts.js";

const KNOWN_SCOPE_KEYS = [
  "catalog.productChooser",
  "catalog.productChooser#catalog.main",
  "catalog.relatedProducts",
  "catalog.relatedProducts#catalog.related",
  "catalog.sortControl",
  "account.profileForm",
  "account.adminPanel",
  "account.transactionList",
  "ui.primaryButton",
  "ui.primaryButton#account.exportButton",
  "page:catalog",
  "page:account",
];

function useHashRoute(): string {
  const [hash, setHash] = useState(() => (typeof window === "undefined" ? "#/" : window.location.hash || "#/"));
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function App() {
  const [services, setServices] = useState<AppServices | null>(null);
  const hash = useHashRoute();

  const cart = useMemo(() => createCart(), []);
  // Re-render the chrome when the cart changes (the badge shows current count).
  useSyncExternalStore(
    cart.subscribe,
    () => cart.count
  );

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const kernel = createAppKernel();
      // Register entities with the kernel (idempotent by entityKey).
      for (const contract of allEntityContracts) {
        kernel.registerEntity(contract, { data: nullBinding, actions: {} });
      }
      const preferences = new PreferenceService();
      const contractVersions = new Map(allEntityContracts.map((c) => [c.entityKey, c.contractVersion] as const));
      contractVersions.set("page:catalog", 1);
      contractVersions.set("page:account", 1);
      await preferences.init(KNOWN_SCOPE_KEYS, contractVersions);
      const generator = new LocalGenerator(kernel);
      if (!cancelled) {
        setServices({
          kernel,
          preferences,
          generator,
          cart,
          apiBaseUrl: (import.meta.env.VITE_API_BASE as string | undefined) ?? null,
        });
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [cart]);

  if (!services) {
    return <div className="boot">Loading…</div>;
  }

  const route = hash.replace(/^#\/?/, "");
  return (
    <ServicesContext.Provider value={services}>
      <UiRuntimeProvider kernel={services.kernel}>
        <div className="app-shell">
          {/* Independent reset control outside replaceable regions (protocol section 8). */}
          <header className="topbar">
            <nav className="tabs-nav" aria-label="Routes">
              <a href="#/" className={route === "" || route === "catalog" ? "active" : ""}>Catalog</a>
              <a href="#/account" className={route.startsWith("account") ? "active" : ""}>Account</a>
            </nav>
            <div className="topbar-right">
              <span className="cart-badge" data-testid="cart-count" aria-label="Cart item count">🛒 {services.cart.count}</span>
              <button
                className="btn small"
                data-testid="reset-all"
                onClick={() => void services.preferences.resetAll(KNOWN_SCOPE_KEYS)}
              >
                Reset UI
              </button>
            </div>
          </header>
          {route.startsWith("account") ? <AccountPage /> : <CatalogPage />}
          <Editor />
        </div>
      </UiRuntimeProvider>
    </ServicesContext.Provider>
  );
}

/** Placeholder binding used only for kernel registration; pages supply real ones. */
const nullBinding = {
  contract: { id: "placeholder", version: 1, schemaDigest: "sha256:placeholder" },
  getSnapshot: () => ({ revision: "none", status: "loading" as const, value: null }),
  subscribe: () => () => {},
};
