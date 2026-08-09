import type {
  ChangeEvent,
  DashboardResponse,
  InventoryHealth,
  NodeRuntime,
  ProtocolRuntime,
} from "../packages/contracts/src/api.js";
import type { Inventory, ManagedNode, Peer } from "../packages/contracts/src/inventory.js";
import { inspectNode } from "./bird.js";
import {
  configForNode,
  nodePeers,
  nodePolicyResources,
  nodeRPKIResources,
  nodeSessions,
  nodeStaticProtocols,
} from "./inventory-domain.js";

interface DashboardServiceOptions {
  getEvents(): ChangeEvent[];
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
  let onlineNodes = 0;
  let activeSessions = 0;
  let normalSessions = 0;

  for (const node of state.nodes) {
    const runtime = runtimeByNodeId.get(node.id);
    const online = runtime?.reachable === true && runtime.bird2 === true;
    if (online) onlineNodes += 1;
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
  };
}

function chooseSelection(
  state: Inventory,
  requestedNodeId: string | null,
  requestedPeerId: string | null,
): { node: ManagedNode | null; peer: Peer | null; peers: Peer[] } {
  const node = state.nodes.find((item) => item.id === requestedNodeId) ?? state.nodes[0];
  if (!node) return { node: null, peer: null, peers: [] };
  const peers = nodePeers(state, node.id);
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
    const selection = chooseSelection(state, requestedNodeId, requestedPeerId);
    if (!selection.node) {
      return {
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
      };
    }
    const selectedNode = selection.node;
    const runtimes = await Promise.all(state.nodes.map((node) => inspectNode(node)));
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
    return {
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
      selectedPeer: selected,
      runtime,
      health: summarizeInventoryHealth(state, runtimes),
      established: selected?.protocol?.established ?? false,
      config: configForNode(state, selectedNode),
      events: this.#options.getEvents(),
    };
  }
}
