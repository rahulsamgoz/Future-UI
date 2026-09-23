import { useEffect, useState, useSyncExternalStore } from "react";
import type { EntityContract, LayoutNode, PageContract } from "@ui-intelligence/protocol";
import { pageLayoutRenderers } from "@ui-intelligence/renderers";
import { ProposalValidator } from "@ui-intelligence/runtime-core";
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
  const { preferences, kernel } = useAppServices();
  useSyncExternalStore(preferences.active.subscribe, preferences.active.getVersion);
  const pref = preferences.active.get(`page:${pageContract.pageKey}`);
  const storedLayout: LayoutNode | null =
    pref?.representation === "layout"
      ? (pref.properties as unknown as { layout: LayoutNode }).layout
      : null;
  // A stored layout is revalidated against the CURRENT page contract every
  // time it renders (spec sections 7 and 9: each mounting route revalidates
  // compatibility). A stale layout that would drop required or locked slots
  // falls back to the default layout.
  const [validStoredLayout, setValidStoredLayout] = useState<LayoutNode | null>(null);
  const prefDigest = pref?.digest ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!storedLayout) {
      setValidStoredLayout(null);
      return;
    }
    void (async () => {
      const validator = new ProposalValidator(kernel.renderers);
      const entityContracts = new Map<string, EntityContract>();
      for (const slot of pageContract.slots) {
        const entity = kernel.getEntity(slot.entityKey);
        if (entity) entityContracts.set(slot.entityKey, entity.contract);
      }
      const readSet = await kernel.currentReadSet(pageContract.pageKey, 1);
      const report = await validator.validatePageLayout(
        storedLayout,
        pageContract,
        entityContracts,
        readSet,
        1
      );
      if (!cancelled) setValidStoredLayout(report.passed ? storedLayout : null);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefDigest, pageContract.pageKey, kernel]);
  const layout: LayoutNode = validStoredLayout ?? defaultLayout;

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
