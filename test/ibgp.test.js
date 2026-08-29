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

test("expands a manual iBGP adjacency into independently configurable equal-ASN sessions", () => {
  const domain = normalizeIbgpDomain({
    id: "core",
    name: "Core iBGP",
    asn: 65000,
    members: [
      { nodeId: "rr", address: "192.0.2.1" },
      { nodeId: "client", address: "192.0.2.2" },
    ],
    adjacencies: [{ id: "core_rr_client", leftNodeId: "rr", rightNodeId: "client", leftSessionId: "core_left", rightSessionId: "core_right" }],
  });
  assert.deepEqual(domain.members.map((member) => member.address), ["192.0.2.1", "192.0.2.2"]);
  const expanded = expandIbgpDomain(domain, nodes);
  assert.equal(expanded.sessions.length, 2);
  assert.equal(expanded.sessions[0].sessionType, "ibgp");
  assert.equal(expanded.sessions[0].localAsn, expanded.peers[0].asn);
  assert.equal(expanded.sessions[0].bgp.rrClient, false);
  assert.equal(expanded.sessions[1].bgp.rrClient, false);
  expanded.sessions[0].bgp.rrClient = true;
  expanded.sessions[0].bgp.rrClusterId = "192.0.2.254";
  const configured = expandIbgpDomain(domain, nodes, expanded.sessions);
  const inventory = validateInventory({ version: 25, nodes, peers: configured.peers, defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], sessions: configured.sessions, ibgpDomains: [domain] });
  const config = renderBirdConfig(nodes[0], configured.peers.filter((peer) => peer.nodeId === "rr"), configured.sessions.filter((session) => session.nodeId === "rr"));
  assert.match(config, /local 192\.0\.2\.1 port 179 as 65000;/);
  assert.match(config, /neighbor 192\.0\.2\.2 port 179 as 65000;/);
  assert.match(config, /rr client;/);
  assert.match(config, /rr cluster id 192\.0\.2\.254;/);
  configured.sessions[0].bgp.rrClient = false;
  const clusterOnlyConfig = renderBirdConfig(nodes[0], configured.peers.filter((peer) => peer.nodeId === "rr"), configured.sessions.filter((session) => session.nodeId === "rr"));
  assert.doesNotMatch(clusterOnlyConfig, /rr client;/);
  assert.match(clusterOnlyConfig, /rr cluster id 192\.0\.2\.254;/);
  const directory = mkdtempSync(path.join(tmpdir(), "birdbox-ibgp-"));
  const configPath = path.join(directory, "bird.conf");
  writeFileSync(configPath, clusterOnlyConfig);
  const result = spawnSync("bird", ["-p", "-c", configPath], { encoding: "utf8" });
  rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(inventory.ibgpDomains[0]?.id, "core");
});

test("maps each iBGP neighbor port to the opposite session local port", () => {
  const domain = normalizeIbgpDomain({
    id: "ports", name: "Port test", asn: 65000,
    members: [{ nodeId: "rr", address: "192.0.2.1" }, { nodeId: "client", address: "192.0.2.2" }],
    adjacencies: [{ id: "ports_adj", leftNodeId: "rr", rightNodeId: "client", leftSessionId: "ports_left", rightSessionId: "ports_right" }],
  });
  const initial = expandIbgpDomain(domain, nodes);
  initial.sessions[0].localPort = 1179;
  initial.sessions[1].localPort = 2179;
  const expanded = expandIbgpDomain(domain, nodes, initial.sessions);
  assert.equal(expanded.peers.find((peer) => peer.nodeId === "rr")?.port, 2179);
  assert.equal(expanded.peers.find((peer) => peer.nodeId === "client")?.port, 1179);
});
