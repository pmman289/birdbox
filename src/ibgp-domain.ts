import type {
  AddressFamily,
  BgpSession,
  IbgpAdjacency,
  IbgpDomain,
  IbgpMember,
  ManagedNode,
  Peer,
} from "../packages/contracts/src/inventory.js";
import {
  assertValidation,
  normalizeAsn,
  normalizeEnum,
  normalizeId,
  normalizeIPAddress,
  normalizeIPv4,
  normalizeLabel,
  normalizeOptionalString,
  normalizePort,
} from "./bird-normalize-common.js";
import { normalizeSession } from "./bird-session.js";

type RecordValue = Record<string, unknown>;
const FAMILIES = ["ipv4", "ipv6"] as const satisfies readonly AddressFamily[];

function record(value: unknown, label: string): RecordValue {
  assertValidation(value && typeof value === "object" && !Array.isArray(value), `${label}必须是对象`);
  return value as RecordValue;
}

function optionalRecord(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function normalizeAddress(value: unknown, family: AddressFamily, label: string): string | null {
  return value === null || value === undefined || value === ""
    ? null
    : normalizeIPAddress(value, label, family === "ipv4" ? 4 : 6);
}

export function normalizeIbgpDomain(inputValue: unknown): IbgpDomain {
  const input = record(inputValue, "iBGP 域参数不能为空");
  const familiesInput = Array.isArray(input.families) ? input.families : ["ipv4"];
  const families = [...new Set(familiesInput.map((item) => normalizeEnum(item, new Set(FAMILIES), "ipv4", "地址族")))];
  assertValidation(families.length > 0, "iBGP 域至少启用一个地址族");
  const membersInput = Array.isArray(input.members) ? input.members : [];
  const members: IbgpMember[] = membersInput.map((value, index) => {
    const member = record(value, `iBGP 成员 ${index + 1}`);
    const address4 = normalizeAddress(member.address4, "ipv4", `成员 ${index + 1} IPv4 地址`);
    const address6 = normalizeAddress(member.address6, "ipv6", `成员 ${index + 1} IPv6 地址`);
    assertValidation(address4 !== null || address6 !== null, `成员 ${index + 1} 至少需要一个节点地址`);
    return {
      nodeId: normalizeId(member.nodeId, `成员 ${index + 1} 节点 ID`),
      address4,
      address6,
      role: normalizeEnum(member.role, new Set(["member", "reflector", "client"] as const), "member", `成员 ${index + 1} 角色`),
      clusterId: member.clusterId === null || member.clusterId === undefined || member.clusterId === ""
        ? null
        : normalizeIPv4(member.clusterId, `成员 ${index + 1} Cluster ID`),
    };
  });
  assertValidation(new Set(members.map((item) => item.nodeId)).size === members.length, "iBGP 域成员不能重复");
  for (const member of members) {
    if (families.includes("ipv4")) assertValidation(member.address4 !== null, `成员 ${member.nodeId} 缺少 IPv4 地址`);
    if (families.includes("ipv6")) assertValidation(member.address6 !== null, `成员 ${member.nodeId} 缺少 IPv6 地址`);
  }
  if (input.topology === "route-reflector") {
    assertValidation(members.some((member) => member.role === "reflector"), "Route Reflector 拓扑至少需要一个 Reflector");
  }
  const layoutInput = optionalRecord(input.layout);
  const layout = Object.fromEntries(Object.entries(layoutInput).map(([nodeId, value]) => {
    const position = optionalRecord(value);
    const x = Number(position.x ?? 0);
    const y = Number(position.y ?? 0);
    assertValidation(Number.isFinite(x) && Number.isFinite(y), "拓扑坐标必须是数字");
    return [nodeId, { x: Math.round(x), y: Math.round(y), locked: position.locked === true }];
  }));
  const adjacenciesInput = Array.isArray(input.adjacencies) ? input.adjacencies : [];
  const memberIds = new Set(members.map((item) => item.nodeId));
  assertValidation(Object.keys(layout).every((nodeId) => memberIds.has(nodeId)), "拓扑布局包含不属于域成员的节点");
  const adjacencies: IbgpAdjacency[] = adjacenciesInput.map((value, index) => {
    const adjacency = record(value, `iBGP 邻接 ${index + 1}`);
    const leftNodeId = normalizeId(adjacency.leftNodeId, "邻接本端节点 ID");
    const rightNodeId = normalizeId(adjacency.rightNodeId, "邻接对端节点 ID");
    assertValidation(leftNodeId !== rightNodeId, "iBGP 邻接不能连接同一个节点");
    assertValidation(memberIds.has(leftNodeId) && memberIds.has(rightNodeId), "iBGP 邻接节点必须属于域成员");
    return {
      id: normalizeId(adjacency.id, `邻接 ${index + 1} ID`),
      leftNodeId,
      rightNodeId,
      enabled: adjacency.enabled !== false,
      leftSessionId: normalizeId(adjacency.leftSessionId, "邻接左侧会话 ID"),
      rightSessionId: normalizeId(adjacency.rightSessionId, "邻接右侧会话 ID"),
    };
  });
  assertValidation(new Set(adjacencies.map((item) => item.id)).size === adjacencies.length, "iBGP 邻接 ID 重复");
  assertValidation(new Set(adjacencies.map((item) => [item.leftNodeId, item.rightNodeId].sort().join(":"))).size === adjacencies.length, "同一对 iBGP 节点不能重复建立邻接");
  assertValidation(new Set(adjacencies.flatMap((item) => [item.leftSessionId, item.rightSessionId])).size === adjacencies.length * 2, "iBGP 邻接会话 ID 重复");
  return {
    id: normalizeId(input.id, "iBGP 域 ID"),
    name: normalizeLabel(input.name, "iBGP 域名称"),
    asn: normalizeAsn(input.asn, "iBGP 域内部 ASN"),
    topology: normalizeEnum(input.topology, new Set(["full-mesh", "route-reflector", "manual"] as const), "full-mesh", "iBGP 拓扑模式"),
    families,
    defaultClusterId: input.defaultClusterId === null || input.defaultClusterId === undefined || input.defaultClusterId === ""
      ? null
      : normalizeIPv4(input.defaultClusterId, "默认 Cluster ID"),
    members,
    adjacencies,
    layout,
  };
}

function protocolName(domain: IbgpDomain, adjacency: IbgpAdjacency, side: "left" | "right"): string {
  return `ibgp_${domain.id}_${adjacency.id}_${side}`.slice(0, 64);
}

function peerName(domain: IbgpDomain, nodeId: string): string {
  return `iBGP ${domain.name} · ${nodeId}`.slice(0, 80);
}

function memberAddress(member: IbgpMember, families: AddressFamily[]): string {
  const address = families.includes("ipv4") ? member.address4 : member.address6;
  assertValidation(address !== null, `iBGP 成员 ${member.nodeId} 缺少所选地址族地址`);
  return address;
}

export function expandIbgpDomain(
  domain: IbgpDomain,
  nodes: readonly ManagedNode[],
  existingSessions: readonly BgpSession[] = [],
): { peers: Peer[]; sessions: BgpSession[] } {
  const members = new Map(domain.members.map((member) => [member.nodeId, member]));
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const existing = new Map(existingSessions.filter((session) => session.managedBy?.domainId === domain.id).map((session) => [session.id, session]));
  const peers: Peer[] = [];
  const sessions: BgpSession[] = [];
  for (const adjacency of domain.adjacencies) {
    const left = members.get(adjacency.leftNodeId);
    const right = members.get(adjacency.rightNodeId);
    assertValidation(left && right, `iBGP 邻接 ${adjacency.id} 成员不存在`);
    assertValidation(nodeMap.has(adjacency.leftNodeId) && nodeMap.has(adjacency.rightNodeId), `iBGP 邻接 ${adjacency.id} 节点不存在`);
    const sides = [
      { side: "left" as const, local: left, remote: right, sessionId: adjacency.leftSessionId, peerId: `${adjacency.id}_peer_left` },
      { side: "right" as const, local: right, remote: left, sessionId: adjacency.rightSessionId, peerId: `${adjacency.id}_peer_right` },
    ];
    for (const item of sides) {
      const localNode = nodeMap.get(item.local.nodeId);
      assertValidation(localNode, "iBGP 成员节点不存在");
      const peer = {
        id: item.peerId,
        nodeId: item.local.nodeId,
        name: peerName(domain, item.remote.nodeId),
        address: memberAddress(item.remote, domain.families),
        asn: domain.asn,
        port: normalizePort(item.remote.nodeId === item.local.nodeId ? null : nodeMap.get(item.remote.nodeId)?.listenPort, "远端 BGP 端口", 179),
        managedBy: { kind: "ibgp-domain" as const, domainId: domain.id, adjacencyId: adjacency.id },
      } satisfies Peer;
      const old = existing.get(item.sessionId);
      const roleBasedRrClient = item.local.role === "reflector" && item.remote.role === "client";
      const rrClient = domain.topology === "manual" ? (old?.bgp.rrClient ?? roleBasedRrClient) : roleBasedRrClient;
      const session = normalizeSession({
        ...(old ?? {}),
        id: item.sessionId,
        nodeId: item.local.nodeId,
        peerId: peer.id,
        protocolName: old?.protocolName ?? protocolName(domain, adjacency, item.side),
        localAddress: old?.localAddress ?? memberAddress(item.local, domain.families),
        localAsn: domain.asn,
        localPort: old?.localPort ?? localNode.listenPort,
        sessionType: "ibgp",
        managedBy: peer.managedBy,
        bgp: {
          ...(old?.bgp ?? {}),
          rrClient,
          rrClusterId: rrClient ? (old?.bgp.rrClusterId ?? item.local.clusterId ?? domain.defaultClusterId) : null,
          connectionMode: old?.bgp.connectionMode ?? "multihop",
        },
        channels: old?.channels ?? {
          ipv4: { enabled: domain.families.includes("ipv4") },
          ipv6: { enabled: domain.families.includes("ipv6") },
        },
        enabled: adjacency.enabled,
      });
      peers.push(peer);
      sessions.push(session);
    }
  }
  return { peers, sessions };
}

export function makeIbgpAdjacencyId(domainId: string, leftNodeId: string, rightNodeId: string): string {
  return normalizeId(`ibgp_${domainId}_${leftNodeId}_${rightNodeId}`.slice(0, 64), "iBGP 邻接 ID");
}

export function desiredAdjacencies(domain: IbgpDomain): Array<Pick<IbgpAdjacency, "leftNodeId" | "rightNodeId">> {
  if (domain.topology === "manual") return domain.adjacencies;
  const members = domain.members;
  if (domain.topology === "full-mesh") {
    return members.flatMap((left, index) => members.slice(index + 1).map((right) => ({ leftNodeId: left.nodeId, rightNodeId: right.nodeId })));
  }
  const reflectors = members.filter((member) => member.role === "reflector");
  const clients = members.filter((member) => member.role !== "reflector");
  return reflectors.flatMap((reflector) => clients.filter((client) => client.nodeId !== reflector.nodeId).map((client) => ({ leftNodeId: reflector.nodeId, rightNodeId: client.nodeId })));
}
