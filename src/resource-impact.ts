import type { BgpSession, Inventory } from "../packages/contracts/src/inventory.js";

export interface NodeScopedResource {
  nodeId: string | null;
}

type ResourceImpactInventory = Pick<Inventory, "nodes" | "sessions">;

function scopeNodeIds(state: ResourceImpactInventory, resource: NodeScopedResource | null | undefined): string[] {
  if (!resource || resource.nodeId === null) return state.nodes.map((node) => node.id);
  return [resource.nodeId];
}

export function uniqueNodeIds(...groups: ReadonlyArray<ReadonlyArray<string | null | undefined>>): string[] {
  return [...new Set(groups.flat().filter((value): value is string => Boolean(value)))];
}

export function resourceNodeIds(state: ResourceImpactInventory, resource: NodeScopedResource | null | undefined): string[] {
  return scopeNodeIds(state, resource);
}

export function resourceChangeNodeIds(
  state: ResourceImpactInventory,
  previous: NodeScopedResource | null | undefined,
  updated: NodeScopedResource | null | undefined = previous,
): string[] {
  return uniqueNodeIds(scopeNodeIds(state, previous), scopeNodeIds(state, updated));
}

export function resourceChangeSessions(
  state: ResourceImpactInventory,
  nodeIds: ReadonlyArray<string | null | undefined>,
): BgpSession[] {
  const ids = new Set(uniqueNodeIds(nodeIds));
  return state.sessions.filter((session) => ids.has(session.nodeId));
}
