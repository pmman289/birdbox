import type {
  Inventory,
  PolicyDefine,
  PolicyFilter,
  PolicyFunction,
  RpkiSource,
  SourcePolicyEgress,
  StaticProtocol,
} from "../packages/contracts/src/inventory.js";
import {
  resourceScopeContains,
  type NodeScopedResource,
} from "../packages/contracts/src/resource-scope.js";
import { birdIdentifierList } from "./bird-identifiers.js";
import { assertValidation } from "./bird-normalize-common.js";

type DependencyKind = "Define" | "Function" | "Filter" | "RPKI" | "Static" | "SourcePolicy";
type DependencyInventory = Pick<Inventory, "defines" | "functions" | "filters" | "rpki" | "staticProtocols" | "sourcePolicies">;

interface DependencyNode {
  key: string;
  kind: DependencyKind;
  name: string;
  enabled: boolean;
  scope: NodeScopedResource;
  phase: number;
  index: number;
  references: Set<string>;
  providedSymbols: Set<string>;
}

interface DependencyEdge {
  consumer: DependencyNode;
  provider: DependencyNode;
  symbol: string;
}

function policySource(resource: PolicyDefine | PolicyFunction | PolicyFilter): string | null {
  if ("source" in resource) return resource.source;
  return resource.type === "expression" ? resource.value : null;
}

function sourceReferences(
  resource: PolicyDefine | PolicyFunction | PolicyFilter,
): Set<string> {
  const source = policySource(resource);
  if (source === null) return new Set();
  const identifiers = birdIdentifierList(source);
  if ("source" in resource) {
    const declarationName = identifiers.indexOf(resource.name);
    if (declarationName >= 0) identifiers.splice(declarationName, 1);
  }
  return new Set(identifiers);
}

function policyNode(
  resource: PolicyDefine | PolicyFunction | PolicyFilter,
  kind: "Define" | "Function" | "Filter",
  phase: number,
  index: number,
): DependencyNode {
  return {
    key: `${kind}:${resource.id}`,
    kind,
    name: resource.name,
    enabled: resource.enabled,
    scope: resource,
    phase,
    index,
    references: sourceReferences(resource),
    providedSymbols: kind === "Filter" ? new Set() : new Set([resource.name]),
  };
}

function rpkiNode(resource: RpkiSource, index: number): DependencyNode {
  return {
    key: `RPKI:${resource.id}`,
    kind: "RPKI",
    name: resource.name,
    enabled: resource.enabled,
    scope: resource,
    phase: 1,
    index,
    references: new Set(),
    providedSymbols: new Set([resource.name, resource.roa4Table, resource.roa6Table].filter((value): value is string => value !== null)),
  };
}

function staticNode(resource: StaticProtocol, index: number): DependencyNode {
  const sources = [resource.raw, ...Object.values(resource.routeFilters).map((filter) => filter.custom)];
  return {
    key: `Static:${resource.id}`,
    kind: "Static",
    name: resource.name,
    enabled: resource.enabled,
    scope: resource,
    phase: 4,
    index,
    references: new Set(sources.flatMap((source) => birdIdentifierList(source))),
    providedSymbols: new Set(),
  };
}

function sourcePolicyNode(resource: SourcePolicyEgress, index: number, defineNames: ReadonlyMap<string, string>): DependencyNode {
  return {
    key: `SourcePolicy:${resource.id}`,
    kind: "SourcePolicy",
    name: resource.label,
    enabled: resource.enabled,
    scope: resource,
    phase: 4,
    index,
    references: new Set(resource.internalDefineIds.map((id) => defineNames.get(id)).filter((value): value is string => Boolean(value))),
    providedSymbols: new Set(),
  };
}

function dependencyNodes(inventory: DependencyInventory): DependencyNode[] {
  const defineNames = new Map(inventory.defines.map((resource) => [resource.id, resource.name]));
  return [
    ...inventory.defines.map((resource, index) => policyNode(resource, "Define", 0, index)),
    ...inventory.rpki.map(rpkiNode),
    ...inventory.functions.map((resource, index) => policyNode(resource, "Function", 2, index)),
    ...inventory.filters.map((resource, index) => policyNode(resource, "Filter", 3, index)),
    ...inventory.staticProtocols.map(staticNode),
    ...inventory.sourcePolicies.map((resource, index) => sourcePolicyNode(resource, index, defineNames)),
  ];
}

function resolveProvider(consumer: DependencyNode, candidates: DependencyNode[]): DependencyNode {
  return candidates.find((candidate) => resourceScopeContains(candidate.scope, consumer.scope))
    ?? candidates.find((candidate) => candidate.key === consumer.key)
    ?? candidates[0] as DependencyNode;
}

function dependencyEdges(nodes: DependencyNode[]): DependencyEdge[] {
  const providersBySymbol = new Map<string, DependencyNode[]>();
  for (const node of nodes) {
    for (const symbol of node.providedSymbols) {
      const providers = providersBySymbol.get(symbol) ?? [];
      providers.push(node);
      providersBySymbol.set(symbol, providers);
    }
  }
  return nodes.flatMap((consumer) => {
    const edges = new Map<string, DependencyEdge>();
    for (const symbol of consumer.references) {
      const candidates = providersBySymbol.get(symbol);
      if (!candidates?.length) continue;
      const provider = resolveProvider(consumer, candidates);
      if (!edges.has(provider.key)) edges.set(provider.key, { consumer, provider, symbol });
    }
    return [...edges.values()];
  });
}

function pathLabel(path: readonly DependencyNode[]): string {
  return path.map((node) => `${node.kind} ${node.name}`).join(" -> ");
}

function assertAcyclic(nodes: DependencyNode[], edges: DependencyEdge[]): void {
  const graphNodes = new Map(nodes.filter((node) => node.kind !== "Static").map((node) => [node.key, node]));
  const outgoing = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    if (!graphNodes.has(edge.consumer.key) || !graphNodes.has(edge.provider.key)) continue;
    outgoing.set(edge.consumer.key, [...(outgoing.get(edge.consumer.key) ?? []), edge]);
  }
  const states = new Map<string, "visiting" | "complete">();
  const stack: DependencyNode[] = [];
  const visit = (node: DependencyNode): void => {
    states.set(node.key, "visiting");
    stack.push(node);
    for (const edge of outgoing.get(node.key) ?? []) {
      const provider = edge.provider;
      const state = states.get(provider.key);
      if (state === "visiting") {
        const start = stack.findIndex((item) => item.key === provider.key);
        const cycle = [...stack.slice(Math.max(0, start)), provider];
        assertValidation(false, `资源依赖形成循环：${pathLabel(cycle)}`);
      }
      if (state !== "complete") visit(provider);
    }
    stack.pop();
    states.set(node.key, "complete");
  };
  for (const node of graphNodes.values()) {
    if (!states.has(node.key)) visit(node);
  }
}

function declaredBefore(provider: DependencyNode, consumer: DependencyNode): boolean {
  return provider.phase < consumer.phase || (provider.phase === consumer.phase && provider.index < consumer.index);
}

function validateDependencyClosure(root: DependencyNode, outgoing: ReadonlyMap<string, DependencyEdge[]>): void {
  const visited = new Set<string>();
  const visit = (current: DependencyNode, path: DependencyNode[]): void => {
    if (visited.has(current.key)) return;
    visited.add(current.key);
    for (const edge of outgoing.get(current.key) ?? []) {
      const dependencyPath = [...path, edge.provider];
      const detail = `（符号 ${edge.symbol}；依赖链：${pathLabel(dependencyPath)}）`;
      assertValidation(
        resourceScopeContains(edge.provider.scope, edge.consumer.scope),
        `资源 ${root.name} 引用了作用域不兼容的 ${edge.provider.kind} ${edge.provider.name}${detail}`,
      );
      assertValidation(
        !edge.consumer.enabled || edge.provider.enabled,
        `资源 ${root.name} 引用了已停用的 ${edge.provider.kind} ${edge.provider.name}${detail}`,
      );
      assertValidation(
        declaredBefore(edge.provider, edge.consumer),
        `资源 ${root.name} 引用了声明顺序在后的 ${edge.provider.kind} ${edge.provider.name}${detail}`,
      );
      visit(edge.provider, dependencyPath);
    }
  };
  visit(root, [root]);
}

export function validateResourceDependencyGraph(inventory: DependencyInventory): void {
  const nodes = dependencyNodes(inventory);
  const edges = dependencyEdges(nodes);
  assertAcyclic(nodes, edges);
  const outgoing = new Map<string, DependencyEdge[]>();
  for (const edge of edges) outgoing.set(edge.consumer.key, [...(outgoing.get(edge.consumer.key) ?? []), edge]);
  for (const node of [...nodes].sort((left, right) => right.phase - left.phase || left.index - right.index)) {
    validateDependencyClosure(node, outgoing);
  }
}
