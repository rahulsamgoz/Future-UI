import { useSyncExternalStore } from "react";
import { useAppServices } from "../Services.js";
import type { ActivePreference } from "./ActivePreferenceStore.js";

/** Subscribe to the active personal preference for one scope key. */
export function useActivePreference(scopeKey: string): ActivePreference | null {
  const { preferences } = useAppServices();
  useSyncExternalStore(preferences.active.subscribe, preferences.active.getVersion);
  return preferences.active.get(scopeKey);
}

/**
 * Resolve the active preference with deterministic precedence: stable
 * instance scope first, then entity scope (protocol section 9).
 */
export function useActivePreferenceFor(entityKey: string, instanceKey?: string): ActivePreference | null {
  const { preferences } = useAppServices();
  useSyncExternalStore(preferences.active.subscribe, preferences.active.getVersion);
  if (instanceKey) {
    const instancePref = preferences.active.get(`${entityKey}#${instanceKey}`);
    if (instancePref) return instancePref;
  }
  return preferences.active.get(entityKey);
}
