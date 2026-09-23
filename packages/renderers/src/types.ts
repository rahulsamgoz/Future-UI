/**
 * Shared renderer prop shapes.
 *
 * The renderers package consumes `RendererProps` from the React adapter
 * boundary. It is declared here (identical structure to
 * `@ui-intelligence/react`'s `RendererProps`) because this package does not
 * depend on the adapter; the two are structurally compatible.
 *
 * `RendererDescriptor` / `RendererRegistry` are imported as types only from
 * runtime-core; descriptors registered here are plain data with one predicate.
 */
import type { ActionBinding, DataSnapshot, EntityContract, JsonValue, LayoutNode, StateAdapter } from "@ui-intelligence/protocol";
import type { RendererDescriptor } from "@ui-intelligence/runtime-core";
import type { ComponentType, ReactNode } from "react";

export type RendererProps<T = JsonValue> = {
  contract: EntityContract;
  data: DataSnapshot;
  actions: Record<string, ActionBinding>;
  state?: StateAdapter;
  properties: Record<string, JsonValue>;
  instanceKey?: string;
  onActionComplete?: () => void;
};

/** Props for recursive page layout renderers (spec section 7). */
export type LayoutRendererProps = {
  node: LayoutNode;
  renderRegion: (region: Extract<LayoutNode, { kind: "region" }>) => ReactNode;
};

export type RendererEntry = {
  component: ComponentType<RendererProps>;
  descriptor: RendererDescriptor;
};
