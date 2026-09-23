/**
 * `<UiBoundary>` — the core semantic boundary API (spec section 6).
 *
 * A boundary registers its entity key, supported presentations, data/action
 * contracts, state adapter, and one host DOM node. Renderer components are
 * supplied by the host via the `renderers` map; when no renderer applies, the
 * canonical app UI (`rendererOverride`) is preserved.
 */
import { newId } from "@ui-intelligence/protocol";
import type { RuntimeInstanceInfo } from "@ui-intelligence/runtime-core";
import { useCallback, useRef } from "react";
import { useUiRuntime } from "./context.js";
import { findLogicalParent, trackLogicalInstance } from "./logical.js";
import type { RendererProps, UiBoundaryProps } from "./types.js";
import { useDataSnapshot } from "./useDataSnapshot.js";

export function UiBoundary({
  contract,
  bindings,
  instanceKey,
  logicalParentEntityKey,
  preferredRepresentation,
  preferredProperties,
  renderers,
  rendererOverride,
  children,
  onActionComplete,
}: UiBoundaryProps) {
  const kernel = useUiRuntime();

  // (a) Register the entity contract once per boundary instance. If the
  // entityKey is already registered (another boundary instance or the host
  // app pre-registered the contract), reuse the existing registration: the
  // key collision rule applies to DIFFERENT contracts sharing a key, which
  // registerEntity still rejects; identical re-registration is idempotent.
  const entityRef = useRef<{ entityId: string } | null>(null);
  if (entityRef.current === null) {
    const existing = kernel.getEntity(contract.entityKey);
    if (existing) {
      entityRef.current = { entityId: contract.entityKey };
    } else {
      const { entityId } = kernel.registerEntity(contract, bindings);
      entityRef.current = { entityId };
    }
  }

  // RuntimeInstanceInfo identity is stable per boundary instance; mutable
  // fields are refreshed on every render so hot updates pick up new props
  // without re-registering the host node.
  const infoRef = useRef<RuntimeInstanceInfo | null>(null);
  const nodeRef = useRef<HTMLElement | null>(null);
  if (infoRef.current === null) {
    const logicalParent = logicalParentEntityKey
      ? findLogicalParent(kernel, logicalParentEntityKey)
      : null;
    infoRef.current = {
      runtimeInstanceId: newId<string>("rtinst"),
      entityKey: contract.entityKey,
      entityId: entityRef.current.entityId,
      contract,
      bindings,
      getNode: () => nodeRef.current ?? null,
      ...(logicalParent ? { logicalParent } : {}),
    };
    trackLogicalInstance(kernel, infoRef.current);
  } else {
    const info = infoRef.current;
    info.contract = contract;
    info.bindings = bindings;
    if (logicalParentEntityKey) {
      const logicalParent = findLogicalParent(kernel, logicalParentEntityKey);
      if (logicalParent) info.logicalParent = logicalParent;
    }
  }
  const info = infoRef.current;

  // (b) Register the host DOM node with kernel.instances. Registration is
  // re-entrant: each ref invocation unregisters any previous registration
  // first, and the returned cleanup covers StrictMode double-mount, unmount,
  // and hot updates on both React 18 (ref(null)) and React 19 (ref cleanup).
  const unregisterRef = useRef<(() => void) | null>(null);
  const hostRef = useCallback(
    (node: HTMLElement | null) => {
      if (node) {
        unregisterRef.current?.();
        nodeRef.current = node;
        unregisterRef.current = kernel.instances.register(node, info);
        return () => {
          unregisterRef.current?.();
          unregisterRef.current = null;
        };
      }
      nodeRef.current = null;
      unregisterRef.current?.();
      unregisterRef.current = null;
      return undefined;
    },
    [kernel, info],
  );

  // (e) Subscribe to the data binding; re-render on revision change.
  const data = useDataSnapshot(bindings.data);

  // (c) Resolve the renderer for the preferred representation, falling back
  // through the contract's allowed representations.
  const preferred = preferredRepresentation ?? contract.allowedRepresentations[0];
  const candidates = [preferred, ...contract.allowedRepresentations.filter((id) => id !== preferred)];
  const rendererId = candidates.find((id) => renderers?.[id] !== undefined);
  const Active = rendererId !== undefined ? renderers?.[rendererId] : undefined;

  const properties = preferredProperties ?? {};

  return (
    <div data-ui-entity={contract.entityKey} data-ui-instance={instanceKey} ref={hostRef}>
      {Active ? (
        <Active
          contract={contract}
          data={data}
          actions={bindings.actions}
          state={bindings.state}
          properties={properties}
          instanceKey={instanceKey}
          onActionComplete={onActionComplete}
        />
      ) : (
        // (d) Canonical interface preserved when no renderer applies.
        (rendererOverride ?? children ?? null)
      )}
    </div>
  );
}

export type { RendererProps };
