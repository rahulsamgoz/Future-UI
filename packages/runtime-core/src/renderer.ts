/**
 * Approved presentation types with versioned property schemas (architecture
 * sections 6-7). A renderer descriptor is declarative data plus one pure
 * compatibility predicate — it never carries executable UI code.
 */
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import type { EntityContract } from "@ui-intelligence/protocol";

export type RendererPropertySchema = {
  type: "number" | "string" | "boolean" | "enum";
  /** For enum-typed properties: the complete set of allowed values. */
  values?: (number | string)[];
  /** For number-typed properties: inclusive bounds. */
  min?: number;
  max?: number;
  default?: unknown;
};

export type RendererDescriptor = {
  /** Versioned renderer id, e.g. `grid@1`. */
  id: string;
  version: number;
  propertySchema: Record<string, RendererPropertySchema>;
  /**
   * Optional declaration of the data fields this renderer actually renders.
   * When present, the proposal validator can check it against
   * `contract.requiredFields`; when absent the `required_fields` invariant is
   * recorded as unsupported instead of enforced.
   */
  rendersFields?: string[];
  /** Pure predicate: can this renderer present the given entity contract? */
  compatibleWith: (contract: EntityContract) => boolean;
};

export class RendererRegistry {
  #renderers = new Map<string, RendererDescriptor>();

  register(descriptor: RendererDescriptor): void {
    if (this.#renderers.has(descriptor.id)) {
      throw new UiIntelligenceError(
        "SCHEMA_INVALID",
        `renderer "${descriptor.id}" is already registered`,
      );
    }
    this.#renderers.set(descriptor.id, descriptor);
  }

  /**
   * Unknown required ids are a capability error: callers that require a
   * specific renderer (validation of a proposal that references it) surface
   * CAPABILITY_MISSING.
   */
  get(id: string): RendererDescriptor {
    const descriptor = this.#renderers.get(id);
    if (!descriptor) {
      throw new UiIntelligenceError(
        "CAPABILITY_MISSING",
        `renderer "${id}" is not registered`,
      );
    }
    return descriptor;
  }

  list(): RendererDescriptor[] {
    return [...this.#renderers.values()];
  }

  listCompatible(contract: EntityContract): RendererDescriptor[] {
    return this.list().filter((d) => d.compatibleWith(contract));
  }
}
