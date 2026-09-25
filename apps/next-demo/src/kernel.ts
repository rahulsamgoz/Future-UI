/**
 * The Next.js demo's runtime kernel (architecture section 6): the same
 * runtime-core kernel and approved renderer registry the Vite reference app
 * uses. Created client-side (useMemo in the "use client" page) — the kernel
 * and registries are browser runtime state, not server state.
 */
import { InstanceRegistry, RendererRegistry, RuntimeKernel } from "@ui-intelligence/runtime-core";
import { registerAllRenderers, rendererComponents } from "@ui-intelligence/renderers";
import type { ComponentType } from "react";
import type { RendererProps } from "@ui-intelligence/react";

export const NEXT_DEMO_BUILD_ID = "next-demo@1.0.0";

export function createDemoKernel(): RuntimeKernel {
  const kernel = new RuntimeKernel(new RendererRegistry(), new InstanceRegistry(), {
    buildId: NEXT_DEMO_BUILD_ID,
  });
  registerAllRenderers(kernel.renderers);
  return kernel;
}

/** Approved renderer components keyed by representation id. */
export function demoRendererMap(): Record<string, ComponentType<RendererProps>> {
  return rendererComponents;
}
