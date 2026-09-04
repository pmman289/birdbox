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

test("uses a node IGP address for new iBGP drafts without rewriting existing addresses", () => {
  const transportNodes = [
    { ...nodes[0], routerId: "198.51.100.1", igpAddress: "10.0.0.1" },
    { ...nodes[1], routerId: "198.51.100.2", igpAddress: "10.0.0.2" },
  ];
  const domain = normalizeIbgpDomain({
    id: "igp", name: "IGP transport", asn: 65000,
    members: [{ nodeId: "rr", address: "10.0.0.1" }, { nodeId: "client", address: "10.0.0.2" }],
    adjacencies: [{ id: "igp_adj", leftNodeId: "rr", rightNodeId: "client", leftSessionId: "igp_left", rightSessionId: "igp_right" }],
  });
  const initial = expandIbgpDomain(domain, transportNodes);
  assert.equal(initial.sessions[0].localAddress, "10.0.0.1");
  assert.equal(initial.peers[0].address, "10.0.0.2");
  const preserved = expandIbgpDomain(domain, transportNodes, [{ ...initial.sessions[0], localAddress: "10.0.1.1" }]);
  assert.equal(preserved.sessions[0].localAddress, "10.0.1.1");
});

test("supports a three-node route-reflector domain and keeps separate domains isolated", () => {
  const rrNodes = [
    { id: "rr", kind: "managed-node", name: "Route Reflector", transport: "local", routerId: "192.0.2.1", igpAddress: "10.0.0.1", listenPort: 179 },
    { id: "c1", kind: "managed-node", name: "Client One", transport: "ssh", sshHost: "192.0.2.2", sshUser: "bird", routerId: "192.0.2.2", igpAddress: "10.0.0.2", listenPort: 179 },
    { id: "c2", kind: "managed-node", name: "Client Two", transport: "ssh", sshHost: "192.0.2.3", sshUser: "bird", routerId: "192.0.2.3", igpAddress: "10.0.0.3", listenPort: 179 },
  ];
  const domain = normalizeIbgpDomain({
    id: "rr_domain", name: "RR Domain", asn: 65000,
    members: rrNodes.map((node) => ({ nodeId: node.id, address: node.igpAddress })),
    adjacencies: [
      { id: "rr_c1", leftNodeId: "rr", rightNodeId: "c1", leftSessionId: "rr_c1_left", rightSessionId: "rr_c1_right" },
      { id: "rr_c2", leftNodeId: "rr", rightNodeId: "c2", leftSessionId: "rr_c2_left", rightSessionId: "rr_c2_right" },
    ],
  });
  const expanded = expandIbgpDomain(domain, rrNodes);
  for (const session of expanded.sessions.filter((item) => item.nodeId === "rr")) {
    session.bgp.rrClient = true;
    session.bgp.rrClusterId = "192.0.2.254";
  }
  const second = normalizeIbgpDomain({
    id: "plain_domain", name: "Plain Domain", asn: 65000,
    members: [{ nodeId: "c1", address: "10.0.0.2" }, { nodeId: "c2", address: "10.0.0.3" }],
    adjacencies: [{ id: "plain_c1_c2", leftNodeId: "c1", rightNodeId: "c2", leftSessionId: "plain_left", rightSessionId: "plain_right" }],
  });
  const expandedSecond = expandIbgpDomain(second, rrNodes);
  const inventory = validateInventory({
    version: 25, nodes: rrNodes,
    peers: [...expanded.peers, ...expandedSecond.peers], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [],
    sessions: [...expanded.sessions, ...expandedSecond.sessions], ibgpDomains: [domain, second],
  });
  const rrConfig = renderBirdConfig(rrNodes[0], inventory.peers.filter((peer) => peer.nodeId === "rr"), inventory.sessions.filter((session) => session.nodeId === "rr"));
  assert.match(rrConfig, /neighbor 10\.0\.0\.2 port 179 as 65000;/);
  assert.match(rrConfig, /neighbor 10\.0\.0\.3 port 179 as 65000;/);
  assert.equal((rrConfig.match(/rr client;/g) ?? []).length, 2);
  assert.equal((rrConfig.match(/rr cluster id 192\.0\.2\.254;/g) ?? []).length, 2);
  const directory = mkdtempSync(path.join(tmpdir(), "birdbox-rr-"));
  const configPath = path.join(directory, "bird.conf");
  writeFileSync(configPath, rrConfig);
  const result = spawnSync("bird", ["-p", "-c", configPath], { encoding: "utf8" });
  rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(inventory.sessions.filter((session) => session.managedBy?.domainId === "rr_domain").length, 4);
  assert.equal(inventory.sessions.filter((session) => session.managedBy?.domainId === "plain_domain").length, 2);
});
