/**
 * Shared types for the React adapter (spec section 6).
 *
 * `RendererProps` is the shape consumed by the renderers package. The
 * renderers package declares the identical structure (it does not depend on
 * this package); the two are structurally compatible.
 */
import type { ActionBinding, DataBinding, DataSnapshot, EntityContract, JsonValue, StateAdapter } from "@ui-intelligence/protocol";
import type { RuntimeKernel } from "@ui-intelligence/runtime-core";
import type { ComponentType, ReactNode } from "react";

/**
 * Props handed to a registered renderer component. The parent boundary owns
 * the data subscription; `data` is the current consistent snapshot.
 */
export type RendererProps<T = JsonValue> = {
  contract: EntityContract;
  data: DataSnapshot;
  actions: Record<string, ActionBinding>;
  state?: StateAdapter;
  properties: Record<string, JsonValue>;
  instanceKey?: string;
  onActionComplete?: () => void;
};

export type UiBindings = {
  data: DataBinding;
  actions: Record<string, ActionBinding>;
  state?: StateAdapter;
};

export type UiBoundaryProps = {
  contract: EntityContract;
  bindings: UiBindings;
  /** Stable developer-declared instance identity (optional). */
  instanceKey?: string;
  /** Entity key of the logically containing boundary, for ancestor expansion. */
  logicalParentEntityKey?: string;
  /** Preferred representation from the active preference, e.g. "grid@1". */
  preferredRepresentation?: string;
  /** Properties from the active preference specification (default {}). */
  preferredProperties?: Record<string, JsonValue>;
  /** Renderer components keyed by representation id, e.g. "grid@1". */
  renderers?: Record<string, ComponentType<RendererProps>>;
  /** Canonical app UI rendered when no renderer applies. */
  rendererOverride?: ReactNode;
  children?: never;
  onActionComplete?: () => void;
};

export type UiRuntimeProviderProps = {
  kernel: RuntimeKernel;
  children: ReactNode;
};
