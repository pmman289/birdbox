function compatibleWithScope(resource, nodeId) {
  return resource.nodeId === null || (nodeId !== null && resource.nodeId === nodeId);
}

function enabledCompatibleResources(resources, nodeId, currentId) {
  return (resources ?? []).filter((resource) =>
    resource.enabled && resource.id !== currentId && compatibleWithScope(resource, nodeId),
  );
}

export function availablePolicySourceReferences({ inventory, collection, currentId = "", nodeId = null }) {
  const defines = enabledCompatibleResources(inventory?.defines, nodeId, currentId);
  const currentDefineIndex = (inventory?.defines ?? []).findIndex((resource) => resource.id === currentId);
  const orderedDefines = collection === "defines" && currentDefineIndex >= 0
    ? defines.filter((resource) => inventory.defines.indexOf(resource) < currentDefineIndex)
    : defines;

  if (collection !== "functions" && collection !== "filters") {
    return { defines: orderedDefines, functions: [] };
  }

  const functions = enabledCompatibleResources(inventory?.functions, nodeId, currentId);
  const currentFunctionIndex = (inventory?.functions ?? []).findIndex((resource) => resource.id === currentId);
  const orderedFunctions = collection === "functions" && currentFunctionIndex >= 0
    ? functions.filter((resource) => inventory.functions.indexOf(resource) < currentFunctionIndex)
    : functions;
  return { defines: orderedDefines, functions: orderedFunctions };
}

export function policySourceReferenceInsertion(resource, kind) {
  if (kind === "function" && resource.callable) return `${resource.name}()`;
  return resource.name;
}
