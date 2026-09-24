/**
 * Logical containment graph (spec section 6).
 *
 * The runtime keeps a separate logical containment graph alongside the
 * host-node WeakMap so selection can expand from an instance to its logical
 * ancestors. Parent resolution is per kernel and best effort: a child
 * mounted before its logical parent links to the parent once the parent's
 * boundary has registered at least one instance.
 *
 * Repeated instances of one entity key are each tracked (bounded per key);
 * when the child's host node is known, resolution prefers the tracked
 * instance whose node actually contains the child in the DOM, falling back
 * to the most recently tracked instance.
 */
import type { RuntimeInstanceInfo, RuntimeKernel } from "@ui-intelligence/runtime-core";

const instanceGraphs = new WeakMap<object, Map<string, RuntimeInstanceInfo[]>>();

/** Bounded per entity key: remounts would otherwise grow without limit. */
const MAX_TRACKED_PER_KEY = 16;

/** Record an instance per entity key for one kernel (most recent last). */
export function trackLogicalInstance(kernel: RuntimeKernel, info: RuntimeInstanceInfo): void {
  let graph = instanceGraphs.get(kernel);
  if (!graph) {
    graph = new Map();
    instanceGraphs.set(kernel, graph);
  }
  const tracked = (graph.get(info.entityKey) ?? []).filter(
    (candidate) => candidate.runtimeInstanceId !== info.runtimeInstanceId,
  );
  tracked.push(info);
  graph.set(
    info.entityKey,
    tracked.length > MAX_TRACKED_PER_KEY ? tracked.slice(tracked.length - MAX_TRACKED_PER_KEY) : tracked,
  );
}

function containsChild(instance: RuntimeInstanceInfo, childNode: Node): boolean {
  const node = instance.getNode() as Node | null;
  return node !== null && typeof node.contains === "function" && node.contains(childNode);
}

/**
 * Resolve the logical parent info for a child boundary, if registered. When
 * the child's host node is provided, prefer a tracked instance of the entity
 * key whose node contains the child in the DOM — repeated instances of one
 * entity key each own their own subtree. When containment cannot resolve the
 * ambiguity (e.g. the child has not attached its node yet), fall back to the
 * most recently tracked instance.
 */
export function findLogicalParent(
  kernel: RuntimeKernel,
  logicalParentEntityKey: string,
  childNode?: Node | null,
): RuntimeInstanceInfo | null {
  const tracked = instanceGraphs.get(kernel)?.get(logicalParentEntityKey);
  if (!tracked || tracked.length === 0) return null;
  if (childNode) {
    for (let i = tracked.length - 1; i >= 0; i -= 1) {
      const candidate = tracked[i]!;
      if (containsChild(candidate, childNode)) return candidate;
    }
  }
  return tracked[tracked.length - 1]!;
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
