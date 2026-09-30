import type {
  ChangeEvent,
  DashboardResponse,
  InventoryHealth,
  NodeHealthSummary,
  NodeRuntime,
  ProtocolRuntime,
} from "../packages/contracts/src/api.js";
import type { Inventory, ManagedNode, Peer } from "../packages/contracts/src/inventory.js";
import { resourceAppliesToNode } from "../packages/contracts/src/resource-scope.js";
import { inspectNode } from "./bird.js";
import { redactDashboardResponse } from "./inventory-redaction.js";
import {
  configForNode,
  nodePeers,
  nodePolicyResources,
  nodeRPKIResources,
  nodeSessions,
  nodeStaticProtocols,
  nodeSourcePolicies,
} from "./inventory-domain.js";

interface DashboardServiceOptions {
  getEvents(): ChangeEvent[];
}

// Dashboard health is best-effort. A single offline/black-holed node must not
// hold the whole controller request open (or reject the dashboard altogether).
// Keep the timeout below the HTTP read timeout and convert failures into the
// same runtime shape used by the normal inspector.
const DASHBOARD_NODE_INSPECT_TIMEOUT_MS = 5_000;

export async function inspectNodeForDashboard(node: ManagedNode): Promise<NodeRuntime> {
  try {
    return await inspectNode(node, DASHBOARD_NODE_INSPECT_TIMEOUT_MS);
  } catch (error) {
    return {
      nodeId: node.id,
      reachable: false,
      bird2: false,
      version: null,
      protocols: [],
      error: error instanceof Error ? error.message.slice(0, 500) : "节点状态检查失败",
      raw: "",
    };
  }
}

export function protocolFor(
  runtime: Pick<NodeRuntime, "protocols">,
  protocolName: string,
): ProtocolRuntime {
  return runtime.protocols.find((item) => item.name === protocolName) ?? {
    name: protocolName,
    configured: false,
    disabled: false,
    state: null,
    established: false,
    neighbor: null,
    neighborAs: null,
    imported: null,
    exported: null,
  };
}

export function summarizeInventoryHealth(state: Inventory, runtimes: NodeRuntime[]): InventoryHealth {
  const runtimeByNodeId = new Map(runtimes.map((runtime) => [runtime.nodeId, runtime]));
  const nodeStatuses: NodeHealthSummary[] = [];
  let onlineNodes = 0;
  let activeSessions = 0;
  let normalSessions = 0;

  for (const node of state.nodes) {
    const runtime = runtimeByNodeId.get(node.id);
    const online = runtime?.reachable === true && runtime.bird2 === true;
    if (online) onlineNodes += 1;
    const activeNodeSessions = nodeSessions(state, node.id).filter((session) => session.enabled !== false);
    const normalNodeSessions = activeNodeSessions.filter((session) => {
      const protocol = protocolFor(runtime ?? { protocols: [] }, session.protocolName);
      return online && protocol.established && protocol.disabled !== true;
    });
    nodeStatuses.push({
      nodeId: node.id,
      name: node.name,
      status: !online ? "error" : normalNodeSessions.length < activeNodeSessions.length ? "warning" : "ready",
      reachable: runtime?.reachable === true,
      bird2: runtime?.bird2 === true,
      version: runtime?.version ?? null,
      error: runtime?.error ?? (!online ? "节点不可达或 BIRD 未运行" : null),
      activeSessions: activeNodeSessions.length,
      normalSessions: normalNodeSessions.length,
    });
    for (const session of nodeSessions(state, node.id)) {
      if (session.enabled === false) continue;
      activeSessions += 1;
      const protocol = protocolFor(runtime ?? { protocols: [] }, session.protocolName);
      if (online && protocol.established && protocol.disabled !== true) normalSessions += 1;
    }
  }

  const offlineNodes = state.nodes.length - onlineNodes;
  const abnormalSessions = activeSessions - normalSessions;
  return {
    status: offlineNodes > 0 ? "error" : abnormalSessions > 0 ? "warning" : "ready",
    totalNodes: state.nodes.length,
    onlineNodes,
    activeSessions,
    normalSessions,
    abnormalSessions,
    nodeStatuses,
  };
}

export function chooseEbgpSelection(
  state: Inventory,
  requestedNodeId: string | null,
  requestedPeerId: string | null,
): { node: ManagedNode | null; peer: Peer | null; peers: Peer[] } {
  const node = state.nodes.find((item) => item.id === requestedNodeId) ?? state.nodes[0];
  if (!node) return { node: null, peer: null, peers: [] };
  const peers = nodePeers(state, node.id).filter((peer) => {
    const session = state.sessions.find((item) => item.nodeId === node.id && item.peerId === peer.id);
    return peer.managedBy?.kind !== "ibgp-domain" && session?.sessionType !== "ibgp";
  });
  const peer = peers.find((item) => item.id === requestedPeerId) ?? peers[0] ?? null;
  return { node, peer, peers };
}

export class DashboardService {
  readonly #options: DashboardServiceOptions;

  constructor(options: DashboardServiceOptions) {
    this.#options = options;
  }

  async load(
    state: Inventory,
    requestedNodeId: string | null,
    requestedPeerId: string | null,
  ): Promise<DashboardResponse> {
    const selection = chooseEbgpSelection(state, requestedNodeId, requestedPeerId);
    if (!selection.node) {
      return redactDashboardResponse({
        inventory: state,
        selection: { nodeId: null, peerId: null },
        node: null,
        peers: [],
        cidrDefines: { ipv4: [], ipv6: [] },
        defines: [],
        functions: [],
        filters: [],
        rpki: [],
        staticProtocols: [],
        directProtocols: [],
        kernelProtocols: [],
        sourcePolicies: [],
        selectedPeer: null,
        runtime: {
          nodeId: null,
          reachable: false,
          bird2: false,
          version: null,
          protocols: [],
          error: "尚未添加受管节点",
        },
        health: summarizeInventoryHealth(state, []),
        established: false,
        config: "",
        events: this.#options.getEvents(),
      });
    }
    const selectedNode = selection.node;
    const runtimes = await Promise.all(state.nodes.map((node) => inspectNodeForDashboard(node)));
    const runtime = runtimes.find((item) => item.nodeId === selectedNode.id) ?? {
      nodeId: selectedNode.id,
      reachable: false,
      bird2: false,
      version: null,
      protocols: [],
      error: "节点状态不可用",
    };
    const peers = selection.peers.map((peer) => {
      const session = state.sessions.find((item) =>
        item.nodeId === selectedNode.id && item.peerId === peer.id,
      ) ?? null;
      return { ...peer, session, protocol: session ? protocolFor(runtime, session.protocolName) : null };
    });
    const selected = peers.find((item) => item.id === selection.peer?.id) ?? null;
    return redactDashboardResponse({
      inventory: state,
      selection: { nodeId: selectedNode.id, peerId: selected?.id ?? null },
      node: selectedNode,
      peers,
      cidrDefines: {
        ipv4: nodePolicyResources(state, "defines", selectedNode.id, true)
          .filter((item) => item.type === "cidr4"),
        ipv6: nodePolicyResources(state, "defines", selectedNode.id, true)
          .filter((item) => item.type === "cidr6"),
      },
      defines: nodePolicyResources(state, "defines", selectedNode.id, true),
      functions: nodePolicyResources(state, "functions", selectedNode.id, true),
      filters: nodePolicyResources(state, "filters", selectedNode.id, true),
      rpki: nodeRPKIResources(state, selectedNode.id, true),
      staticProtocols: nodeStaticProtocols(state, selectedNode.id, true),
      directProtocols: state.directProtocols.filter((item) => item.nodeId === selectedNode.id && item.enabled),
      kernelProtocols: state.kernelProtocols.filter((item) => resourceAppliesToNode(item, selectedNode.id) && item.enabled),
      sourcePolicies: nodeSourcePolicies(state, selectedNode.id, true),
      selectedPeer: selected,
      runtime,
      health: summarizeInventoryHealth(state, runtimes),
      established: selected?.protocol?.established ?? false,
      config: configForNode(state, selectedNode),
      events: this.#options.getEvents(),
    });
  }
}
