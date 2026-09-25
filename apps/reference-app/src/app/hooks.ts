import { useEffect, useState, useSyncExternalStore } from "react";
import type { JsonValue, RuleEvaluationContext } from "@ui-intelligence/protocol";
import { RuleEngine } from "@ui-intelligence/runtime-core";
import { useAppServices } from "../Services.js";
import { allEntityContracts } from "../contracts.js";
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

export type ResolvedRepresentation = {
  representation: string;
  properties: Record<string, JsonValue>;
  /** Where the decision came from: explicit preference, matching rule, or contract default. */
  source: "preference" | "rule" | "default";
};

const contractByKey = new Map(allEntityContracts.map((c) => [c.entityKey, c]));

function currentRoute(): string {
  if (typeof window === "undefined") return "catalog";
  const route = window.location.hash.replace(/^#\/?/, "");
  return route.startsWith("account") ? "account" : "catalog";
}

function currentViewportClass(): "desktop" | "mobile" {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "desktop";
  return window.matchMedia("(max-width: 640px)").matches ? "mobile" : "desktop";
}

/** Route + viewport class, refreshed on hashchange / media-query change. */
function useRuleEnvironment(): { route: string; viewportClass: "desktop" | "mobile" } {
  const [env, setEnv] = useState(() => ({
    route: currentRoute(),
    viewportClass: currentViewportClass(),
  }));
  useEffect(() => {
    const update = () =>
      setEnv({ route: currentRoute(), viewportClass: currentViewportClass() });
    window.addEventListener("hashchange", update);
    const mq =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(max-width: 640px)")
        : null;
    mq?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener("hashchange", update);
      mq?.removeEventListener?.("change", update);
    };
  }, []);
  return env;
}

/**
 * Resolve the representation for one entity (and optional instance) with the
 * full precedence chain (R2 part C): explicit active preference > matching
 * semantic rule > contract default. Properties come from the explicit
 * preference; a matching rule applies its own properties; the default
 * renders with no overrides. Rules are hints — an explicit preference always
 * wins.
 */
export function useResolvedRepresentation(
  entityKey: string,
  instanceKey?: string,
): ResolvedRepresentation | null {
  const { preferences } = useAppServices();
  // Re-read whenever preferences OR rules change (setRules bumps the store).
  useSyncExternalStore(preferences.active.subscribe, preferences.active.getVersion);
  const explicit = useActivePreferenceFor(entityKey, instanceKey);
  const env = useRuleEnvironment();
  const contract = contractByKey.get(entityKey);
  if (!contract) {
    // Unregistered entity: only the explicit preference can be honored.
    return explicit
      ? { representation: explicit.representation, properties: explicit.properties, source: "preference" }
      : null;
  }
  const ctx: RuleEvaluationContext = {
    route: env.route,
    viewportClass: env.viewportClass,
    entityKey,
  };
  const match = preferences.rules.evaluate(ctx, contract);
  const representation = RuleEngine.resolveRepresentation(
    explicit?.representation ?? null,
    preferences.rules,
    ctx,
    contract,
  );
  const source: ResolvedRepresentation["source"] = explicit
    ? "preference"
    : match && representation === match.representation
      ? "rule"
      : "default";
  return {
    representation,
    properties: explicit?.properties ?? (source === "rule" ? match!.properties : {}),
    source,
  };
}
