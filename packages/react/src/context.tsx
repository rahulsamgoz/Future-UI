/**
 * React context for the runtime kernel (spec section 6).
 *
 * The kernel is injected by the host application; this adapter never
 * constructs one itself.
 */
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import type { RuntimeKernel } from "@ui-intelligence/runtime-core";
import { createContext, useContext } from "react";
import type { UiRuntimeProviderProps } from "./types.js";

export const UiRuntimeContext = createContext<RuntimeKernel | null>(null);

export function UiRuntimeProvider({ kernel, children }: UiRuntimeProviderProps) {
  return <UiRuntimeContext.Provider value={kernel}>{children}</UiRuntimeContext.Provider>;
}

/** Access the runtime kernel. Throws without a `<UiRuntimeProvider>` ancestor. */
export function useUiRuntime(): RuntimeKernel {
  const kernel = useContext(UiRuntimeContext);
  if (!kernel) {
    throw new UiIntelligenceError(
      "CAPABILITY_MISSING",
      "useUiRuntime requires a <UiRuntimeProvider> ancestor with a runtime kernel",
    );
  }
  return kernel;
}
