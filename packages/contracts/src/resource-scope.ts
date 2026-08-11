export interface SingleNodeScopedResource {
  nodeId: string | null;
}

export interface MultiNodeScopedResource {
  nodeIds: readonly string[] | null;
}

export type NodeScopedResource = SingleNodeScopedResource | MultiNodeScopedResource;

export function isMultiNodeScopedResource(resource: NodeScopedResource): resource is MultiNodeScopedResource {
  return "nodeIds" in resource;
}

export function scopedNodeIds(resource: NodeScopedResource): readonly string[] | null {
  if (isMultiNodeScopedResource(resource)) return resource.nodeIds;
  return resource.nodeId === null ? null : [resource.nodeId];
}

export function resourceAppliesToNode(resource: NodeScopedResource, nodeId: string): boolean {
  const nodeIds = scopedNodeIds(resource);
  return nodeIds === null || nodeIds.includes(nodeId);
}

export function resourceExplicitlyScopesNode(resource: NodeScopedResource, nodeId: string): boolean {
  return scopedNodeIds(resource)?.includes(nodeId) ?? false;
}

export function resourceSingleNodeId(resource: NodeScopedResource): string | null {
  const nodeIds = scopedNodeIds(resource);
  return nodeIds?.length === 1 ? (nodeIds[0] ?? null) : null;
}

export function resourceScopeContains(provider: NodeScopedResource, consumer: NodeScopedResource): boolean {
  const providerNodeIds = scopedNodeIds(provider);
  if (providerNodeIds === null) return true;
  const consumerNodeIds = scopedNodeIds(consumer);
  if (consumerNodeIds === null) return false;
  const available = new Set(providerNodeIds);
  return consumerNodeIds.every((nodeId) => available.has(nodeId));
}
