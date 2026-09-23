import type { RendererProps } from "@ui-intelligence/react";

/** Admin panel: the locked region on the account page. */
export function PanelStandard(props: RendererProps) {
  const stats = (props.data.value as { activeUsers?: number; conversion?: number; openCarts?: number }) ?? {};
  const emphasis = (props.properties.emphasis as string) ?? "normal";
  return (
    <section className={`admin-panel ${emphasis === "high" ? "emphasis" : ""}`} data-testid="admin-panel">
      <h3>Admin</h3>
      <dl>
        <div><dt>Active users</dt><dd>{stats.activeUsers ?? "—"}</dd></div>
        <div><dt>Conversion</dt><dd>{((stats.conversion ?? 0) * 100).toFixed(1)}%</dd></div>
        <div><dt>Open carts</dt><dd>{stats.openCarts ?? "—"}</dd></div>
      </dl>
    </section>
  );
}
