import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expandIbgpDomain, normalizeIbgpDomain, renderBirdConfig, validateInventory } from "../src/bird.js";

const nodes = [
  { id: "rr", kind: "managed-node", name: "RR", transport: "local", routerId: "192.0.2.1", listenPort: 179 },
  { id: "client", kind: "managed-node", name: "Client", transport: "ssh", sshHost: "192.0.2.2", sshUser: "bird", routerId: "192.0.2.2", listenPort: 179 },
];

test("expands a route-reflector iBGP adjacency into equal-ASN sessions", () => {
  const domain = normalizeIbgpDomain({
    id: "core",
    name: "Core iBGP",
    asn: 65000,
    topology: "manual",
    families: ["ipv4"],
    defaultClusterId: "192.0.2.254",
    members: [
      { nodeId: "rr", address4: "192.0.2.1", role: "reflector" },
      { nodeId: "client", address4: "192.0.2.2", role: "client" },
    ],
    adjacencies: [{ id: "core_rr_client", leftNodeId: "rr", rightNodeId: "client", leftSessionId: "core_left", rightSessionId: "core_right" }],
  });
  const expanded = expandIbgpDomain(domain, nodes);
  assert.equal(expanded.sessions.length, 2);
  assert.equal(expanded.sessions[0].sessionType, "ibgp");
  assert.equal(expanded.sessions[0].localAsn, expanded.peers[0].asn);
  assert.equal(expanded.sessions[0].bgp.rrClient, true);
  assert.equal(expanded.sessions[1].bgp.rrClient, false);
  const inventory = validateInventory({ version: 21, nodes, peers: expanded.peers, defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], sessions: expanded.sessions, ibgpDomains: [domain] });
  const config = renderBirdConfig(nodes[0], expanded.peers.filter((peer) => peer.nodeId === "rr"), expanded.sessions.filter((session) => session.nodeId === "rr"));
  assert.match(config, /local 192\.0\.2\.1 port 179 as 65000;/);
  assert.match(config, /neighbor 192\.0\.2\.2 port 179 as 65000;/);
  assert.match(config, /rr client;/);
  const directory = mkdtempSync(path.join(tmpdir(), "birdbox-ibgp-"));
  const configPath = path.join(directory, "bird.conf");
  writeFileSync(configPath, config);
  const result = spawnSync("bird", ["-p", "-c", configPath], { encoding: "utf8" });
  rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(inventory.ibgpDomains[0]?.id, "core");
});
