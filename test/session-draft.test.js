import test from "node:test";
import assert from "node:assert/strict";

import {
  createSessionDraft,
  defaultChannel,
  defaultProtocolName,
  toSessionMutationRequest,
} from "../apps/web/src/sessions/session-draft.ts";

function inventory() {
  return {
    version: 20,
    nodes: [{ id: "node", kind: "managed-node", name: "Node", transport: "local", sshHost: null, sshPort: null, sshUser: null, sshIdentity: "default", deploymentMode: "legacy", mainConfigPath: "/etc/bird/bird.conf", generatedConfigPath: "/tmp/generated.conf", socketPath: "/run/bird/bird.ctl", routerId: "192.0.2.1", listenPort: 179 }],
    peers: [{ id: "peer", nodeId: "node", name: "香港 Peer", address: "2001:db8::2", asn: 64513, port: 179 }],
    defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], sessions: [],
  };
}

test("creates a new session draft with stable defaults and a unique BIRD name", () => {
  const value = inventory();
  value.sessions.push({ protocolName: "bgp_xiang_gang_peer" });
  assert.equal(defaultProtocolName(value, value.peers[0]), "bgp_xiang_gang_peer_2");
  const dashboard = { inventory: value, node: value.nodes[0], selectedPeer: value.peers[0] };
  const draft = createSessionDraft(dashboard);
  assert.equal(draft.localAddress, null);
  assert.equal(draft.localPort, 179);
  assert.equal(draft.localAsn, null);
  assert.equal(draft.channels.ipv4.importPolicy.mode, "combined");
  assert.deepEqual(draft.channels.ipv4.importPolicy.steps, [{ type: "form" }]);
});

test("clones an existing session without mutating the dashboard snapshot", () => {
  const value = inventory();
  const session = {
    id: "session", nodeId: "node", peerId: "peer", protocolName: "bgp_existing",
    localAddress: null, localAsn: 64512, localPort: 179, enabled: true,
    bgp: { connectionMode: "direct" }, channels: { ipv4: defaultChannel(), ipv6: defaultChannel() },
  };
  const peer = { ...value.peers[0], session };
  const draft = createSessionDraft({ inventory: value, node: value.nodes[0], selectedPeer: peer });
  draft.channels.ipv4.enabled = false;
  assert.equal(session.channels.ipv4.enabled, true);
});

test("forces Extended Next Hop for IPv4 over an IPv6 neighbor", () => {
  const value = inventory();
  const dashboard = { inventory: value, node: value.nodes[0], selectedPeer: value.peers[0] };
  const draft = createSessionDraft(dashboard);
  draft.localAsn = 64512;
  draft.channels.ipv4.extendedNextHop = false;
  const payload = toSessionMutationRequest(draft, value.peers[0]);
  assert.equal(payload.channels.ipv4.extendedNextHop, true);
  assert.equal(payload.channels.ipv6.extendedNextHop, false);

  const ipv4Peer = { ...value.peers[0], address: "192.0.2.2" };
  const ipv4TransportPayload = toSessionMutationRequest(draft, ipv4Peer);
  assert.equal(ipv4TransportPayload.channels.ipv6.extendedNextHop, false);
});
