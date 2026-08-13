import assert from "node:assert/strict";
import test from "node:test";

import { sessionProtocolEnabledSnapshot } from "../apps/web/src/dashboard/session-control-state.ts";

test("updates the selected session control state immediately after stopping and starting", () => {
  const protocol = {
    name: "peer_bgp", configured: true, disabled: false, state: "Established", established: true,
    neighbor: "192.0.2.2", neighborAs: 65002, imported: 5, exported: 1,
  };
  const session = { id: "session_peer", nodeId: "node_a", peerId: "peer_a", protocolName: "peer_bgp", enabled: true };
  const peer = { id: "peer_a", nodeId: "node_a", name: "Peer", address: "192.0.2.2", asn: 65002, port: 179, session, protocol };
  const dashboard = {
    inventory: { sessions: [session] },
    peers: [peer], selectedPeer: peer,
    runtime: { protocols: [protocol] },
    established: true,
    health: { status: "ready", totalNodes: 1, onlineNodes: 1, activeSessions: 1, normalSessions: 1, abnormalSessions: 0 },
  };
  const stopped = sessionProtocolEnabledSnapshot(dashboard, session.id, false);
  assert.equal(stopped.selectedPeer.protocol.disabled, true);
  assert.equal(stopped.selectedPeer.protocol.established, false);
  assert.equal(stopped.runtime.protocols[0].disabled, true);
  assert.equal(stopped.health.normalSessions, 0);
  assert.equal(stopped.health.abnormalSessions, 1);
  const started = sessionProtocolEnabledSnapshot(stopped, session.id, true);
  assert.equal(started.selectedPeer.protocol.disabled, false);
});
