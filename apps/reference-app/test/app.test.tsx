import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { UiRuntimeProvider } from "@ui-intelligence/react";
import { registerAllRenderers } from "@ui-intelligence/renderers";
import { RuntimeKernel } from "@ui-intelligence/runtime-core";
import { MemoryPreferenceStore } from "@ui-intelligence/preferences";
import { ServicesContext, type AppServices } from "../src/Services.js";
import { PreferenceService } from "../src/app/PreferenceService.js";
import { createAppKernel, appRendererMap } from "../src/kernel.js";
import { LocalGenerator } from "../src/editor/LocalGenerator.js";
import { createCart, PRODUCTS, createCatalogDataBinding, createProductOpenAction, createCartAddAction, createChooserStateAdapter } from "../src/data/catalog.js";
import { allEntityContracts, productChooserContract } from "../src/contracts.js";
import { App } from "../src/App.js";
import { Editor } from "../src/editor/Editor.js";

function buildServices(): AppServices {
  const kernel = createAppKernel();
  for (const contract of allEntityContracts) {
    kernel.registerEntity(contract, { data: placeholderBinding, actions: {} });
  }
  const preferences = new PreferenceService();
  (preferences as unknown as { store: unknown }).store = new MemoryPreferenceStore();
  const generator = new LocalGenerator(kernel);
  return { kernel, preferences, generator, cart: createCart(), apiBaseUrl: null };
}

const placeholderBinding = {
  contract: { id: "placeholder", version: 1, schemaDigest: "sha256:placeholder" },
  getSnapshot: () => ({ revision: "none", status: "loading" as const, value: null }),
  subscribe: () => () => {},
};

function withServices(ui: React.ReactNode, services: AppServices) {
  return (
    <ServicesContext.Provider value={services}>
      <UiRuntimeProvider kernel={services.kernel}>{ui}</UiRuntimeProvider>
    </ServicesContext.Provider>
  );
}

beforeEach(() => {
  cleanup();
  window.location.hash = "#/";
});

describe("reference app catalog route", () => {
  it("renders the product chooser with current data", async () => {
    const services = buildServices();
    await services.preferences.init([], new Map());
    render(withServices(<App />, services));
    await waitFor(() => {
      expect(screen.getAllByText("Aurora Lamp").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Echo Vase").length).toBeGreaterThan(0);
  });

  it("opens the product drawer through the live action binding", async () => {
    const services = buildServices();
    await services.preferences.init([], new Map());
    const user = userEvent.setup();
    render(withServices(<App />, services));
    const openButtons = await screen.findAllByRole("button", { name: /Aurora Lamp/i });
    await user.click(openButtons[0]);
    await waitFor(() => {
      expect(screen.getByTestId("product-drawer")).toBeTruthy();
    });
  });

  it("adds to cart through the live action binding and updates the chrome", async () => {
    const services = buildServices();
    await services.preferences.init([], new Map());
    const user = userEvent.setup();
    render(withServices(<App />, services));
    const addButtons = await screen.findAllByRole("button", { name: /add to cart/i });
    await user.click(addButtons[0]);
    await waitFor(() => {
      expect(screen.getByTestId("cart-count").textContent).toContain("1");
    });
  });

  it("renders empty state for the empty fixture", async () => {
    const services = buildServices();
    await services.preferences.init([], new Map());
    // Patch the fixture before render.
    window.history.replaceState(null, "", "/?__fixture=empty");
    render(withServices(<App />, services));
    await waitFor(() => {
      expect(screen.getAllByText(/no products/i).length).toBeGreaterThan(0);
    });
    window.history.replaceState(null, "", "/");
  });

  it("renders the account route with the locked admin region", async () => {
    const services = buildServices();
    await services.preferences.init([], new Map());
    window.location.hash = "#/account";
    render(withServices(<App />, services));
    await waitFor(() => {
      expect(screen.getByTestId("admin-panel")).toBeTruthy();
    });
    expect(document.querySelector('[data-locked="true"]')).toBeTruthy();
    // Virtualized list renders a bounded window, not all 200 rows.
    expect(screen.getByTestId("transaction-list")).toBeTruthy();
    const rows = document.querySelectorAll(".tx-row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(50);
  });
});

describe("editor personalization journey (carousel → grid)", () => {
  it("selects a region, generates candidates, accepts a grid, and undoes", async () => {
    const services = buildServices();
    await services.preferences.init(["catalog.productChooser"], new Map([["catalog.productChooser", 1]]));
    const user = userEvent.setup();
    render(withServices(<App />, services));

    const editorOpen = await screen.findByTestId("editor-open", undefined, { timeout: 4000 });
    await user.click(editorOpen);
    await user.click(screen.getByTestId("select-mode"));
    // Click a product card: the composed path resolves to the chooser boundary.
    await user.click((await screen.findAllByText("Aurora Lamp"))[0]);
    // Selection resolved: the editor switched to the candidates tab.
    await waitFor(() => {
      expect(screen.getByTestId("generate")).toBeTruthy();
    });

    await user.click(screen.getByTestId("generate"));
    await waitFor(() => {
      expect(screen.getAllByTestId("candidate").length).toBeGreaterThan(0);
    });

    // Accept the grid candidate.
    const gridCandidate = screen
      .getAllByTestId("candidate")
      .find((c) => c.textContent?.includes("grid@1"));
    expect(gridCandidate).toBeTruthy();
    const accept = gridCandidate!.querySelector<HTMLButtonElement>('[data-testid="accept"]');
    await user.click(accept!);

    await waitFor(() => {
      expect(screen.getByTestId("editor-status").textContent).toContain("Applied grid@1");
    });
    // Grid renderer is now live.
    await waitFor(() => {
      expect(document.querySelector(".ui-product-grid")).toBeTruthy();
    });

    // Undo restores the previous confirmed revision.
    await user.click(screen.getByTestId("undo"));
    await waitFor(() => {
      expect(screen.getByTestId("editor-status").textContent).toContain("Undone");
    });
    await waitFor(() => {
      expect(document.querySelector(".ui-product-grid")).toBeNull();
    });
  });

  it("previews with stub actions only: preview clicks do not touch live cart", async () => {
    const services = buildServices();
    await services.preferences.init([], new Map());
    const user = userEvent.setup();
    render(withServices(<App />, services));

    const editorOpen = await screen.findByTestId("editor-open", undefined, { timeout: 4000 });
    await user.click(editorOpen);
    await user.click(screen.getByTestId("select-mode"));
    await user.click((await screen.findAllByText("Aurora Lamp"))[0]);
    await user.click(screen.getByTestId("generate"));
    await waitFor(() => expect(screen.getAllByTestId("candidate").length).toBeGreaterThan(0));

    const previewButton = screen
      .getAllByTestId("candidate")[0]
      .querySelector<HTMLButtonElement>("button:not([data-testid='accept'])");
    await user.click(previewButton!);
    await waitFor(() => expect(screen.getByTestId("preview-overlay")).toBeTruthy());

    const before = services.cart.count;
    // Interact inside the preview stage.
    const stage = screen.getByTestId("preview-stage");
    const stageButton = stage.querySelector("button");
    if (stageButton) await user.click(stageButton);
    await user.click(screen.getByTestId("preview-accept"));
    await waitFor(() => expect(screen.queryByTestId("preview-overlay")).toBeNull());
    expect(services.cart.count).toBe(before); // no live mutation from preview
  });
});

describe("release compatibility", () => {
  it("suspends an incompatible stored preference as a recoverable draft", async () => {
    const services = buildServices();
    const store = new MemoryPreferenceStore();
    (services.preferences as unknown as { store: unknown }).store = store;
    // Store a preference recorded against contractVersion 2 (incompatible).
    await store.putSpecification({
      digest: "digest-old-v2",
      proposal: { schemaVersion: 1, entityKey: "catalog.productChooser", contractVersion: 2, presentation: { type: "grid@1", properties: { columns: 2 } } },
      requiredRendererVersions: { "grid@1": 1 },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.setPreference({
      key: { profileId: services.preferences.profileId, projectId: "reference-app", scope: "entity", scopeKey: "catalog.productChooser" },
      activeSpecificationDigest: "digest-old-v2",
      revision: 3,
      contractVersion: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await services.preferences.init(["catalog.productChooser"], new Map([["catalog.productChooser", 1]]));

    expect(services.preferences.drafts.has("catalog.productChooser")).toBe(true);
    expect(services.preferences.drafts.get("catalog.productChooser")!.reason).toContain("contract changed");
    // The default (canonical) interface renders.
    expect(services.preferences.active.get("catalog.productChooser")).toBeNull();
    // The stored preference is retained, not deleted.
    const pref = await store.getPreference({
      profileId: services.preferences.profileId,
      projectId: "reference-app",
      scope: "entity",
      scopeKey: "catalog.productChooser",
    });
    expect(pref?.activeSpecificationDigest).toBe("digest-old-v2");
  });
});

describe("local generator candidates", () => {
  it("produces diverse validated candidates within the contract", async () => {
    const kernel = createAppKernel();
    const generator = new LocalGenerator(kernel);
    const binding = createCatalogDataBinding("default", false);
    const actions = {
      "product.open@1": createProductOpenAction(() => {}),
      "cart.add@1": createCartAddAction(createCart()),
    };
    kernel.registerEntity(productChooserContract, { data: binding, actions });
    const state = createChooserStateAdapter();
    const instance = {
      runtimeInstanceId: "ri_test",
      entityKey: "catalog.productChooser",
      entityId: "entity_catalog.productChooser",
      contract: productChooserContract,
      bindings: { data: binding, actions, state },
      getNode: () => null,
    };
    const candidates = await generator.candidatesFor(instance, "make it a grid", [], 4);
    expect(candidates.length).toBeGreaterThan(1);
    const representations = new Set(candidates.map((c) => c.representation));
    expect(representations.size).toBeGreaterThanOrEqual(2); // diverse, not cosmetic duplicates
    for (const c of candidates) {
      expect(c.validation.passed).toBe(true);
      expect(productChooserContract.allowedRepresentations).toContain(c.representation);
    }
  });
});
