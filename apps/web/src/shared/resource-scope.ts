import { scopedNodeIds, type NodeScopedResource } from "../../../../packages/contracts/src/resource-scope";

export function resourceScopeLabel(
  resource: NodeScopedResource,
  nodeNames: ReadonlyMap<string, string>,
  fallback = "未知节点",
): string {
  const nodeIds = scopedNodeIds(resource);
  if (nodeIds === null) return "所有节点";
  return nodeIds.map((nodeId) => nodeNames.get(nodeId) ?? nodeId ?? fallback).join("、");
}

export function resourceScopeShortLabel(resource: NodeScopedResource, currentNodeId: string | null = null): string {
  const nodeIds = scopedNodeIds(resource);
  if (nodeIds === null) return "所有节点";
  if (currentNodeId !== null && nodeIds.length === 1 && nodeIds[0] === currentNodeId) return "当前节点";
  return `${nodeIds.length} 个节点`;
}

export function resourceScopeCompactLabel(
  resource: NodeScopedResource,
  nodeNames: ReadonlyMap<string, string>,
): string {
  const nodeIds = scopedNodeIds(resource);
  if (nodeIds === null) return "所有节点";
  if (nodeIds.length === 1) return nodeNames.get(nodeIds[0] ?? "") ?? nodeIds[0] ?? "未知节点";
  return `${nodeIds.length} 个节点`;
}
