import type { Topology } from './types';

/** Whether adding fromId → toId would introduce a directed cycle. */
export function wouldCreateCycle(topology: Topology, fromId: string, toId: string): boolean {
  if (fromId === toId) return true;
  const visited = new Set<string>();
  const pending = [toId];
  while (pending.length) {
    const node = pending.pop()!;
    if (node === fromId) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const edge of topology.edges) {
      if (edge.sourceNodeId === node) pending.push(edge.targetNodeId);
    }
  }
  return false;
}
