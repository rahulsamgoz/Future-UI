import { useEffect, useRef, useState } from "react";
import type { RendererProps } from "@ui-intelligence/react";

/**
 * Virtualized transaction list. Offscreen rows are NOT assumed to have
 * disappeared from the app: observation of this region is partial by design
 * (protocol section 6).
 */
export function ListVirtual(props: RendererProps) {
  const rowHeight = (props.properties.rowHeight as number) ?? 48;
  const rows = (props.data.value as Array<{ id: string; label: string; amount: number; date: string }>) ?? [];
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState<number>(
    props.state ? ((props.state.exportState() as { scrollTop?: number }).scrollTop ?? 0) : 0
  );
  const height = 320;
  const overscan = 3;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  const visible = rows.slice(start, end);

  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="transaction-list" data-testid="transaction-list" data-observed-window={`${start}-${end}`}>
      <h3>Transactions ({rows.length})</h3>
      <div
        ref={viewportRef}
        className="tx-viewport"
        style={{ height, overflowY: "auto" }}
        onScroll={(e) => {
          const next = (e.target as HTMLDivElement).scrollTop;
          setScrollTop(next);
          props.state?.importState({ scrollTop: next });
        }}
      >
        <div style={{ height: rows.length * rowHeight, position: "relative" }}>
          {visible.map((row, i) => (
            <div
              key={row.id}
              className="tx-row"
              style={{ position: "absolute", top: (start + i) * rowHeight, height: rowHeight, left: 0, right: 0 }}
            >
              <span className="tx-label">{row.label}</span>
              <span className="tx-amount">${row.amount}</span>
              <span className="tx-date">{row.date}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
