import type {
  BgpSession,
  IbgpAdjacency,
  IbgpDomain,
  IbgpMember,
  ManagedNode,
  Peer,
} from "../packages/contracts/src/inventory.js";
import {
  assertValidation,
  ipFamily,
  normalizeAsn,
  normalizeId,
  normalizeIPAddress,
  normalizeLabel,
  normalizePort,
} from "./bird-normalize-common.js";
import { normalizeSession } from "./bird-session.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  assertValidation(value && typeof value === "object" && !Array.isArray(value), `${label}必须是对象`);
  return value as RecordValue;
}

function optionalRecord(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

export function normalizeIbgpDomain(inputValue: unknown): IbgpDomain {
  const input = record(inputValue, "iBGP 域参数不能为空");
  const membersInput = Array.isArray(input.members) ? input.members : [];
  const members: IbgpMember[] = membersInput.map((value, index) => {
    const member = record(value, `iBGP 成员 ${index + 1}`);
    return {
      nodeId: normalizeId(member.nodeId, `成员 ${index + 1} 节点 ID`),
      address: normalizeIPAddress(
        member.address ?? member.address4 ?? member.address6,
        `成员 ${index + 1} 连接地址`,
      ),
    };
  });
  assertValidation(new Set(members.map((item) => item.nodeId)).size === members.length, "iBGP 域成员不能重复");
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
  const membersById = new Map(members.map((member) => [member.nodeId, member]));
  for (const adjacency of adjacencies) {
    const left = membersById.get(adjacency.leftNodeId);
    const right = membersById.get(adjacency.rightNodeId);
    assertValidation(
      left && right && ipFamily(left.address) === ipFamily(right.address),
      `iBGP 邻接 ${adjacency.id} 两端连接地址必须属于同一地址族`,
    );
  }
  return {
    id: normalizeId(input.id, "iBGP 域 ID"),
    name: normalizeLabel(input.name, "iBGP 域名称"),
    asn: normalizeAsn(input.asn, "iBGP 域内部 ASN"),
    members,
    adjacencies,
    layout,
  };
}

function identifierPart(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (normalized || fallback.replace(/[^A-Za-z0-9_]/g, "_")).slice(0, 22) || "peer";
}

function protocolName(domain: IbgpDomain, remoteNode: ManagedNode): string {
  const domainPart = identifierPart(domain.name, domain.id);
  const remotePart = identifierPart(remoteNode.name, remoteNode.id);
  return `ibgp_${domainPart}_${remotePart}`.slice(0, 64);
}

function peerName(domain: IbgpDomain, nodeId: string): string {
  return `iBGP ${domain.name} · ${nodeId}`.slice(0, 80);
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
      const remoteNode = nodeMap.get(item.remote.nodeId);
      assertValidation(localNode, "iBGP 成员节点不存在");
      assertValidation(remoteNode, "iBGP 对端节点不存在");
      const peer = {
        id: item.peerId,
        nodeId: item.local.nodeId,
        name: peerName(domain, item.remote.nodeId),
        address: item.remote.address,
        asn: domain.asn,
        port: normalizePort(item.remote.nodeId === item.local.nodeId ? null : nodeMap.get(item.remote.nodeId)?.listenPort, "远端 BGP 端口", 179),
        managedBy: { kind: "ibgp-domain" as const, domainId: domain.id, adjacencyId: adjacency.id },
      } satisfies Peer;
      const old = existing.get(item.sessionId);
      const session = normalizeSession({
        ...(old ?? {}),
        id: item.sessionId,
        nodeId: item.local.nodeId,
        peerId: peer.id,
        protocolName: old?.protocolName ?? protocolName(domain, remoteNode),
        localAddress: old?.localAddress ?? item.local.address,
        localAsn: domain.asn,
        localPort: old?.localPort ?? localNode.listenPort,
        sessionType: "ibgp",
        managedBy: peer.managedBy,
        bgp: {
          ...(old?.bgp ?? {}),
          rrClient: old?.bgp.rrClient ?? false,
          rrClusterId: old?.bgp.rrClusterId ?? null,
          connectionMode: old?.bgp.connectionMode ?? "multihop",
        },
        channels: old?.channels ?? {
          ipv4: { enabled: true },
          ipv6: { enabled: true },
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
