/**
 * Pure DAG helpers for dependsOn readiness (no scheduler I/O yet).
 */

export interface DagNode {
  id: string;
  dependsOn: string[];
}

export type CycleResult =
  | { ok: true }
  | { ok: false; cycle: string[] };

/** Detect a dependency cycle. Returns one cycle path (ids) when found. */
export function findCycle(nodes: DagNode[]): CycleResult {
  const byId = indexNodes(nodes);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const dfs = (id: string): string[] | null => {
    if (visited.has(id)) return null;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    visiting.add(id);
    stack.push(id);
    const node = byId.get(id);
    if (node) {
      for (const dep of node.dependsOn) {
        if (!byId.has(dep)) continue; // missing dep: not a cycle; scheduler may block later
        const c = dfs(dep);
        if (c) return c;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const n of nodes) {
    const c = dfs(n.id);
    if (c) return { ok: false, cycle: c };
  }
  return { ok: true };
}

/**
 * Task ids whose dependencies are all in `done` and that are not themselves done.
 * Order is stable: input order among ready nodes.
 */
export function readyIds(
  nodes: DagNode[],
  done: ReadonlySet<string>,
): string[] {
  const cycle = findCycle(nodes);
  if (!cycle.ok) {
    throw new Error(`DAG has a cycle: ${cycle.cycle.join(" → ")}`);
  }

  const ids = new Set(nodes.map((n) => n.id));
  const ready: string[] = [];
  for (const n of nodes) {
    if (done.has(n.id)) continue;
    const depsOk = n.dependsOn.every((d) => done.has(d));
    if (!depsOk) continue;
    // Unknown dep outside the graph: not ready
    const unknown = n.dependsOn.filter((d) => !ids.has(d) && !done.has(d));
    if (unknown.length) continue;
    ready.push(n.id);
  }
  return ready;
}

/** Topological order (Kahn). Throws if cycle or unknown dependency inside edges. */
export function topologicalOrder(nodes: DagNode[]): string[] {
  const cycle = findCycle(nodes);
  if (!cycle.ok) {
    throw new Error(`DAG has a cycle: ${cycle.cycle.join(" → ")}`);
  }

  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    for (const d of n.dependsOn) {
      if (!ids.has(d)) {
        throw new Error(`unknown dependency: ${n.id} dependsOn ${d}`);
      }
    }
  }

  const indeg = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    children.set(n.id, []);
  }
  for (const n of nodes) {
    for (const d of n.dependsOn) {
      children.get(d)!.push(n.id);
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
    }
  }

  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const next = (indeg.get(child) ?? 1) - 1;
      indeg.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  if (order.length !== nodes.length) {
    throw new Error("DAG topological sort incomplete (cycle?)");
  }
  return order;
}

function indexNodes(nodes: DagNode[]): Map<string, DagNode> {
  const m = new Map<string, DagNode>();
  for (const n of nodes) {
    if (m.has(n.id)) throw new Error(`duplicate dag node id: ${n.id}`);
    m.set(n.id, n);
  }
  return m;
}
