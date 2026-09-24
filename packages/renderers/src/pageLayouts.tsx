/**
 * Approved page layouts (spec section 7): stack@1, grid@1, split@1 plus
 * registered region slots. Layouts render children recursively; the app
 * supplies `renderRegion` to mount registered region content. Layout
 * composition invokes no business action and changes no routing.
 */
import type { LayoutNode } from "@ui-intelligence/protocol";
import type { ComponentType, CSSProperties, ReactNode } from "react";
import { Fragment } from "react";
import { clamp, enumProperty, numberProperty } from "./products.js";
import type { LayoutRendererProps } from "./types.js";

type LayoutNodeAsLayout = Extract<LayoutNode, { kind: "layout" }>;
type LayoutNodeAsRegion = Extract<LayoutNode, { kind: "region" }>;

const GAPS = ["none", "sm", "md", "lg"] as const;
const GAP_PX: Record<(typeof GAPS)[number], number> = { none: 0, sm: 8, md: 16, lg: 32 };

const RATIOS = ["50-50", "33-67", "67-33"] as const;
const RATIO_SPLITS: Record<(typeof RATIOS)[number], [number, number]> = {
  "50-50": [50, 50],
  "33-67": [33, 67],
  "67-33": [67, 33],
};

function childKey(child: LayoutNode, index: number): string {
  return child.nodeId || `child-${index}`;
}

/** Render a layout node's children: regions via the app, layouts recursively. */
function renderLayoutChildren(
  node: LayoutNodeAsLayout,
  renderRegion: (region: LayoutNodeAsRegion) => ReactNode,
): ReactNode {
  return node.children.map((child, index) => {
    if (child.kind === "region") {
      return <Fragment key={childKey(child, index)}>{renderRegion(child)}</Fragment>;
    }
    const ChildLayout = pageLayoutComponents[child.type];
    return ChildLayout ? (
      <ChildLayout key={childKey(child, index)} node={child} renderRegion={renderRegion} />
    ) : null;
  });
}

export function StackLayout({ node, renderRegion }: LayoutRendererProps) {
  if (node.kind !== "layout") return null;
  const gap = enumProperty(node.properties, "gap", GAPS, "md");
  const style: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: `${GAP_PX[gap]}px`,
  };
  return (
    <div className={`ui-layout ui-layout-stack ui-layout-stack--gap-${gap}`} style={style}>
      {renderLayoutChildren(node, renderRegion)}
    </div>
  );
}

export function GridLayout({ node, renderRegion }: LayoutRendererProps) {
  if (node.kind !== "layout") return null;
  const columns = clamp(numberProperty(node.properties, "columns", 2), 1, 4);
  const style: CSSProperties = {
    display: "grid",
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gap: "16px",
  };
  return (
    <div className="ui-layout ui-layout-grid" style={style} data-columns={columns}>
      {renderLayoutChildren(node, renderRegion)}
    </div>
  );
}

export function SplitLayout({ node, renderRegion }: LayoutRendererProps) {
  if (node.kind !== "layout") return null;
  const ratio = enumProperty(node.properties, "ratio", RATIOS, "50-50");
  const orientation = enumProperty(
    node.properties,
    "orientation",
    ["horizontal", "vertical"] as const,
    "horizontal",
  );
  const [firstPercent, secondPercent] = RATIO_SPLITS[ratio];
  const style: CSSProperties = {
    display: "flex",
    flexDirection: orientation === "horizontal" ? "row" : "column",
    gap: "16px",
  };
  return (
    <div
      className={`ui-layout ui-layout-split ui-layout-split--${ratio}`}
      style={style}
      data-orientation={orientation}
    >
      {node.children.map((child, index) => {
        const percent = index === 0 ? firstPercent : secondPercent;
        const childStyle: CSSProperties =
          index <= 1 ? { flexBasis: `${percent}%`, minWidth: 0 } : { flex: 1, minWidth: 0 };
        if (child.kind === "region") {
          return (
            <div key={childKey(child, index)} style={childStyle}>
              {renderRegion(child)}
            </div>
          );
        }
        const ChildLayout = pageLayoutComponents[child.type];
        return ChildLayout ? (
          <div key={childKey(child, index)} style={childStyle}>
            <ChildLayout node={child} renderRegion={renderRegion} />
          </div>
        ) : null;
      })}
    </div>
  );
}

const pageLayoutComponents: Record<"stack@1" | "grid@1" | "split@1", ComponentType<LayoutRendererProps>> = {
  "stack@1": StackLayout,
  "grid@1": GridLayout,
  "split@1": SplitLayout,
};

export const pageLayoutRenderers: Record<string, { component: ComponentType<LayoutRendererProps> }> = {
  "stack@1": { component: StackLayout },
  "grid@1": { component: GridLayout },
  "split@1": { component: SplitLayout },
};

export type { LayoutNodeAsLayout, LayoutNodeAsRegion };
