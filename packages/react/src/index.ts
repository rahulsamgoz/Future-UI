/**
 * @ui-intelligence/react — React adapter for semantic boundaries
 * (UI Intelligence R1, spec section 6).
 */
export { UiRuntimeContext, UiRuntimeProvider, useUiRuntime } from "./context.js";
export { UiBoundary } from "./UiBoundary.js";
export {
  transferState,
  useRendererState,
  useSelection,
} from "./hooks.js";
export type { RendererStateHandle } from "./hooks.js";
export { findLogicalParent, getLogicalAncestors, trackLogicalInstance } from "./logical.js";
export type { UiBindings, UiBoundaryProps, UiRuntimeProviderProps } from "./types.js";
export type { RendererProps } from "./types.js";
export { useDataSnapshot } from "./useDataSnapshot.js";
