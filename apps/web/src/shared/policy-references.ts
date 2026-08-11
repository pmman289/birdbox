import type { PolicyCollection } from "@birdbox/contracts/inventory";
import {
  resourceScopeContains,
  type MultiNodeScopedResource,
  type NodeScopedResource,
} from "../../../../packages/contracts/src/resource-scope";

export interface PolicyReferenceResource {
  id: string;
  nodeIds: string[] | null;
  name: string;
  enabled: boolean;
  callable?: boolean;
}

export interface PolicyReferenceInventory {
  defines?: PolicyReferenceResource[];
  functions?: PolicyReferenceResource[];
}

export interface AvailablePolicyReferenceInput {
  inventory?: PolicyReferenceInventory | null;
  collection: PolicyCollection;
  currentId?: string;
  nodeId?: string | null;
  nodeIds?: string[] | null;
}

export interface AvailablePolicyReferences {
  defines: PolicyReferenceResource[];
  functions: PolicyReferenceResource[];
}

function compatibleWithScope(resource: PolicyReferenceResource, consumer: NodeScopedResource): boolean {
  return resourceScopeContains(resource, consumer);
}

function enabledCompatibleResources(
  resources: PolicyReferenceResource[] | null | undefined,
  consumer: NodeScopedResource,
  currentId: string,
): PolicyReferenceResource[] {
  return (resources ?? []).filter((resource) =>
    resource.enabled && resource.id !== currentId && compatibleWithScope(resource, consumer),
  );
}

export function availablePolicySourceReferences({
  inventory,
  collection,
  currentId = "",
  nodeId = null,
  nodeIds,
}: AvailablePolicyReferenceInput): AvailablePolicyReferences {
  const consumer: NodeScopedResource = nodeIds === undefined ? { nodeId } : { nodeIds } satisfies MultiNodeScopedResource;
  const inventoryDefines = inventory?.defines ?? [];
  const defines = enabledCompatibleResources(inventoryDefines, consumer, currentId);
  const currentDefineIndex = inventoryDefines.findIndex((resource) => resource.id === currentId);
  const orderedDefines = collection === "defines" && currentDefineIndex >= 0
    ? defines.filter((resource) => inventoryDefines.indexOf(resource) < currentDefineIndex)
    : defines;

  if (collection !== "functions" && collection !== "filters") {
    return { defines: orderedDefines, functions: [] };
  }

  const inventoryFunctions = inventory?.functions ?? [];
  const functions = enabledCompatibleResources(inventoryFunctions, consumer, currentId);
  const currentFunctionIndex = inventoryFunctions.findIndex((resource) => resource.id === currentId);
  const orderedFunctions = collection === "functions" && currentFunctionIndex >= 0
    ? functions.filter((resource) => inventoryFunctions.indexOf(resource) < currentFunctionIndex)
    : functions;
  return { defines: orderedDefines, functions: orderedFunctions };
}

export function policySourceReferenceInsertion(resource: PolicyReferenceResource, kind: "define" | "function"): string {
  if (kind === "function" && resource.callable) return `${resource.name}()`;
  return resource.name;
}
