/**
 * Preview safety stubs (spec sections 6 and 18).
 *
 * Preview environments install stub action bindings and controlled data
 * providers. Preview actions cannot charge, submit, or modify live records,
 * and generating or accepting a layout invokes no business action.
 */
import { newId } from "@ui-intelligence/protocol";
import type { ActionBinding, DataBinding, JsonValue } from "@ui-intelligence/protocol";
import { sampleProducts, type ProductView } from "./products.js";

export type StubActionCall = { actionId: string; input: JsonValue };

/**
 * Action bindings that never perform live mutations: invocations are recorded
 * on the returned object's `calls` array (cast-friendly) and always resolve
 * successfully.
 */
export function createStubActionBindings(
  actionIds: string[],
): Record<string, ActionBinding> & { calls: StubActionCall[] } {
  const calls: StubActionCall[] = [];
  const bindings: Record<string, ActionBinding> = {};
  for (const actionId of actionIds) {
    bindings[actionId] = {
      contract: { id: actionId, version: 1, schemaDigest: `stub:${actionId}` },
      async invoke(input: JsonValue) {
        calls.push({ actionId, input });
        return { status: "succeeded", value: null } as const;
      },
    };
  }
  return Object.assign(bindings, { calls });
}

/** Static, ready data binding with a no-op subscribe. */
export function createControlledDataProvider(
  value: JsonValue,
  revision = "controlled-1",
): DataBinding {
  return {
    contract: { id: "controlled.data@1", version: 1, schemaDigest: "controlled" },
    getSnapshot: () => ({ revision, status: "ready", value }),
    subscribe: () => () => undefined,
  };
}

/** Synthetic product fixture binding for tests and previews. */
export function createFixtureProductData(
  products: ProductView[],
  revision = "fixture-1",
): DataBinding {
  return createControlledDataProvider(products as unknown as JsonValue, revision);
}

/** Convenience fixture binding over the built-in sample products. */
export function createSampleProductData(revision?: string): DataBinding {
  return createFixtureProductData(sampleProducts, revision);
}

/** Invocation ID helper for hosts that need one outside `invoke`. */
export function nextInvocationId(): string {
  return newId<string>("inv");
}
