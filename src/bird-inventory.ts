import type {
  AddressFamily,
  Inventory,
  PolicyDefine,
} from "../packages/contracts/src/inventory.js";
import {
  assertValidation,
  channelRequiresExtendedNextHop,
  ipFamily,
  isLinkLocalIPv6,
  normalizeNode,
  normalizePeer,
  splitScopedIPAddress,
} from "./bird-normalize-common.js";
import { normalizeDefine, normalizePolicyFilter, normalizePolicyFunction } from "./bird-policy-resources.js";
import { isExactPrefix } from "./bird-prefix.js";
import { normalizeRPKISource } from "./bird-rpki.js";
import { normalizeSession } from "./bird-session.js";
import { normalizeStaticProtocol, staticRouteDefinitionSignature } from "./bird-static.js";
import {
  MAX_SOURCE_POLICY_SOURCES_PER_GROUP,
  normalizeSourcePolicyEgress,
  SOURCE_POLICY_PRIORITY_MAX,
  SOURCE_POLICY_PRIORITY_WIDTH,
  sourcePolicyNames,
} from "./bird-source-policy.js";
import { normalizeIbgpDomain } from "./ibgp-domain.js";
import { validateResourceDependencyGraph } from "./bird-resource-dependencies.js";
import {
  resourceAppliesToNode,
  scopedNodeIds,
} from "../packages/contracts/src/resource-scope.js";

type UnknownRecord = Record<string, unknown>;

export interface InventoryValidationOptions {
  allowInvalidResourceDependencies?: boolean;
}

const FAMILIES = ["ipv4", "ipv6"] as const satisfies readonly AddressFamily[];

function record(value: unknown, message: string): UnknownRecord {
  assertValidation(value && typeof value === "object" && !Array.isArray(value), message);
  return value as UnknownRecord;
}

function list(input: UnknownRecord, key: string): unknown[] {
  const value = input[key] ?? [];
  assertValidation(Array.isArray(value), `${key} 必须是数组`);
  return value;
}

function enabledCidrEntries(define: PolicyDefine | undefined): string[] {
  return define && define.type !== "expression" ? define.entries.filter(isExactPrefix) : [];
}

export function validateInventory(inputValue: unknown, options: InventoryValidationOptions = {}): Inventory {
  const input = record(inputValue, "资产数据不能为空");
  const nodes = list(input, "nodes").map(normalizeNode);
  const peers = list(input, "peers").map(normalizePeer);
  const defines = list(input, "defines").map(normalizeDefine);
  const functions = list(input, "functions").map(normalizePolicyFunction);
  const filters = list(input, "filters").map(normalizePolicyFilter);
  const rpki = list(input, "rpki").map(normalizeRPKISource);
  let staticProtocols = list(input, "staticProtocols").map(normalizeStaticProtocol);
  const sourcePolicies = list(input, "sourcePolicies").map(normalizeSourcePolicyEgress);
  const sessions = list(input, "sessions").map(normalizeSession);
  const ibgpDomains = list(input, "ibgpDomains").map(normalizeIbgpDomain);
  assertValidation(new Set(nodes.map((item) => item.id)).size === nodes.length, "节点 ID 重复");
  assertValidation(nodes.filter((item) => item.transport === "local").length <= 1, "只能配置一个本机节点");
  const deploymentTargets = nodes
    .filter((item) => item.transport === "ssh")
    .map((item) => `${(item.sshHost ?? "").toLowerCase()}:${item.sshPort}:${item.generatedConfigPath}`);
  assertValidation(new Set(deploymentTargets).size === deploymentTargets.length, "多个节点不能使用同一个 SSH 配置部署目标");
  assertValidation(new Set(peers.map((item) => item.id)).size === peers.length, "Peer ID 重复");
  assertValidation(new Set(defines.map((item) => item.id)).size === defines.length, "Define ID 重复");
  assertValidation(new Set(functions.map((item) => item.id)).size === functions.length, "Function ID 重复");
  assertValidation(new Set(filters.map((item) => item.id)).size === filters.length, "Filter ID 重复");
  assertValidation(new Set(rpki.map((item) => item.id)).size === rpki.length, "RPKI 资源 ID 重复");
  assertValidation(new Set(staticProtocols.map((item) => item.id)).size === staticProtocols.length, "Static 资源 ID 重复");
  assertValidation(new Set(sourcePolicies.map((item) => item.id)).size === sourcePolicies.length, "源地址出口映射 ID 重复");
  assertValidation(new Set(sessions.map((item) => item.id)).size === sessions.length, "会话 ID 重复");
  assertValidation(new Set(ibgpDomains.map((item) => item.id)).size === ibgpDomains.length, "iBGP 域 ID 重复");
  const allIbgpAdjacencies = ibgpDomains.flatMap((domain) => domain.adjacencies);
  assertValidation(new Set(allIbgpAdjacencies.map((item) => item.id)).size === allIbgpAdjacencies.length, "跨 iBGP 域的邻接 ID 重复");

  const nodeMap = new Map(nodes.map((item) => [item.id, item]));
  const peerMap = new Map(peers.map((item) => [item.id, item]));
  const defineMap = new Map(defines.map((item) => [item.id, item]));
  const functionMap = new Map(functions.map((item) => [item.id, item]));
  const filterMap = new Map(filters.map((item) => [item.id, item]));
  for (const domain of ibgpDomains) {
    for (const member of domain.members) assertValidation(nodeMap.has(member.nodeId), `iBGP 域 ${domain.name} 引用了不存在的节点`);
    const memberIds = new Set(domain.members.map((member) => member.nodeId));
    for (const adjacency of domain.adjacencies) {
      assertValidation(memberIds.has(adjacency.leftNodeId) && memberIds.has(adjacency.rightNodeId), `iBGP 域 ${domain.name} 的邻接节点不属于域成员`);
      const left = sessions.find((session) => session.id === adjacency.leftSessionId);
      const right = sessions.find((session) => session.id === adjacency.rightSessionId);
      assertValidation(left?.sessionType === "ibgp" && right?.sessionType === "ibgp", `iBGP 域 ${domain.name} 的邻接必须引用 iBGP 会话`);
      assertValidation(left?.managedBy?.domainId === domain.id && right?.managedBy?.domainId === domain.id, `iBGP 域 ${domain.name} 的会话托管关系不一致`);
      assertValidation(left?.managedBy?.adjacencyId === adjacency.id && right?.managedBy?.adjacencyId === adjacency.id, `iBGP 域 ${domain.name} 的邻接托管关系不一致`);
      assertValidation(left?.nodeId === adjacency.leftNodeId && right?.nodeId === adjacency.rightNodeId, `iBGP 域 ${domain.name} 的双向会话节点不一致`);
    }
  }
  const domainMap = new Map(ibgpDomains.map((domain) => [domain.id, domain]));
  for (const resource of [...peers, ...sessions]) {
    if (!resource.managedBy) continue;
    const domain = domainMap.get(resource.managedBy.domainId);
    assertValidation(domain?.adjacencies.some((adjacency) => adjacency.id === resource.managedBy?.adjacencyId), "存在失去 iBGP 域归属的托管会话资源");
  }
  staticProtocols = staticProtocols.map((resource) => {
    const exactPrefixes = enabledCidrEntries(resource.defineId === null ? undefined : defineMap.get(resource.defineId));
    const routeActions = Object.fromEntries(exactPrefixes.map((prefix) => {
      const action = resource.routeActions[prefix] ?? resource.action;
      assertValidation(action !== null, `Static 资源 ${resource.name} 未为 ${prefix} 设置标准动作`);
      return [prefix, action];
    }));
    const routeFilters = Object.fromEntries(exactPrefixes.map((prefix) => [
      prefix,
      resource.routeFilters[prefix] ?? { operations: [], custom: "" },
    ]));
    return { ...resource, routeActions, routeFilters };
  });

  for (const peer of peers) {
    assertValidation(nodeMap.has(peer.nodeId), `Peer ${peer.name} 引用了不存在的节点`);
  }
  for (const resource of defines) {
    assertValidation(scopedNodeIds(resource)?.every((nodeId) => nodeMap.has(nodeId)) ?? true, `Define ${resource.name} 引用了不存在的节点`);
  }
  for (const resource of functions) {
    assertValidation(scopedNodeIds(resource)?.every((nodeId) => nodeMap.has(nodeId)) ?? true, `策略 ${resource.name} 引用了不存在的节点`);
  }
  for (const resource of filters) {
    assertValidation(scopedNodeIds(resource)?.every((nodeId) => nodeMap.has(nodeId)) ?? true, `策略 ${resource.name} 引用了不存在的节点`);
  }
  for (const resource of rpki) {
    assertValidation(scopedNodeIds(resource)?.every((nodeId) => nodeMap.has(nodeId)) ?? true, `RPKI 资源 ${resource.name} 引用了不存在的节点`);
  }
  for (const resource of sourcePolicies) {
    assertValidation(scopedNodeIds(resource)?.every((nodeId) => nodeMap.has(nodeId)) ?? true, `源地址出口映射 ${resource.label} 引用了不存在的节点`);
    assertValidation(new Set(resource.groups.map((group) => group.id)).size === resource.groups.length, `源地址出口映射 ${resource.label} 的出口组 ID 重复`);
    assertValidation(new Set(resource.groups.map((group) => group.egressAddress)).size === resource.groups.length, `源地址出口映射 ${resource.label} 的出口地址重复`);
    for (const defineId of resource.internalDefineIds) {
      const define = defineMap.get(defineId);
      assertValidation(define?.type === "cidr4" && define.enabled, `源地址出口映射 ${resource.label} 引用了不可用的 IPv4 CIDR Define`);
    }
  }
  for (const resource of staticProtocols) {
    const node = nodeMap.get(resource.nodeId);
    const staticDefine = resource.defineId === null ? null : defineMap.get(resource.defineId);
    const expectedDefineType = resource.family === "ipv4" ? "cidr4" : "cidr6";
    assertValidation(node, `Static 资源 ${resource.name} 引用了不存在的节点`);
    assertValidation(
      resource.defineId === null || (
        staticDefine?.type === expectedDefineType
        && staticDefine.enabled
        && resourceAppliesToNode(staticDefine, node.id)
      ),
      `Static 资源 ${resource.name} 的 CIDR Define 对所选节点或地址族不可用`,
    );
  }
  for (const session of sessions) {
    const node = nodeMap.get(session.nodeId);
    const peer = peerMap.get(session.peerId);
    assertValidation(node, `会话 ${session.protocolName} 引用了不存在的节点`);
    assertValidation(peer && peer.nodeId === node.id, `会话 ${session.protocolName} 的 Peer 不属于所选节点`);
    assertValidation(
      session.sessionType === "ibgp" ? session.localAsn === peer.asn : session.localAsn !== peer.asn,
      session.sessionType === "ibgp"
        ? `iBGP 会话 ${session.protocolName} 的两端 ASN 必须相同`
        : `eBGP 会话 ${session.protocolName} 的两端 ASN 必须不同`,
    );
    assertValidation(session.sessionType === "ibgp" || (!session.bgp.rrClient && session.bgp.rrClusterId === null), `eBGP 会话 ${session.protocolName} 不能配置 Route Reflector 参数`);
    assertValidation(session.localAddress === null || session.localAddress !== peer.address, `会话 ${session.protocolName} 的两端地址不能相同`);
    assertValidation(session.localAddress === null || ipFamily(session.localAddress) === ipFamily(peer.address), `会话 ${session.protocolName} 的本地与 Peer 地址必须属于同一地址族`);
    const localScope = session.localAddress === null ? null : splitScopedIPAddress(session.localAddress).zone;
    const peerScope = splitScopedIPAddress(peer.address).zone;
    if ((session.localAddress !== null && isLinkLocalIPv6(session.localAddress)) || isLinkLocalIPv6(peer.address)) {
      assertValidation(session.bgp.connectionMode === "direct", `会话 ${session.protocolName} 的 IPv6 Link-local 地址只能用于 Direct 会话`);
      assertValidation(session.bgp.interface !== null || localScope !== null || peerScope !== null, `会话 ${session.protocolName} 的 IPv6 Link-local 地址必须指定接口`);
      assertValidation(localScope === null || peerScope === null || localScope === peerScope, `会话 ${session.protocolName} 的 IPv6 Scope 接口必须一致`);
      assertValidation(session.bgp.interface === null || localScope === null || session.bgp.interface === localScope, `会话 ${session.protocolName} 的 Local Scope 与 Interface 不一致`);
      assertValidation(session.bgp.interface === null || peerScope === null || session.bgp.interface === peerScope, `会话 ${session.protocolName} 的 Peer Scope 与 Interface 不一致`);
    }
    for (const family of FAMILIES) {
      const channel = session.channels[family];
      assertValidation(
        !channel.enabled || !channelRequiresExtendedNextHop(peer.address, family) || session.bgp.capabilities !== "off",
        `会话 ${session.protocolName} 的 IPv4 Channel 通过 IPv6 邻居传输时不能关闭 BGP Capabilities`,
      );
      const expectedDefineType = family === "ipv4" ? "cidr4" : "cidr6";
      const exportDefine = channel.exportDefineId === null ? null : defineMap.get(channel.exportDefineId);
      assertValidation(
        channel.exportDefineId === null || (
          exportDefine?.type === expectedDefineType
          && exportDefine.enabled
          && resourceAppliesToNode(exportDefine, node.id)
        ),
        `会话 ${session.protocolName} 的 ${family.toUpperCase()} 导出 CIDR Define 对所选节点不可用`,
      );
      for (const [label, policy] of [["导入", channel.importPolicy], ["导出", channel.exportPolicy]] as const) {
        for (const step of policy.steps.filter((item) => item.type === "function")) {
          const resource = functionMap.get(step.functionId);
          assertValidation(resource && resource.enabled && resource.callable && resourceAppliesToNode(resource, node.id), `会话 ${session.protocolName} 的 ${family.toUpperCase()} ${label} Function 不可用`);
        }
        if (policy.filterId !== null) {
          const resource = filterMap.get(policy.filterId);
          assertValidation(resource && resource.enabled && resourceAppliesToNode(resource, node.id), `会话 ${session.protocolName} 的 ${family.toUpperCase()} ${label} Filter 不可用`);
        }
      }
    }
  }
  for (const node of nodes) {
    const nodeSessions = sessions.filter((item) => item.nodeId === node.id);
    const nodeDefines = defines.filter((item) => resourceAppliesToNode(item, node.id));
    const nodeFunctions = functions.filter((item) => resourceAppliesToNode(item, node.id));
    const nodeFilters = filters.filter((item) => resourceAppliesToNode(item, node.id));
    const nodeRPKI = rpki.filter((item) => item.enabled && resourceAppliesToNode(item, node.id));
    const nodeStaticProtocols = staticProtocols.filter((item) => item.nodeId === node.id);
    const nodeSourcePolicies = sourcePolicies.filter((item) => resourceAppliesToNode(item, node.id));
    assertValidation(new Set(nodeSessions.map((item) => item.peerId)).size === nodeSessions.length, `节点 ${node.name} 对同一 Peer 存在多个会话`);
    assertValidation(new Set(nodeSessions.map((item) => item.protocolName)).size === nodeSessions.length, `节点 ${node.name} 的协议名称重复`);
    const symbols = [
      ...nodeDefines.map((item) => item.name),
      ...nodeFunctions.map((item) => item.name),
      ...nodeFilters.map((item) => item.name),
      ...nodeSessions.map((item) => item.protocolName),
      ...nodeStaticProtocols.map((item) => item.name),
      ...nodeRPKI.flatMap((item) => [
        item.name,
        ...(item.sourceType === "file"
          ? [item.roa4Table ? `${item.name}_v4` : null, item.roa6Table ? `${item.name}_v6` : null]
          : []),
        item.roa4Table,
        item.roa6Table,
      ]).filter((value): value is string => value !== null),
      ...nodeSourcePolicies.flatMap((item) => item.groups.flatMap((group) => {
        const names = sourcePolicyNames(item, group);
        return [names.table, names.staticProtocol, names.kernelProtocol, names.filter, names.pipe];
      })),
    ];
    assertValidation(new Set(symbols).size === symbols.length, `节点 ${node.name} 的 BIRD 全局标识符冲突`);
    for (const family of FAMILIES) {
      const routeDefinitions = new Map<string, string>();
      for (const resource of nodeStaticProtocols) {
        if (!resource.enabled || resource.family !== family || resource.defineId === null) continue;
        const staticDefine = defineMap.get(resource.defineId);
        if (!staticDefine || staticDefine.type === "expression") continue;
        for (const prefix of staticDefine.entries.filter(isExactPrefix)) {
          const action = resource.routeActions[prefix] ?? resource.action;
          if (action === null) continue;
          const routeFilter = resource.routeFilters[prefix] ?? { operations: [], custom: "" };
          const signature = staticRouteDefinitionSignature(action, routeFilter);
          const existing = routeDefinitions.get(prefix);
          assertValidation(!existing || existing === signature, `节点 ${node.name} 对 ${prefix} 配置了冲突的静态路由定义`);
          routeDefinitions.set(prefix, signature);
        }
      }
    }
    const activeSourcePolicies = nodeSourcePolicies.filter((item) => item.enabled);
    const sourceRoutes: Array<{ policy: typeof activeSourcePolicies[number]; group: typeof activeSourcePolicies[number]["groups"][number]; source: string; range: [number, number] }> = [];
    for (const policy of activeSourcePolicies) {
      assertValidation(policy.rulePriorityBase + SOURCE_POLICY_PRIORITY_WIDTH - 1 <= SOURCE_POLICY_PRIORITY_MAX, `源地址出口映射 ${policy.label} 的规则优先级范围无效`);
      for (const group of policy.groups) {
        assertValidation(![0, 253, 254, 255].includes(group.kernelTable), `源地址出口映射 ${policy.label} 使用了保留内核路由表`);
        for (const [index, source] of group.sources.entries()) {
          const range = source.split("/");
          const address = range[0]?.split(".").map(Number) ?? [];
          const prefix = Number(range[1]);
          const numeric = ((((address[0] ?? 0) << 24) | ((address[1] ?? 0) << 16) | ((address[2] ?? 0) << 8) | (address[3] ?? 0)) >>> 0);
          const size = prefix === 0 ? 0xffffffff : (2 ** (32 - prefix)) - 1;
          sourceRoutes.push({ policy, group, source, range: [numeric, numeric + size] });
          assertValidation(policy.rulePriorityBase + group.ruleSlot * MAX_SOURCE_POLICY_SOURCES_PER_GROUP + index <= SOURCE_POLICY_PRIORITY_MAX, `源地址出口映射 ${policy.label} 的规则 priority 超出范围`);
        }
      }
    }
    for (let left = 0; left < sourceRoutes.length; left += 1) {
      for (let right = left + 1; right < sourceRoutes.length; right += 1) {
        const first = sourceRoutes[left]!;
        const second = sourceRoutes[right]!;
        if (first.policy.id === second.policy.id && first.group.id === second.group.id && first.source === second.source) continue;
        const firstRange = first.range;
        const secondRange = second.range;
        const overlap = firstRange[0] <= secondRange[1] && secondRange[0] <= firstRange[1];
        if (!overlap) continue;
        assertValidation(false, `节点 ${node.name} 的源 CIDR ${first.source} 与 ${second.source} 存在出口映射冲突`);
      }
    }
    const tableOwners = new Map<number, string>();
    const priorityOwners = new Map<number, string>();
    for (const policy of activeSourcePolicies) {
      for (const group of policy.groups) {
        const tableOwner = tableOwners.get(group.kernelTable);
        assertValidation(!tableOwner, `节点 ${node.name} 的内核路由表 ${group.kernelTable} 被多个源地址出口映射占用`);
        tableOwners.set(group.kernelTable, policy.id);
      }
      for (let priority = policy.rulePriorityBase; priority < policy.rulePriorityBase + SOURCE_POLICY_PRIORITY_WIDTH; priority += 1) {
        const priorityOwner = priorityOwners.get(priority);
        assertValidation(!priorityOwner || priorityOwner === policy.id, `节点 ${node.name} 的规则 priority ${priority} 被多个源地址出口映射占用`);
        priorityOwners.set(priority, policy.id);
      }
    }
  }

  if (!options.allowInvalidResourceDependencies) {
    validateResourceDependencyGraph({ defines, functions, filters, rpki, staticProtocols, sourcePolicies });
  }

  return {
    version: 27,
    nodes,
    peers,
    defines,
    functions,
    filters,
    rpki,
    staticProtocols,
    sourcePolicies,
    sessions,
    ibgpDomains,
  };
}
