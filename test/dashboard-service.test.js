import test from "node:test";
import assert from "node:assert/strict";

import { chooseEbgpSelection } from "../src/dashboard-service.js";

test("excludes iBGP-managed peers from the eBGP dashboard selection", () => {
  const state = {
    nodes: [{ id: "local", name: "Local" }],
    peers: [
      { id: "external", nodeId: "local", name: "External", address: "192.0.2.2", asn: 64513, port: 179 },
      {
        id: "internal",
        nodeId: "local",
        name: "Internal",
        address: "192.0.2.3",
        asn: 64512,
        port: 179,
        managedBy: { kind: "ibgp-domain", domainId: "core", adjacencyId: "core_local_internal" },
      },
    ],
    sessions: [
      { id: "external_session", nodeId: "local", peerId: "external", sessionType: "ebgp" },
      { id: "internal_session", nodeId: "local", peerId: "internal", sessionType: "ibgp" },
    ],
  };

  const selection = chooseEbgpSelection(state, "local", "internal");
  assert.deepEqual(selection.peers.map((peer) => peer.id), ["external"]);
  assert.equal(selection.peer?.id, "external");

  const iBGPOnly = chooseEbgpSelection({ ...state, peers: [state.peers[1]], sessions: [state.sessions[1]] }, "local", null);
  assert.deepEqual(iBGPOnly.peers, []);
  assert.equal(iBGPOnly.peer, null);
});
