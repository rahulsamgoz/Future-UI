/**
 * Data subscription adapter (spec section 6): a data binding exposes a
 * consistent snapshot and notifies subscribers when its revision changes.
 *
 * `useSyncExternalStore` requires a stable snapshot identity between
 * notifications, while `getSnapshot()` may return a fresh object per call.
 * We therefore cache the snapshot by revision.
 */
import type { DataBinding, DataSnapshot } from "@ui-intelligence/protocol";
import { useCallback, useRef, useSyncExternalStore } from "react";

export function useDataSnapshot(binding: DataBinding): DataSnapshot {
  const cache = useRef<{ revision: string; snapshot: DataSnapshot } | null>(null);

  const subscribe = useCallback((onChange: () => void) => binding.subscribe(onChange), [binding]);

  const getSnapshot = useCallback(() => {
    const fresh = binding.getSnapshot();
    if (cache.current && cache.current.revision === fresh.revision) {
      return cache.current.snapshot;
    }
    cache.current = { revision: fresh.revision, snapshot: fresh };
    return fresh;
  }, [binding]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
