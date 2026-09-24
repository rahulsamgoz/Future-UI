import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { entityContractSchema, type EntityContract, type JsonValue } from "@ui-intelligence/protocol";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findLogicalParent,
  getLogicalAncestors,
  trackLogicalInstance,
  transferState,
  UiBoundary,
  UiRuntimeProvider,
  useDataSnapshot,
  useUiRuntime,
} from "../src/index.js";
import type { RendererProps } from "../src/index.js";
import {
  FakeRuntimeKernel,
  makeControlledBinding,
  makeInstanceInfo,
  type FakeRuntimeInstanceInfo,
} from "./helpers/fakeRuntimeCore.js";

afterEach(cleanup);

export function makeContract(overrides: Partial<EntityContract> = {}): EntityContract {
  return entityContractSchema.parse({
    entityKey: "catalog.productChooser",
    contractVersion: 1,
    dataBinding: "catalog.products@1",
    allowedRepresentations: ["carousel@1", "grid@1", "table@1"],
    actions: ["product.open@1", "cart.add@1"],
    requiredFields: ["product.id", "product.name", "product.price"],
    stateFields: [],
    constraints: { preserveActions: true, preservePriceVisibility: true, maximumColumns: 4 },
    ...overrides,
  });
}

const PRODUCTS: JsonValue = [
  { id: "p1", name: "Aurora Lamp", price: 89 },
  { id: "p2", name: "Basil Planter", price: 24.5 },
];

function GridRendererComponent({ data }: RendererProps) {
  const items = Array.isArray(data.value) ? data.value : [];
  return (
    <ul>
      {items.map((item, index) => (
        <li key={typeof (item as { id?: JsonValue }).id === "string" ? (item as { id: string }).id : index}>
          {(item as { name?: string }).name ?? "?"}
        </li>
      ))}
    </ul>
  );
}

describe("UiBoundary", () => {
  it("renders the canonical override when no renderer applies", () => {
    const kernel = new FakeRuntimeKernel();
    const contract = makeContract();
    const { container } = render(
      <UiRuntimeProvider kernel={kernel}>
        <UiBoundary
          contract={contract}
          bindings={{ data: makeControlledBinding(PRODUCTS).binding, actions: {} }}
          renderers={{}}
          rendererOverride={<div data-testid="canonical">Canonical UI</div>}
        />
      </UiRuntimeProvider>,
    );
    expect(screen.getByTestId("canonical")).toBeTruthy();
    const host = container.querySelector("[data-ui-entity='catalog.productChooser']");
    expect(host).not.toBeNull();
    expect(kernel.getEntity("catalog.productChooser")).toBeDefined();
  });

  it("renders the grid renderer with data and passes properties", () => {
    const kernel = new FakeRuntimeKernel();
    const contract = makeContract();
    let seenProps: RendererProps | null = null;
    function Spy({ data, properties, contract: c }: RendererProps) {
      seenProps = { contract: c, data, properties } as RendererProps;
      return <div>{Array.isArray(data.value) ? `${data.value.length} items` : "none"}</div>;
    }
    render(
      <UiRuntimeProvider kernel={kernel}>
        <UiBoundary
          contract={contract}
          bindings={{ data: makeControlledBinding(PRODUCTS).binding, actions: {} }}
          renderers={{ "grid@1": Spy }}
          preferredRepresentation="grid@1"
          preferredProperties={{ columns: 2 }}
          instanceKey="chooser-1"
        />
      </UiRuntimeProvider>,
    );
    expect(screen.getByText("2 items")).toBeTruthy();
    expect(seenProps?.properties).toEqual({ columns: 2 });
    expect(seenProps?.contract.entityKey).toBe("catalog.productChooser");
    expect(screen.getByText("2 items").closest("[data-ui-instance='chooser-1']")).not.toBeNull();
  });

  it("falls back through allowed representations when the preferred one is missing", () => {
    const kernel = new FakeRuntimeKernel();
    render(
      <UiRuntimeProvider kernel={kernel}>
        <UiBoundary
          contract={makeContract()}
          bindings={{ data: makeControlledBinding(PRODUCTS).binding, actions: {} }}
          renderers={{ "table@1": () => <div data-testid="table">table</div> }}
          preferredRepresentation="carousel@1"
        />
      </UiRuntimeProvider>,
    );
    expect(screen.getByTestId("table")).toBeTruthy();
  });

  it("re-renders when the data binding notifies a new revision", () => {
    const kernel = new FakeRuntimeKernel();
    const { binding, update } = makeControlledBinding(PRODUCTS);
    render(
      <UiRuntimeProvider kernel={kernel}>
        <UiBoundary
          contract={makeContract()}
          bindings={{ data: binding, actions: {} }}
          renderers={{ "grid@1": GridRendererComponent }}
        />
      </UiRuntimeProvider>,
    );
    expect(screen.getByText("Aurora Lamp")).toBeTruthy();
    act(() => {
      update(
        [
          { id: "p1", name: "Aurora Lamp", price: 89 },
          { id: "p2", name: "Basil Planter", price: 24.5 },
          { id: "p3", name: "Comet Headphones", price: 149.99 },
        ],
        "rev-2",
      );
    });
    expect(screen.getByText("Comet Headphones")).toBeTruthy();
  });

  it("registers the host node with kernel.instances and unregisters on unmount", () => {
    const kernel = new FakeRuntimeKernel();
    const { container, unmount } = render(
      <UiRuntimeProvider kernel={kernel}>
        <UiBoundary
          contract={makeContract()}
          bindings={{ data: makeControlledBinding(PRODUCTS).binding, actions: {} }}
          renderers={{ "grid@1": GridRendererComponent }}
          instanceKey="chooser-1"
        />
      </UiRuntimeProvider>,
    );
    const host = container.querySelector<HTMLElement>("[data-ui-entity='catalog.productChooser']");
    expect(host).not.toBeNull();
    const info = kernel.instances.resolve(host as unknown as object) as FakeRuntimeInstanceInfo | null;
    expect(info).not.toBeNull();
    expect(info?.entityKey).toBe("catalog.productChooser");
    expect(info?.entityId).toBe("entity_catalog.productChooser");
    expect(info?.contract.allowedRepresentations).toEqual(["carousel@1", "grid@1", "table@1"]);
    expect(info?.getNode()).toBe(host);

    unmount();
    expect(kernel.instances.resolve(host as unknown as object)).toBeNull();
  });

  it("does not leak registrations across StrictMode double-mount and remount", () => {
    const kernel = new FakeRuntimeKernel();
    const ui = (
      <StrictMode>
        <UiRuntimeProvider kernel={kernel}>
          <UiBoundary
            contract={makeContract()}
            bindings={{ data: makeControlledBinding(PRODUCTS).binding, actions: {} }}
            renderers={{ "grid@1": GridRendererComponent }}
          />
        </UiRuntimeProvider>
      </StrictMode>
    );
    const first = render(ui);
    const host = first.container.querySelector("[data-ui-entity='catalog.productChooser']");
    expect(host).not.toBeNull();
    expect(kernel.instances.resolve(host as unknown as object)).not.toBeNull();

    first.unmount();
    expect(kernel.instances.resolve(host as unknown as object)).toBeNull();

    const second = render(ui);
    const host2 = second.container.querySelector("[data-ui-entity='catalog.productChooser']");
    expect(host2).not.toBeNull();
    const info = kernel.instances.resolve(host2 as unknown as object);
    expect(info).not.toBeNull();
    expect(info?.entityKey).toBe("catalog.productChooser");
    second.unmount();
    expect(kernel.instances.resolve(host2 as unknown as object)).toBeNull();
  });

  it("resolves instances from a composed event path via kernel.instances", () => {
    const kernel = new FakeRuntimeKernel();
    const { container } = render(
      <UiRuntimeProvider kernel={kernel}>
        <UiBoundary
          contract={makeContract()}
          bindings={{ data: makeControlledBinding(PRODUCTS).binding, actions: {} }}
          renderers={{ "grid@1": GridRendererComponent }}
        />
      </UiRuntimeProvider>,
    );
    const host = container.querySelector("[data-ui-entity='catalog.productChooser']") as HTMLElement;
    const button = host.querySelector("li") ?? host;
    const path = [button, host, container, document.body];
    const resolved = kernel.instances.resolveFromEventPath(path);
    expect(resolved?.entityKey).toBe("catalog.productChooser");
  });
});

describe("useUiRuntime", () => {
  it("throws UiIntelligenceError CAPABILITY_MISSING without a provider", () => {
    function Probe() {
      useUiRuntime();
      return null;
    }
    let caught: unknown = null;
    // Suppress the expected error boundary-less throw noise.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<Probe />);
    } catch (error) {
      caught = error;
    }
    spy.mockRestore();
    expect((caught as { code?: string } | null)?.code).toBe("CAPABILITY_MISSING");
  });
});

describe("useDataSnapshot", () => {
  it("keeps snapshot identity stable between notifications for the same revision", () => {
    // getSnapshot returns a fresh object per call; the hook must cache by
    // revision so useSyncExternalStore sees a stable identity.
    const binding = {
      contract: { id: "catalog.products@1", version: 1, schemaDigest: "products" },
      getSnapshot: () => ({ revision: "rev-1", status: "ready" as const, value: PRODUCTS }),
      subscribe: () => () => undefined,
    };
    let latest: unknown = null;
    function Probe() {
      latest = useDataSnapshot(binding);
      return null;
    }
    const { rerender } = render(<Probe />);
    const first = latest;
    expect((first as { revision: string }).revision).toBe("rev-1");
    rerender(<Probe />);
    expect(latest).toBe(first);
    cleanup();
  });
});

describe("getLogicalAncestors", () => {
  it("walks the logical containment chain and guards against cycles", () => {
    const grandparent = makeInstanceInfo({ entityKey: "page.root" });
    const parent = makeInstanceInfo({ entityKey: "catalog.parent", logicalParent: grandparent });
    const child = makeInstanceInfo({ entityKey: "catalog.child", logicalParent: parent });
    expect(getLogicalAncestors(child).map((info) => info.entityKey)).toEqual([
      "catalog.parent",
      "page.root",
    ]);
    expect(getLogicalAncestors(grandparent)).toEqual([]);
    const cyclic: FakeRuntimeInstanceInfo = makeInstanceInfo({ entityKey: "a" });
    cyclic.logicalParent = cyclic;
    expect(getLogicalAncestors(cyclic)).toEqual([]);
  });
});

describe("transferState", () => {
  function makeAdapter(overrides: Partial<import("@ui-intelligence/protocol").StateAdapter> = {}) {
    let state: JsonValue = null;
    return {
      version: 1,
      canSwitch: () => ({ allowed: true }) as const,
      exportState: () => state,
      validateState: () => true,
      importState: (next: JsonValue) => {
        state = next;
      },
      ...overrides,
    };
  }

  it("exports from the source, validates, and imports into the destination", () => {
    const source = makeAdapter();
    source.importState({ selectedProductId: "p1" });
    const destination = makeAdapter();
    expect(transferState(source, destination, undefined, "grid@1")).toBe(true);
    expect(destination.exportState()).toEqual({ selectedProductId: "p1" });
  });

  it("uses the provided state when given", () => {
    const source = makeAdapter();
    const destination = makeAdapter();
    expect(transferState(source, destination, { sortOrder: "price-asc" }, "table@1")).toBe(true);
    expect(destination.exportState()).toEqual({ sortOrder: "price-asc" });
  });

  it("returns false when an adapter is missing or validation fails", () => {
    const source = makeAdapter();
    const destination = makeAdapter({ validateState: () => false });
    expect(transferState(undefined, destination, null, "grid@1")).toBe(false);
    expect(transferState(source, undefined, null, "grid@1")).toBe(false);
    expect(transferState(source, destination, { filters: [] }, "grid@1")).toBe(false);
    expect(destination.exportState()).toBeNull();
  });
});

describe("selection", () => {
  it("resolves the nearest registered instance along the composed path", () => {
    const kernel = new FakeRuntimeKernel();
    const { container } = render(
      <UiRuntimeProvider kernel={kernel}>
        <UiBoundary
          contract={makeContract()}
          bindings={{ data: makeControlledBinding(PRODUCTS).binding, actions: {} }}
          renderers={{ "grid@1": GridRendererComponent }}
        />
      </UiRuntimeProvider>,
    );
    const host = container.querySelector("[data-ui-entity]") as HTMLElement;
    const target = host.querySelector("li") as HTMLElement;
    const fakeEvent = { composedPath: () => [target, host, container] };
    const resolved = kernel.instances.resolveFromEventPath(fakeEvent.composedPath());
    expect(resolved?.entityKey).toBe("catalog.productChooser");
    // Node-level selection (used by the selection UI) hits the same registry.
    expect(kernel.instances.resolve(host)?.entityId).toBe("entity_catalog.productChooser");
  });

  it("ignores events outside registered boundaries", () => {
    const kernel = new FakeRuntimeKernel();
    render(
      <UiRuntimeProvider kernel={kernel}>
        <div data-testid="outside" />
      </UiRuntimeProvider>,
    );
    const outside = screen.getByTestId("outside");
    fireEvent.click(outside);
    expect(kernel.instances.resolveFromEventPath([outside, document.body])).toBeNull();
  });
});

describe("logical parent resolution for repeated instances", () => {
  it("prefers the tracked instance whose node contains the child in the DOM", () => {
    const kernel = new FakeRuntimeKernel();
    const parentA = document.createElement("div");
    const parentB = document.createElement("div");
    const child = document.createElement("div");
    parentB.appendChild(child);
    const infoA = makeInstanceInfo({ entityKey: "catalog.relatedProducts", getNode: () => parentA });
    const infoB = makeInstanceInfo({ entityKey: "catalog.relatedProducts", getNode: () => parentB });
    trackLogicalInstance(kernel, infoA);
    trackLogicalInstance(kernel, infoB);

    // The child sits inside B's subtree: B wins even though A was tracked.
    expect(findLogicalParent(kernel, "catalog.relatedProducts", child)).toBe(infoB);
    // A child outside both subtrees falls back to the most recent instance.
    const outside = document.createElement("div");
    expect(findLogicalParent(kernel, "catalog.relatedProducts", outside)).toBe(infoB);
    // Without a child node the most recent tracked instance is used.
    expect(findLogicalParent(kernel, "catalog.relatedProducts")).toBe(infoB);
    // The first instance still resolves when it is the only one tracked.
    const otherKernel = new FakeRuntimeKernel();
    trackLogicalInstance(otherKernel, infoA);
    expect(findLogicalParent(otherKernel, "catalog.relatedProducts", null)).toBe(infoA);
  });

  it("links a child boundary to the DOM-containing instance of a repeated entity key", () => {
    const kernel = new FakeRuntimeKernel();
    const relatedContract = makeContract({ entityKey: "catalog.relatedProducts" });
    const relatedBinding = makeControlledBinding([]).binding;
    const chooser = makeControlledBinding([]);

    const ParentBoundary = ({ instanceKey, children }: { instanceKey: string; children?: React.ReactNode }) => (
      <UiBoundary
        contract={relatedContract}
        bindings={{ data: relatedBinding, actions: {} }}
        instanceKey={instanceKey}
        rendererOverride={children ?? null}
      />
    );

    // Render order: nested (tracks first), child (no node yet, falls back to
    // latest), top (tracks last). After mount, the latest tracked instance is
    // "related.top", but the child lives inside "related.nested"'s subtree.
    render(
      <UiRuntimeProvider kernel={kernel}>
        <ParentBoundary instanceKey="related.nested">
          <UiBoundary
            contract={makeContract()}
            bindings={{ data: chooser.binding, actions: {} }}
            instanceKey="chooser.inside"
            logicalParentEntityKey="catalog.relatedProducts"
          />
        </ParentBoundary>
        <ParentBoundary instanceKey="related.top" />
      </UiRuntimeProvider>,
    );

    const nestedHost = document.querySelector('[data-ui-instance="related.nested"]') as HTMLElement;
    const topHost = document.querySelector('[data-ui-instance="related.top"]') as HTMLElement;
    const childHost = document.querySelector('[data-ui-instance="chooser.inside"]') as HTMLElement;
    expect(nestedHost).toBeTruthy();
    expect(topHost).toBeTruthy();
    const childInfo = kernel.instances.resolve(childHost)!;
    expect(childInfo).toBeTruthy();

    // Force a re-resolution with the child's node attached.
    act(() => {
      chooser.update([], "rev-2");
    });

    expect(childInfo.logicalParent?.getNode()).toBe(nestedHost);
    expect(childInfo.logicalParent?.getNode()).not.toBe(topHost);
  });
});
