import { cleanup, render, screen } from "@testing-library/react";
import type { LayoutNode } from "@ui-intelligence/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageLayoutRenderers, type LayoutRendererProps } from "../src/index.js";

afterEach(cleanup);

function layout(
  type: "stack@1" | "grid@1" | "split@1",
  properties: Record<string, string | number>,
  children: LayoutNode[],
): Extract<LayoutNode, { kind: "layout" }> {
  return { kind: "layout", nodeId: `node-${type}-${Math.random().toString(36).slice(2, 8)}`, type, properties, children };
}

function region(slotId: string, entityId: string): Extract<LayoutNode, { kind: "region" }> {
  return { kind: "region", nodeId: `region-${slotId}`, slotId, entityId };
}

function renderRegionFactory() {
  const calls: string[] = [];
  const renderRegion = (regionNode: Extract<LayoutNode, { kind: "region" }>) => {
    calls.push(regionNode.slotId);
    return <div data-testid={`region-${regionNode.slotId}`}>{regionNode.slotId} content</div>;
  };
  return { calls, renderRegion };
}

describe("page layouts", () => {
  it("stack renders children vertically with the chosen gap", () => {
    const { calls, renderRegion } = renderRegionFactory();
    const tree = layout("stack@1", { gap: "sm", direction: "vertical" }, [
      region("header", "entity_header"),
      region("main", "entity_main"),
    ]);
    const Stack = pageLayoutRenderers["stack@1"].component;
    render(<Stack {...({ node: tree, renderRegion } as LayoutRendererProps)} />);
    expect(screen.getByTestId("region-header")).toBeTruthy();
    expect(screen.getByTestId("region-main")).toBeTruthy();
    expect(calls).toEqual(["header", "main"]);
    const stack = document.querySelector(".ui-layout-stack") as HTMLElement;
    expect(stack.style.flexDirection).toBe("column");
    expect(stack.style.gap).toBe("8px");
  });

  it("grid renders N columns from properties", () => {
    const { calls, renderRegion } = renderRegionFactory();
    const tree = layout("grid@1", { columns: 3 }, [
      region("a", "entity_a"),
      region("b", "entity_b"),
      region("c", "entity_c"),
    ]);
    const Grid = pageLayoutRenderers["grid@1"].component;
    render(<Grid {...({ node: tree, renderRegion } as LayoutRendererProps)} />);
    const grid = document.querySelector(".ui-layout-grid") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("repeat(3");
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("split renders horizontal 33-67 regions", () => {
    const { calls, renderRegion } = renderRegionFactory();
    const tree = layout("split@1", { ratio: "33-67", orientation: "horizontal" }, [
      region("left", "entity_left"),
      region("right", "entity_right"),
    ]);
    const Split = pageLayoutRenderers["split@1"].component;
    render(<Split {...({ node: tree, renderRegion } as LayoutRendererProps)} />);
    const split = document.querySelector(".ui-layout-split") as HTMLElement;
    expect(split.getAttribute("data-orientation")).toBe("horizontal");
    const cells = split.children;
    expect((cells[0] as HTMLElement).style.flexBasis).toBe("33%");
    expect((cells[1] as HTMLElement).style.flexBasis).toBe("67%");
    expect(calls).toEqual(["left", "right"]);
  });

  it("renders nested layout trees recursively, calling renderRegion once per region", () => {
    const { calls, renderRegion } = renderRegionFactory();
    const spy = vi.fn(renderRegion);
    const tree = layout("stack@1", { gap: "md" }, [
      region("top", "entity_top"),
      layout("split@1", { ratio: "50-50" }, [
        region("left", "entity_left"),
        layout("grid@1", { columns: 2 }, [
          region("cell1", "entity_cell1"),
          region("cell2", "entity_cell2"),
        ]),
      ]),
      region("bottom", "entity_bottom"),
    ]);
    const Stack = pageLayoutRenderers["stack@1"].component;
    render(<Stack {...({ node: tree, renderRegion: spy } as LayoutRendererProps)} />);
    for (const slot of ["top", "left", "cell1", "cell2", "bottom"]) {
      expect(screen.getByTestId(`region-${slot}`)).toBeTruthy();
    }
    expect(spy).toHaveBeenCalledTimes(5);
    expect(calls.sort()).toEqual(["bottom", "cell1", "cell2", "left", "top"]);
  });

  it("renders nothing for unknown layout types in children without throwing", () => {
    const { renderRegion } = renderRegionFactory();
    const bogus = { kind: "layout", nodeId: "bogus", type: "maze@1", properties: {}, children: [] } as unknown as LayoutNode;
    const tree = layout("stack@1", {}, [bogus]);
    const Stack = pageLayoutRenderers["stack@1"].component;
    render(<Stack {...({ node: tree, renderRegion } as LayoutRendererProps)} />);
    expect(document.querySelector(".ui-layout-stack")).toBeTruthy();
  });
});
