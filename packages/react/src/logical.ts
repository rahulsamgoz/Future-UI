/**
 * Logical containment graph (spec section 6).
 *
 * The runtime keeps a separate logical containment graph alongside the
 * host-node WeakMap so selection can expand from an instance to its logical
 * ancestors. Parent resolution is per kernel and best effort: a child
 * mounted before its logical parent links to the parent once the parent's
 * boundary has registered at least one instance.
 */
import type { RuntimeInstanceInfo, RuntimeKernel } from "@ui-intelligence/runtime-core";

const instanceGraphs = new WeakMap<object, Map<string, RuntimeInstanceInfo>>();

/** Record the most recent instance info per entity key for one kernel. */
export function trackLogicalInstance(kernel: RuntimeKernel, info: RuntimeInstanceInfo): void {
  let graph = instanceGraphs.get(kernel);
  if (!graph) {
    graph = new Map();
    instanceGraphs.set(kernel, graph);
  }
  graph.set(info.entityKey, info);
}

/** Resolve the logical parent info for a child boundary, if registered. */
export function findLogicalParent(
  kernel: RuntimeKernel,
  logicalParentEntityKey: string,
): RuntimeInstanceInfo | null {
  return instanceGraphs.get(kernel)?.get(logicalParentEntityKey) ?? null;
}

/** Walk the logical containment chain from an instance to the root. */
export function getLogicalAncestors(info: RuntimeInstanceInfo): RuntimeInstanceInfo[] {
  const ancestors: RuntimeInstanceInfo[] = [];
  const seen = new Set<string>([info.runtimeInstanceId]);
  let current = info.logicalParent;
  while (current) {
    if (seen.has(current.runtimeInstanceId)) break; // defensive: cycle guard
    seen.add(current.runtimeInstanceId);
    ancestors.push(current);
    current = current.logicalParent;
  }
  return ancestors;
}
