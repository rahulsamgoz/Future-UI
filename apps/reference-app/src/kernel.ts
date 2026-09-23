import { InstanceRegistry, RendererRegistry, RuntimeKernel } from "@ui-intelligence/runtime-core";
import type { RendererProps } from "@ui-intelligence/react";
import type { ComponentType } from "react";
import { registerAllRenderers } from "@ui-intelligence/renderers";
import { getBuildId } from "./build.js";
import {
  adminPanelContract,
  buttonContract,
  productChooserContract,
  profileFormContract,
  relatedProductsContract,
  sortControlContract,
  transactionListContract,
} from "./contracts.js";
import { appRendererDescriptors, appRendererComponents } from "./renderers/index.js";
import { rendererComponents } from "@ui-intelligence/renderers";

/**
 * The runtime kernel: registered capabilities and approved renderers.
 * The manifest contains references, not serialized executable functions.
 */
export function createAppKernel(): RuntimeKernel {
  const kernel = new RuntimeKernel(new RendererRegistry(), new InstanceRegistry(), {
    buildId: getBuildId(),
  });
  registerAllRenderers(kernel.renderers);
  const registeredIds = new Set(kernel.renderers.list().map((d) => d.id));
  for (const descriptor of appRendererDescriptors) {
    // Button presentations ship with the renderers package; skip duplicates.
    if (registeredIds.has(descriptor.id)) continue;
    kernel.renderers.register(descriptor);
  }
  return kernel;
}

/** Full renderer component map: approved package renderers + app-owned presentations. */
export function appRendererMap(): Record<string, ComponentType<RendererProps>> {
  return { ...rendererComponents, ...appRendererComponents };
}

export {
  adminPanelContract,
  buttonContract,
  productChooserContract,
  profileFormContract,
  relatedProductsContract,
  sortControlContract,
  transactionListContract,
};
