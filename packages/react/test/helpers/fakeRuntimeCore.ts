/**
 * Minimal fakes of the runtime-core public API surface (spec section 6), so
 * the react adapter tests run independently of the real implementation.
 */
import { newId } from "@ui-intelligence/protocol";
import type {
  ActionBinding,
  DataBinding,
  EntityContract,
  PageContract,
  RuntimeManifest,
} from "@ui-intelligence/protocol";

export type FakeRuntimeInstanceInfo = {
  runtimeInstanceId: string;
  entityKey: string;
  entityId: string;
  contract: EntityContract;
  logicalParent?: FakeRuntimeInstanceInfo;
  bindings: { data: DataBinding; actions: Record<string, ActionBinding>; state?: unknown };
  getNode(): object | null;
};

export type FakeRendererDescriptor = {
  id: string;
  version: number;
  propertySchema: Record<string, unknown>;
  compatibleWith: (contract: EntityContract) => boolean;
  rendersFields?: string[];
};

export class FakeRendererRegistry {
  private descriptors = new Map<string, FakeRendererDescriptor>();

  register(d: FakeRendererDescriptor): void {
    this.descriptors.set(d.id, d);
  }

  get(id: string): FakeRendererDescriptor | undefined {
    return this.descriptors.get(id);
  }

  list(): FakeRendererDescriptor[] {
    return [...this.descriptors.values()];
  }

  listCompatible(contract: EntityContract): FakeRendererDescriptor[] {
    return this.list().filter((d) => d.compatibleWith(contract));
  }
}

export class FakeInstanceRegistry {
  private nodes = new WeakMap<object, FakeRuntimeInstanceInfo>();
  /** Total registration calls; useful for StrictMode leak assertions. */
  registrationCount = 0;

  register(node: object, info: FakeRuntimeInstanceInfo): () => void {
    this.registrationCount += 1;
    this.nodes.set(node, info);
    return () => {
      this.nodes.delete(node);
    };
  }

  resolve(node: object): FakeRuntimeInstanceInfo | null {
    return this.nodes.get(node) ?? null;
  }

  resolveFromEventPath(path: Array<EventTarget | null>): FakeRuntimeInstanceInfo | null {
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const target = path[i];
      if (target && this.nodes.has(target)) return this.nodes.get(target) ?? null;
    }
    return null;
  }
}

export class FakeRuntimeKernel {
  readonly renderers = new FakeRendererRegistry();
  readonly instances = new FakeInstanceRegistry();
  private entities = new Map<
    string,
    { contract: EntityContract; bindings: { data: DataBinding; actions: Record<string, ActionBinding>; state?: unknown } }
  >();

  registerEntity(
    contract: EntityContract,
    bindings: { data: DataBinding; actions: Record<string, ActionBinding>; state?: unknown },
  ): { entityId: string } {
    const existing = this.entities.get(contract.entityKey);
    if (existing) return { entityId: `entity_${contract.entityKey}` };
    this.entities.set(contract.entityKey, { contract, bindings });
    return { entityId: `entity_${contract.entityKey}` };
  }

  registerPage(_contract: PageContract): void {
    // not needed by the adapter tests
  }

  getEntity(entityKey: string):
    | { contract: EntityContract; bindings: { data: DataBinding; actions: Record<string, ActionBinding>; state?: unknown } }
    | undefined {
    return this.entities.get(entityKey);
  }

  manifest(): RuntimeManifest {
    throw new Error("FakeRuntimeKernel.manifest not implemented");
  }

  contractDigest(): string {
    return "fake-digest";
  }
}

/** Controlled data binding whose revision the test advances explicitly. */
export function makeControlledBinding(initial: import("@ui-intelligence/protocol").JsonValue) {
  let snapshot: import("@ui-intelligence/protocol").DataSnapshot = {
    revision: "rev-1",
    status: "ready",
    value: initial,
  };
  const listeners = new Set<() => void>();
  return {
    binding: {
      contract: { id: "catalog.products@1", version: 1, schemaDigest: "products" },
      getSnapshot: () => snapshot,
      subscribe(onChange: () => void) {
        listeners.add(onChange);
        return () => {
          listeners.delete(onChange);
        };
      },
    } satisfies DataBinding,
    update(value: import("@ui-intelligence/protocol").JsonValue, revision: string) {
      snapshot = { revision, status: "ready", value };
      for (const listener of listeners) listener();
    },
  };
}

export function makeInstanceInfo(
  overrides: Partial<FakeRuntimeInstanceInfo> = {},
): FakeRuntimeInstanceInfo {
  return {
    runtimeInstanceId: newId<string>("rtinst"),
    entityKey: "catalog.productChooser",
    entityId: "entity_catalog.productChooser",
    contract: {
      entityKey: "catalog.productChooser",
      contractVersion: 1,
      dataBinding: "catalog.products@1",
      allowedRepresentations: ["grid@1"],
      actions: [],
      requiredFields: [],
      stateFields: [],
      constraints: { preserveActions: true, preservePriceVisibility: false },
    },
    bindings: {
      data: makeControlledBinding([]).binding,
      actions: {},
    },
    getNode: () => null,
    ...overrides,
  };
}
