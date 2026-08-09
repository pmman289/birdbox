import type {
  BgpSession,
  Inventory,
  ManagedNode,
  Peer,
  PolicyCollection,
  PolicyDefine,
  PolicyFilter,
  PolicyFunction,
  RpkiSource,
  StaticProtocol,
} from "../packages/contracts/src/inventory.js";
import {
  birdSourceReferencesSymbol,
  locateStaticRouteDiagnostic,
  normalizeDefine,
  normalizePolicyFilter,
  normalizePolicyFunction,
  renderBirdConfig,
} from "./bird.js";
import { fail } from "./errors.js";

export type PolicyResource = PolicyDefine | PolicyFunction | PolicyFilter;

export function findNode(state: Inventory, nodeId: string): ManagedNode {
  const node = state.nodes.find((item) => item.id === nodeId);
  if (!node) fail(404, "受管节点不存在");
  return node;
}

export function findPeer(state: Inventory, peerId: string): Peer {
  const peer = state.peers.find((item) => item.id === peerId);
  if (!peer) fail(404, "远端 Peer 不存在");
  return peer;
}

export function policyResources(state: Inventory, collection: PolicyCollection): PolicyResource[] {
  if (collection === "functions") return state.functions;
  if (collection === "filters") return state.filters;
  return state.defines;
}

export function findPolicyResource(
  state: Inventory,
  collection: PolicyCollection,
  resourceId: string,
): PolicyResource {
  const resource = policyResources(state, collection).find((item) => item.id === resourceId);
  if (!resource) {
    fail(404, collection === "functions"
      ? "Function 不存在"
      : collection === "filters" ? "Filter 不存在" : "Define 不存在");
  }
  return resource;
}

export function normalizePolicyResource(collection: PolicyCollection, input: unknown): PolicyResource {
  if (collection === "functions") return normalizePolicyFunction(input);
  if (collection === "filters") return normalizePolicyFilter(input);
  return normalizeDefine(input);
}

export function nodePeers(state: Inventory, nodeId: string): Peer[] {
  return state.peers.filter((item) => item.nodeId === nodeId);
}

export function nodeSessions(state: Inventory, nodeId: string): BgpSession[] {
  return state.sessions.filter((item) => item.nodeId === nodeId);
}

export function nodePolicyResources<Collection extends PolicyCollection>(
  state: Inventory,
  collection: Collection,
  nodeId: string,
  enabledOnly = false,
): Inventory[Collection] {
  return state[collection].filter((item) =>
    (item.nodeId === null || item.nodeId === nodeId) && (!enabledOnly || item.enabled),
  ) as Inventory[Collection];
}

export function nodeRPKIResources(state: Inventory, nodeId: string, enabledOnly = false): RpkiSource[] {
  return state.rpki.filter((item) =>
    (item.nodeId === null || item.nodeId === nodeId) && (!enabledOnly || item.enabled),
  );
}

export function nodeStaticProtocols(state: Inventory, nodeId: string, enabledOnly = false): StaticProtocol[] {
  return state.staticProtocols.filter((item) => item.nodeId === nodeId && (!enabledOnly || item.enabled));
}

export function ownedNodePolicyResources(
  state: Inventory,
  nodeId: string,
): Array<PolicyResource | RpkiSource | StaticProtocol> {
  return [...state.defines, ...state.functions, ...state.filters, ...state.rpki, ...state.staticProtocols]
    .filter((item) => item.nodeId === nodeId);
}

export function resourceReferencesSymbol(
  state: Inventory,
  symbol: string,
  excludedId: string | null = null,
): boolean {
  return [...state.defines, ...state.functions, ...state.filters].some((resource) => {
    const source = "source" in resource ? resource.source : resource.type === "expression" ? resource.value : "";
    return resource.id !== excludedId && birdSourceReferencesSymbol(source, symbol);
  }) || state.staticProtocols.some((resource) =>
    resource.id !== excludedId && birdSourceReferencesSymbol(resource.raw, symbol),
  );
}

export function configForNode(state: Inventory, node: ManagedNode): string {
  return renderBirdConfig(
    node,
    nodePeers(state, node.id),
    nodeSessions(state, node.id),
    nodePolicyResources(state, "functions", node.id),
    nodePolicyResources(state, "filters", node.id),
    nodePolicyResources(state, "defines", node.id),
    nodeRPKIResources(state, node.id),
    nodeStaticProtocols(state, node.id),
  );
}

export function staticValidationError(config: string, diagnostic: unknown, fallback: string): string {
  const detail = String(diagnostic ?? "").trim();
  const source = locateStaticRouteDiagnostic(config, detail);
  if (!source) return detail || fallback;
  const section = source.section === "custom"
    ? "自定义 per-route 源码"
    : source.section === "operation"
      ? `快捷操作 ${(source.operationIndex ?? 0) + 1}`
      : "路由定义";
  return `Static CIDR ${source.prefix} ${section}的 BIRD 语法检查失败：${detail || fallback}`;
}
