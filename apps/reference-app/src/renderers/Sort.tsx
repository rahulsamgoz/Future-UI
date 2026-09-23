import { newId } from "@ui-intelligence/protocol";
import type { RendererProps } from "@ui-intelligence/react";

function currentOrder(data: RendererProps["data"]): string {
  return (data.value as { sortOrder?: string })?.sortOrder ?? "featured";
}

/** Select-based sort control. */
export function SortSelect(props: RendererProps) {
  const order = currentOrder(props.data);
  const align = (props.properties.align as string) ?? "left";
  return (
    <div className={`sort-control align-${align}`} data-testid="sort-select">
      <label htmlFor="sort-order">Sort by</label>
      <select
        id="sort-order"
        value={order}
        onChange={(e) => {
          const action = props.actions["catalog.sort@1"];
          void action?.invoke({ sortOrder: e.target.value }, { invocationId: newId("inv"), signal: new AbortController().signal });
        }}
      >
        <option value="featured">Featured</option>
        <option value="price-asc">Price: low to high</option>
        <option value="price-desc">Price: high to low</option>
      </select>
    </div>
  );
}

/** Segmented-button sort control. */
export function SortSegments(props: RendererProps) {
  const order = currentOrder(props.data);
  const align = (props.properties.align as string) ?? "left";
  const options = [
    { value: "featured", label: "Featured" },
    { value: "price-asc", label: "↑ Price" },
    { value: "price-desc", label: "↓ Price" },
  ];
  return (
    <div className={`sort-control segments align-${align}`} role="group" aria-label="Sort by" data-testid="sort-segments">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={order === o.value}
          className={order === o.value ? "segment active" : "segment"}
          onClick={() => {
            const action = props.actions["catalog.sort@1"];
            void action?.invoke({ sortOrder: o.value }, { invocationId: newId("inv"), signal: new AbortController().signal });
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
