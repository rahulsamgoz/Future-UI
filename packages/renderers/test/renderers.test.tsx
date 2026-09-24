import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { entityContractSchema, type EntityContract, type JsonValue } from "@ui-intelligence/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  buttonRenderers,
  CarouselRenderer,
  createFixtureProductData,
  createStubActionBindings,
  GridRenderer,
  priceVisible,
  productChooserRenderers,
  sampleProducts,
  TableRenderer,
  type RendererProps,
} from "../src/index.js";
import { rendererComponents } from "../src/index.js";

afterEach(cleanup);

function makeContract(overrides: Partial<EntityContract> = {}): EntityContract {
  return entityContractSchema.parse({
    entityKey: "catalog.productChooser",
    contractVersion: 1,
    dataBinding: "catalog.products@1",
    allowedRepresentations: ["carousel@1", "grid@1", "table@1"],
    actions: ["product.open@1", "cart.add@1"],
    requiredFields: ["product.id", "product.name", "product.price"],
    stateFields: ["selectedProductId", "sortOrder", "filters"],
    constraints: { preserveActions: true, preservePriceVisibility: true, maximumColumns: 4 },
    ...overrides,
  });
}

function makeProps(overrides: Partial<RendererProps> = {}): RendererProps {
  return {
    contract: makeContract(),
    data: createFixtureProductData(sampleProducts).getSnapshot(),
    actions: createStubActionBindings(["product.open@1", "cart.add@1"]) as never,
    properties: {},
    ...overrides,
  };
}

describe("product renderers", () => {
  it("carousel, grid, and table each render all six sample products", () => {
    for (const [id, Component] of [
      ["carousel@1", CarouselRenderer],
      ["grid@1", GridRenderer],
      ["table@1", TableRenderer],
    ] as const) {
      const props = makeProps();
      render(<Component {...props} />);
      for (const product of sampleProducts) {
        expect(screen.getByText(product.name), `${id} missing ${product.name}`).toBeTruthy();
      }
      cleanup();
    }
  });

  it("table renders a semantic <table> with visible prices", () => {
    render(<TableRenderer {...makeProps()} />);
    expect(document.querySelector("table")).not.toBeNull();
    expect(document.querySelector("thead")).not.toBeNull();
    for (const product of sampleProducts) {
      expect(screen.getByText(`$${product.price.toFixed(2)}`)).toBeTruthy();
    }
  });

  it("hides prices when showPrice is false, unless preservePriceVisibility wins", () => {
    const hideProps = makeProps({
      contract: makeContract({ constraints: { preserveActions: true, preservePriceVisibility: false } }),
      properties: { showPrice: false },
    });
    render(<TableRenderer {...hideProps} />);
    expect(screen.queryByText("$89.00")).toBeNull();
    cleanup();

    const constraintProps = makeProps({
      contract: makeContract({ constraints: { preserveActions: true, preservePriceVisibility: true } }),
      properties: { showPrice: false },
    });
    render(<TableRenderer {...constraintProps} />);
    expect(screen.getByText("$89.00")).toBeTruthy();
    expect(priceVisible(constraintProps.contract, constraintProps.properties)).toBe(true);
  });

  it("invokes product.open@1 with productId when a product is clicked", async () => {
    const stubs = createStubActionBindings(["product.open@1", "cart.add@1"]);
    render(<GridRenderer {...makeProps({ actions: stubs as never })} />);
    fireEvent.click(screen.getByText("Aurora Lamp"));
    await waitFor(() => {
      expect(stubs.calls).toContainEqual({ actionId: "product.open@1", input: { productId: "p_aurora" } });
    });
  });

  it("invokes cart.add@1 from the Add to cart button", async () => {
    const stubs = createStubActionBindings(["product.open@1", "cart.add@1"]);
    render(<TableRenderer {...makeProps({ actions: stubs as never })} />);
    const addButtons = screen.getAllByText("Add to cart");
    expect(addButtons).toHaveLength(sampleProducts.length);
    fireEvent.click(addButtons[2]);
    await waitFor(() => {
      expect(stubs.calls).toContainEqual({ actionId: "cart.add@1", input: { productId: "p_comet" } });
    });
  });

  it("shows loading, empty, and error states", () => {
    const loading = makeProps({
      data: { revision: "r", status: "loading", value: null as JsonValue },
    });
    render(<CarouselRenderer {...loading} />);
    expect(screen.getByRole("status").textContent).toMatch(/loading/i);
    cleanup();

    const empty = makeProps({
      data: createFixtureProductData([]).getSnapshot(),
    });
    render(<GridRenderer {...empty} />);
    expect(screen.getByRole("status").textContent).toMatch(/no products/i);
    cleanup();

    const error = makeProps({
      data: { revision: "r", status: "error", value: null as JsonValue },
    });
    render(<TableRenderer {...error} />);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("clamps grid columns to the contract's maximumColumns constraint", () => {
    const props = makeProps({ properties: { columns: 9 } });
    render(<GridRenderer {...props} />);
    const grid = document.querySelector(".ui-product-grid") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("repeat(4");
  });

  it("exposes descriptors compatible with the product chooser contract", () => {
    const contract = makeContract();
    for (const id of ["carousel@1", "grid@1", "table@1"]) {
      const entry = productChooserRenderers[id];
      expect(entry, id).toBeTruthy();
      expect(entry.descriptor.compatibleWith(contract)).toBe(true);
      expect(entry.descriptor.rendersFields).toEqual(["product.id", "product.name", "product.price"]);
    }
    // Incompatible when the representation is not allowed.
    expect(
      productChooserRenderers["carousel@1"].descriptor.compatibleWith(
        makeContract({ allowedRepresentations: ["grid@1"] }),
      ),
    ).toBe(false);
  });
});

describe("button renderers", () => {
  it("renders the compact variant class", () => {
    const contract = entityContractSchema.parse({
      entityKey: "ui.checkoutButton",
      contractVersion: 1,
      dataBinding: "ui.label@1",
      allowedRepresentations: ["button.default@1", "button.compact@1"],
      actions: ["cart.add@1"],
    });
    const props = makeProps({
      contract,
      data: { revision: "r", status: "ready", value: { label: "Buy now" } as JsonValue },
      properties: { label: "Buy now", variant: "compact" },
    });
    const CompactButton = buttonRenderers["button.compact@1"].component;
    render(<CompactButton {...props} />);
    const button = screen.getByRole("button", { name: "Buy now" });
    expect(button.className).toContain("ui-btn--compact");
    expect(buttonRenderers["button.compact@1"].descriptor.compatibleWith(contract)).toBe(true);
  });

  it("renders the default variant and falls back to the data label", () => {
    const contract = entityContractSchema.parse({
      entityKey: "ui.checkoutButton",
      contractVersion: 1,
      dataBinding: "ui.label@1",
      allowedRepresentations: ["button.default@1"],
      actions: [],
    });
    const props = makeProps({
      contract,
      data: { revision: "r", status: "ready", value: "Add item" as JsonValue },
      properties: {},
    });
    const DefaultButton = buttonRenderers["button.default@1"].component;
    render(<DefaultButton {...props} />);
    expect(screen.getByRole("button", { name: "Add item" }).className).toContain("ui-btn--default");
  });
});

describe("preview stubs", () => {
  it("stub action bindings record calls and never throw", async () => {
    const stubs = createStubActionBindings(["product.open@1", "cart.add@1"]);
    const result = await stubs["product.open@1"].invoke(
      { productId: "p1" },
      { invocationId: "inv-1", dataRevision: "r1", signal: new AbortController().signal },
    );
    expect(result.status).toBe("succeeded");
    expect(stubs.calls).toEqual([{ actionId: "product.open@1", input: { productId: "p1" } }]);
  });

  it("controlled data provider exposes a static ready snapshot", () => {
    const provider = createFixtureProductData(sampleProducts, "fixed-42");
    expect(provider.getSnapshot()).toEqual({
      revision: "fixed-42",
      status: "ready",
      value: sampleProducts,
    });
    expect(provider.getSnapshot()).toEqual(provider.getSnapshot());
    const unsubscribe = provider.subscribe(() => undefined);
    expect(typeof unsubscribe).toBe("function");
  });

  it("rendererComponents merges product chooser and button components by id", () => {
    expect(Object.keys(rendererComponents).sort()).toEqual([
      "button.compact@1",
      "button.default@1",
      "carousel@1",
      "grid@1",
      "table@1",
    ]);
  });

  it("sampleProducts fixture contains six complete products", () => {
    expect(sampleProducts).toHaveLength(6);
    for (const product of sampleProducts) {
      expect(typeof product.id).toBe("string");
      expect(typeof product.name).toBe("string");
      expect(typeof product.price).toBe("number");
    }
  });
});
