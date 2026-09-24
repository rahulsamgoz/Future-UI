/**
 * Host-node instance registry (architecture section 6). A WeakMap maps host
 * nodes to their runtime instance info; logical ownership (portals,
 * fragments) is expressed through `RuntimeInstanceInfo.logicalParent`, which
 * the framework adapter sets.
 */
import type {
  ActionBinding,
  DataBinding,
  EntityContract,
  StateAdapter,
} from "@ui-intelligence/protocol";

export type RuntimeInstanceInfo = {
  runtimeInstanceId: string;
  entityKey: string;
  entityId: string;
  contract: EntityContract;
  logicalParent?: RuntimeInstanceInfo;
  bindings: {
    data: DataBinding;
    actions: Record<string, ActionBinding>;
    state?: StateAdapter;
  };
  getNode(): object | null;
};

export class InstanceRegistry {
  #instances = new WeakMap<object, RuntimeInstanceInfo>();

  /** Register a host node; the returned function unregisters it (idempotent for this node/info pair). */
  register(node: object, info: RuntimeInstanceInfo): () => void {
    this.#instances.set(node, info);
    return () => {
      if (this.#instances.get(node) === info) {
        this.#instances.delete(node);
      }
    };
  }

  /** Resolve the instance registered for exactly this host node, if any. */
  resolve(node: object | null | undefined): RuntimeInstanceInfo | null {
    if (!node || (typeof node !== "object" && typeof node !== "function")) return null;
    return this.#instances.get(node) ?? null;
  }

  /**
   * Walk the event's composed path from the innermost target outward and
   * resolve the nearest registered instance. Portals follow logical
   * ownership: the framework adapter links portal roots to their logical
   * ancestor via `logicalParent`, so the ancestor's host node appears on the
   * composed path (or the caller can resolve the logical parent from the
   * returned info).
   */
  resolveFromEventPath(path: Array<EventTarget | null>): RuntimeInstanceInfo | null {
    for (const entry of path) {
      const resolved = this.resolve(entry as object | null);
      if (resolved) return resolved;
    }
    return null;
  }
}
