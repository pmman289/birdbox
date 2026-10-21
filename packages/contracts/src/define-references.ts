import type { ChannelPolicy, Inventory, PolicyCollection, PolicyDefine, PolicyFunction, PolicyFilter } from "./inventory.js";
import { birdSourceReferencesSymbol } from "./bird-source-identifiers.js";
import { resourceScopeContains, type NodeScopedResource } from "./resource-scope.js";

export interface DefineReference {
  kind: "defines" | "functions" | "filters" | "sessions" | "statics" | "sourcePolicies" | "ospf" | "kernels" | "pipes";
  id: string;
  label: string;
  nodeIds: string[] | null;
  via: string[];
}

// Shared by the list, editor and server preview. Each consumer is counted once;
// indirect consumers remain visible when a Define is used through a policy.
export function defineReferences(inventory: Inventory, define: PolicyDefine): DefineReference[] {
  return policyResourceReferences(inventory, define, "defines");
}

export function policyResourceReferences(inventory: Inventory, define: PolicyDefine | PolicyFunction | PolicyFilter, rootKind: PolicyCollection): DefineReference[] {
  const result = new Map<string, DefineReference>();
  const symbols = new Map([[`${rootKind}:${define.id}`, { name: define.name, path: [] as string[], scope: define as NodeScopedResource }]]);
  const defineIds = new Map<string, string[]>(rootKind === "defines" ? [[define.id, []]] : []);
  const functions = new Map<string, string[]>(rootKind === "functions" ? [[define.id, []]] : []), filters = new Map<string, string[]>(rootKind === "filters" ? [[define.id, []]] : []);
  const sourcePath = (source: unknown, scope: NodeScopedResource): string[] | undefined => {
    for (const provider of symbols.values()) if (resourceScopeContains(provider.scope, scope) && birdSourceReferencesSymbol(source, provider.name)) return provider.path;
  };
  const add = (kind: DefineReference["kind"], resource: { id: string; label?: string; name?: string; nodeIds?: string[] | null; nodeId?: string }, via: string[]) => {
    result.set(`${kind}:${resource.id}`, { kind, id: resource.id, label: resource.label ?? resource.name ?? resource.id, nodeIds: resource.nodeIds === undefined ? resource.nodeId ? [resource.nodeId] : null : resource.nodeIds, via });
  };
  // Fixed point also handles an inventory with declarations in a different order.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [kind, resources] of [["defines", inventory.defines], ["functions", inventory.functions], ["filters", inventory.filters]] as const) {
      for (const resource of resources) {
        if ((kind === rootKind && resource.id === define.id) || result.has(`${kind}:${resource.id}`)) continue;
        const path = sourcePath("source" in resource ? resource.source : resource.type === "expression" ? resource.value : "", resource);
        if (!path) continue;
        add(kind, resource, path); changed = true;
        const next = [...path, resource.label ?? resource.name];
        if (kind === "defines") { symbols.set(`${kind}:${resource.id}`, { name: resource.name, path: next, scope: resource }); defineIds.set(resource.id, next); }
        if (kind === "functions") { symbols.set(`${kind}:${resource.id}`, { name: resource.name, path: next, scope: resource }); functions.set(resource.id, next); }
        if (kind === "filters") filters.set(resource.id, next);
      }
    }
  }
  const policyPath = (policy: ChannelPolicy | undefined): string[] | undefined => {
    if (!policy) return;
    if (policy.mode === "custom" && policy.filterId) return filters.get(policy.filterId);
    if (policy.mode === "combined") for (const step of policy.steps) if (step.type === "function" && functions.has(step.functionId)) return functions.get(step.functionId);
  };
  for (const session of inventory.sessions) for (const channel of Object.values(session.channels)) {
    const via = (channel.exportDefineId ? defineIds.get(channel.exportDefineId) : undefined) ?? policyPath(channel.importPolicy) ?? policyPath(channel.exportPolicy);
    if (via) add("sessions", { ...session, label: session.protocolName }, via);
  }
  for (const resource of inventory.staticProtocols) {
    const sources = [resource.raw, ...Object.values(resource.routeFilters ?? {}).map(item => item.custom), ...(resource.routes ?? []).map(item => item.filter.custom)];
    const via = (resource.defineId ? defineIds.get(resource.defineId) : undefined) ?? policyPath(resource.importPolicy) ?? sources.map(source => sourcePath(source, resource)).find(path => path !== undefined);
    if (via) add("statics", resource, via);
  }
  for (const resource of inventory.sourcePolicies) {
    const via = resource.internalDefineIds.map(id => defineIds.get(id)).find(path => path !== undefined);
    if (via) add("sourcePolicies", resource, via);
  }
  for (const resource of inventory.pipeProtocols ?? []) {
    const via = policyPath(resource.importPolicy) ?? policyPath(resource.exportPolicy);
    if (via) add("pipes", resource, via);
  }
  for (const resource of inventory.kernelProtocols) {
    const exports = resource.exportPolicies ? Object.values(resource.exportPolicies).flatMap(item => item.mode === "visual" ? [item.policy] : []) : [resource.exportPolicy];
    const via = [...Object.values(resource.importPolicies ?? { legacy: resource.importPolicy }), ...exports].map(policyPath).find(path => path !== undefined);
    if (via) add("kernels", resource, via);
  }
  for (const domain of inventory.ospfDomains) {
    const configs = domain.nodeConfigs.filter(config => (["ospfv2", "ospfv3"] as const).some(version => {
      const exportPolicy = config.exportPolicies[version];
      return (exportPolicy.mode !== "custom" && exportPolicy.formAction === "cidr" && defineIds.has(config.exportDefineIds[version] ?? "")) || policyPath(config.importPolicies[version]) !== undefined || policyPath(exportPolicy) !== undefined;
    }));
    if (configs.length) add("ospf", { id: domain.id, label: domain.name, nodeIds: configs.map(config => config.nodeId) }, []);
  }
  return [...result.values()];
}
