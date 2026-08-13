import type { DashboardResponse } from "@birdbox/contracts/api";

export function sessionProtocolEnabledSnapshot(
  current: DashboardResponse,
  sessionId: string,
  enabled: boolean,
): DashboardResponse {
  const session = current.inventory.sessions.find((item) => item.id === sessionId);
  if (!session) return current;
  const previousProtocol = current.runtime.protocols.find((item) => item.name === session.protocolName) ?? null;
  const updateProtocol = <Protocol extends { name: string; disabled: boolean; established: boolean; state: string | null }>(protocol: Protocol): Protocol => protocol.name === session.protocolName
    ? { ...protocol, disabled: !enabled, established: false, state: enabled ? protocol.state : "Idle" }
    : protocol;
  const runtimeProtocols = current.runtime.protocols.map(updateProtocol);
  const peers = current.peers.map((peer) => peer.session?.id === sessionId && peer.protocol
    ? { ...peer, protocol: updateProtocol(peer.protocol) }
    : peer);
  const selectedPeer = peers.find((peer) => peer.id === current.selectedPeer?.id) ?? null;
  const lostEstablishedSession = previousProtocol?.established === true ? 1 : 0;
  const normalSessions = Math.max(0, current.health.normalSessions - lostEstablishedSession);
  return {
    ...current,
    peers,
    selectedPeer,
    runtime: { ...current.runtime, protocols: runtimeProtocols },
    established: selectedPeer?.protocol?.established ?? false,
    health: {
      ...current.health,
      normalSessions,
      abnormalSessions: current.health.activeSessions - normalSessions,
      status: current.health.onlineNodes < current.health.totalNodes
        ? "error"
        : current.health.activeSessions > normalSessions ? "warning" : "ready",
    },
  };
}
