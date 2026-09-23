/**
 * Selection and state-transfer helpers (spec sections 6 and 7).
 */
import type { JsonValue, StateAdapter } from "@ui-intelligence/protocol";
import type { RuntimeInstanceInfo } from "@ui-intelligence/runtime-core";
import { useMemo } from "react";
import { useUiRuntime } from "./context.js";

/**
 * Selection walks the event's composed path and resolves the nearest
 * registered instance; the user can then expand to logical ancestors.
 */
export function useSelection(): {
  selectFromEvent(e: { composedPath(): Array<EventTarget | null> }): RuntimeInstanceInfo | null;
  selectNode(node: object): RuntimeInstanceInfo | null;
} {
  const kernel = useUiRuntime();
  return useMemo(
    () => ({
      selectFromEvent(e: { composedPath(): Array<EventTarget | null> }) {
        return kernel.instances.resolveFromEventPath(e.composedPath());
      },
      selectNode(node: object) {
        return kernel.instances.resolve(node);
      },
    }),
    [kernel],
  );
}

export type RendererStateHandle = {
  canSwitch(): { allowed: true } | { allowed: false; reason: string };
  exportState(): JsonValue;
  importState(state: JsonValue): void;
  adapter: StateAdapter | undefined;
};

/** Expose a state adapter's declared switch capabilities to the coordinator. */
export function useRendererState(stateAdapter?: StateAdapter): RendererStateHandle {
  return useMemo(() => {
    const canSwitch = () =>
      stateAdapter
        ? stateAdapter.canSwitch()
        : ({ allowed: false, reason: "No state adapter registered for this boundary" } as const);
    return {
      canSwitch,
      exportState: () => (stateAdapter ? stateAdapter.exportState() : null),
      importState: (state: JsonValue) => {
        if (stateAdapter) stateAdapter.importState(state);
      },
      adapter: stateAdapter,
    };
  }, [stateAdapter]);
}

/**
 * Transfer declared state from a source adapter to a destination renderer's
 * adapter: export (or accept pre-exported `state`), validate against the
 * destination, then import. Returns false when either side is missing or the
 * destination rejects the state; the previous state stays untouched then.
 */
export function transferState(
  source: StateAdapter | undefined,
  destination: StateAdapter | undefined,
  state: JsonValue | null | undefined,
  destinationRenderer: string,
): boolean {
  if (!source || !destination) return false;
  const exported = state === undefined || state === null ? source.exportState() : state;
  if (!destination.validateState(exported, destinationRenderer)) return false;
  destination.importState(exported);
  return true;
}
