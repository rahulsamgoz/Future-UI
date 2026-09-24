/**
 * Registration of every approved renderer descriptor into a
 * runtime-core `RendererRegistry` (spec section 7: approved types only, each
 * with a versioned property schema).
 */
import type { RendererRegistry } from "@ui-intelligence/runtime-core";
import type { ComponentType } from "react";
import { buttonRenderers } from "./buttonRenderers.js";
import { productChooserRenderers } from "./productRenderers.js";
import type { RendererEntry, RendererProps } from "./types.js";

/** Registers every descriptor above; entity-scope renderers only. */
export function registerAllRenderers(registry: RendererRegistry): void {
  for (const entry of Object.values(productChooserRenderers)) {
    registry.register(entry.descriptor);
  }
  for (const entry of Object.values(buttonRenderers)) {
    registry.register(entry.descriptor);
  }
}

/** Merged component map keyed by renderer id (product chooser + buttons). */
export const rendererComponents: Record<string, ComponentType<RendererProps>> = Object.fromEntries(
  (Object.values(productChooserRenderers) as RendererEntry[])
    .concat(Object.values(buttonRenderers) as RendererEntry[])
    .map((entry) => [entry.descriptor.id, entry.component]),
);
