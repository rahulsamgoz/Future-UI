import { useSyncExternalStore } from "react";
import type { LayoutNode, PageContract } from "@ui-intelligence/protocol";
import { pageLayoutRenderers } from "@ui-intelligence/renderers";
import { useAppServices } from "../Services.js";

type RegionNode = Extract<LayoutNode, { kind: "region" }>;

/**
 * Page composition: renders the active page layout tree over registered
 * region slots (protocol section 7). The app owns navigation and routing;
 * changing page composition does not change business workflows.
 */
export function PageComposer({
  pageContract,
  defaultLayout,
  regions,
}: {
  pageContract: PageContract;
  defaultLayout: LayoutNode;
  regions: Record<string, React.ReactNode>;
}) {
  const { preferences } = useAppServices();
  useSyncExternalStore(preferences.active.subscribe, preferences.active.getVersion);
  const pref = preferences.active.get(`page:${pageContract.pageKey}`);
  const layout: LayoutNode =
    pref?.representation === "layout"
      ? (pref.properties as unknown as { layout: LayoutNode }).layout
      : defaultLayout;

  const renderRegion = (region: RegionNode): React.ReactNode => regions[region.slotId] ?? null;
  const rootNode: LayoutNode =
    layout.kind === "layout"
      ? layout
      : { kind: "layout", nodeId: "root", type: "stack@1", properties: {}, children: [layout] };
  const renderer = pageLayoutRenderers[rootNode.type];
  if (!renderer) {
    // Canonical fallback: preserve the default interface.
    return <div className="page-fallback">{Object.values(regions)}</div>;
  }
  const Layout = renderer.component;
  return <Layout node={rootNode} renderRegion={renderRegion} />;
}

export function usePageLayoutPreference(pageKey: string): LayoutNode | null {
  const { preferences } = useAppServices();
  useSyncExternalStore(preferences.active.subscribe, preferences.active.getVersion);
  const pref = preferences.active.get(`page:${pageKey}`);
  if (!pref || pref.representation !== "layout") return null;
  return (pref.properties as unknown as { layout: LayoutNode }).layout;
}
