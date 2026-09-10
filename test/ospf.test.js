import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeOspfDomain, ospfProtocolName, renderBirdConfig, validateInventory } from "../src/bird.js";
import { parseOspfNeighborDetails, parseOspfSectionByTable } from "../src/bird-runtime.js";
import { parseRoutePath } from "../src/bird-runtime-parser.js";

const execFileAsync = promisify(execFile);
const node = (id, routerId) => ({ id, name: id, transport: "local", routerId, listenPort: 179 });
const policy = (formAction) => ({ mode: "form", steps: [{ type: "form" }], filterId: null, formAction });

test("parses BIRD OSPF neighbor sections with blank lines", () => {
  const raw = [
    "birdbox_ospf_demo_ospfv2:",
    "Router ID   Pri State      DTime Interface Router IP",
    "192.0.2.2  1 Full/PtP 30 eth0 192.0.2.2",
    "",
    "birdbox_ospf_demo_ospfv3:",
    "Router ID   Pri State      DTime Interface Router IP",
    "192.0.2.2  1 Full/PtP 30 eth0 fe80::2",
  ].join("\n");
  assert.deepEqual(parseOspfSectionByTable(raw, "birdbox_ospf_demo_ospfv2"), { state: "Full/PtP", neighbors: 1 });
});

test("parses OSPF neighbor details for the selected protocol", () => {
  const raw = [
    "internal_ospf:",
    "Router ID    Pri State      DTime Interface Router IP",
    "192.0.2.9  1 Full/PtP 30.123 eth9 192.0.2.9",
    "",
    "birdbox_ospf_demo_ospfv2:",
    "Router ID    Pri State      DTime Interface Router IP",
    "192.0.2.2  1 Full/PtP 31.5 bbtest 192.0.2.2",
    "192.0.2.3  0 Init - bbtest 192.0.2.3",
  ].join("\n");
  assert.deepEqual(parseOspfNeighborDetails(raw, "birdbox_ospf_demo_ospfv2", "ospfv2"), [
    { version: "ospfv2", routerId: "192.0.2.2", priority: 1, state: "Full/PtP", deadTime: 31.5, interface: "bbtest", address: "192.0.2.2" },
    { version: "ospfv2", routerId: "192.0.2.3", priority: 0, state: "Init", deadTime: null, interface: "bbtest", address: "192.0.2.3" },
  ]);
});

test("parses route lookup output and extracts next hops", () => {
  const raw = [
    "BIRD 2.18 ready.",
    "Table master4:",
    "203.0.113.0/24 unicast [ebgp_demo 12:00:00] * E 100",
    "\tvia 192.0.2.1 on eth0",
    "\tvia 192.0.2.2 on eth1",
  ].join("\n");
  const result = parseRoutePath(raw, "ipv4");
  assert.equal(result.table, "master4");
  assert.equal(result.routes.length, 1);
  assert.deepEqual(result.routes[0].nextHops, [
    { address: "192.0.2.1", interface: "eth0" },
    { address: "192.0.2.2", interface: "eth1" },
  ]);
});

function domain() {
  return { id: "ospf_main", name: "Main OSPF", nodeConfigs: ["n1", "n2"].map((nodeId) => ({ nodeId, enabled: true, versions: ["ospfv2", "ospfv3"], routerId: nodeId === "n1" ? "192.0.2.1" : "192.0.2.2", importPolicies: { ospfv2: policy("all"), ospfv3: policy("all") }, exportPolicies: { ospfv2: policy("none"), ospfv3: policy("none") }, exportDefineIds: { ospfv2: null, ospfv3: null }, bfd: false, gracefulRestart: true, redistributeStatic: false })), links: [{ id: "l1", fromNodeId: "n1", toNodeId: "n2", area: "0.0.0.0", localInterface: "eth0", remoteInterface: "eth1", cost: 20, hello: 10, dead: 40, passive: false, authentication: "none" }], layout: {} };
}

test("normalizes OSPF domain and renders both protocol versions", async () => {
  const d = normalizeOspfDomain(domain());
  assert.equal(d.links[0].options?.type, "ptp");
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [d]);
  assert.match(config, /protocol ospf v2/);
  assert.match(config, /protocol ospf v3/);
  assert.match(config, /interface "eth0"/);
  assert.match(config, /type ptp;/);
  assert.doesNotMatch(config, /interface "eth0" \{[\s\S]*authentication /);
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-ospf-")), "bird.conf");
  await fs.writeFile(file, config);
  await execFileAsync("bird", ["-p", "-c", file]);
});

test("automatically enables both OSPF endpoints when a link exists", () => {
  const input = domain();
  input.nodeConfigs = input.nodeConfigs.map((config) => ({ ...config, enabled: false }));
  const normalized = normalizeOspfDomain(input);
  assert.deepEqual(normalized.nodeConfigs.map((config) => config.enabled), [true, true]);
});

test("rejects an invalid OSPF Router ID before rendering", () => {
  const input = domain();
  input.nodeConfigs = input.nodeConfigs.map((config, index) => index === 0 ? { ...config, routerId: "not-an-ip" } : config);
  assert.throws(() => normalizeOspfDomain(input), /Router ID.*IPv4/);
});

test("keeps long OSPF domain protocol names unique and bounded", () => {
  const prefix = "ospf_domain_with_a_shared_long_prefix_that_would_collide_";
  const first = normalizeOspfDomain({ ...domain(), id: `${prefix}a` });
  const second = normalizeOspfDomain({ ...domain(), id: `${prefix}b` });
  const firstName = ospfProtocolName(first, "ospfv2");
  const secondName = ospfProtocolName(second, "ospfv2");
  assert.notEqual(firstName, secondName);
  assert.ok(firstName.length <= 60);
  assert.ok(secondName.length <= 60);
});

test("defaults OSPF link authentication to none without rendering an auth directive", () => {
  const input = domain();
  delete input.links[0].authentication;
  const normalized = normalizeOspfDomain(input);
  assert.equal(normalized.links[0].authentication, "none");
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [normalized]);
  assert.doesNotMatch(config, /interface "eth0" \{[\s\S]*?authentication /);
});

test("drops stale OSPF layout coordinates for removed nodes", () => {
  const d = normalizeOspfDomain({
    ...domain(),
    layout: {
      n1: { x: 42, y: 24 },
      removed_node: { x: 300, y: 200 },
    },
  });
  assert.deepEqual(d.layout, { n1: { x: 42, y: 24, locked: false } });
});

test("migrates OSPF domain coordinates into the node-scoped global layout", () => {
  const input = {
    version: 28,
    nodes: [node("n1", "192.0.2.1"), { ...node("n2", "192.0.2.2"), transport: "ssh", sshHost: "192.0.2.2", sshUser: "birdbox" }],
    peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [],
    sourcePolicies: [], sessions: [], ibgpDomains: [],
    ospfDomains: [{ ...domain(), layout: { n1: { x: 40, y: 50 } } }],
  };
  const migrated = validateInventory(input);
  assert.deepEqual(migrated.ospfLayout, { n1: { x: 40, y: 50, locked: false } });
  const overridden = validateInventory({ ...migrated, ospfLayout: { n1: { x: 80, y: 90 } } });
  assert.deepEqual(overridden.ospfLayout, { n1: { x: 80, y: 90, locked: false } });
});

test("rejects inconsistent parallel-link cost and reused interfaces", () => {
  assert.throws(() => normalizeOspfDomain({ ...domain(), links: [domain().links[0], { ...domain().links[0], id: "l2", localInterface: "eth2", remoteInterface: "eth3", cost: 30 }] }), /Cost/);
  assert.throws(() => normalizeOspfDomain({ ...domain(), links: [domain().links[0], { ...domain().links[0], id: "l2" }] }), /接口/);
});

test("allows shared NBMA interfaces with consistent link parameters", () => {
  const base = domain();
  const shared = { type: "nbma", checkLink: true, deadMode: "count" };
  const d = normalizeOspfDomain({
    ...base,
    links: [
      { ...base.links[0], options: shared },
      { ...base.links[0], id: "l2", localInterface: "eth0", remoteInterface: "eth2", options: shared },
    ],
  });
  assert.equal(d.links.length, 2);
});

test("validates OSPF node references", () => {
  assert.throws(() => validateInventory({ version: 28, nodes: [node("n1", "192.0.2.1")], peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], sourcePolicies: [], sessions: [], ibgpDomains: [], ospfDomains: [{ ...domain(), nodeConfigs: domain().nodeConfigs.filter((item) => item.nodeId === "n1") }] }), /不存在的节点|链路两端/);
});

test("normalizes and renders BIRD OSPF advanced protocol and interface options", () => {
  const d = normalizeOspfDomain({ ...domain(), nodeConfigs: domain().nodeConfigs.map((config) => ({ ...config, protocolOptions: { rfc1583compat: true, rfc5838: false, instanceId: 7, stubRouter: true, tick: 2, ecmp: true, ecmpLimit: 8, mergeExternal: true, gracefulRestartMode: "on", gracefulRestartTime: 90 }, areaOptions: { "0.0.0.0": { networks: [{ prefix: "192.0.2.0/24", hidden: true }] } }, virtualLinks: [{ id: "192.0.2.9", area: "1.1.1.1", hello: 10, dead: 40 }] })), links: [{ ...domain().links[0], options: { type: "ptp", poll: 20, retransmit: 5, transmitDelay: 1, priority: 10, wait: 40, deadMode: "seconds", rxBuffer: "large", txLength: 1400, linkLsaSuppression: true, strictNonbroadcast: true, realBroadcast: true, ptpNetmask: true, ptpAddress: true, secondary: true, checkLink: false, ecmpWeight: 2, ttlSecurity: "tx-only", txClass: 46, txDscp: 46, txPriority: 3, password: "secret", passwordOptions: { id: 7, algorithm: "hmac-sha256" }, neighbors: [{ address: "192.0.2.2", eligible: true }] } }] });
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [d]);
  for (const expected of ["rfc1583compat yes;", "rfc5838 no;", "instance id 7;", "stub router yes;", "ecmp yes limit 8;", "merge external yes;", "type ptp;", "dead 40;", "rx buffer large;", "ttl security tx only;", "algorithm hmac sha256;", "neighbors {", "virtual link 192.0.2.9"]) assert.match(config, new RegExp(expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  assert.doesNotMatch(config, /secondary yes;/);
});

test("filters OSPF interface options by address-family support", async () => {
  const base = domain();
  const input = normalizeOspfDomain({
    ...base,
    links: [{ ...base.links[0], options: {
      type: "ptp", deadMode: "seconds", linkLsaSuppression: true,
      realBroadcast: true, ptpNetmask: true, ptpAddress: true, secondary: true,
    } }],
  });
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [input]);
  const v2 = config.match(/protocol ospf v2[\s\S]*?(?=\nprotocol ospf v3|$)/)?.[0] ?? "";
  const v3 = config.match(/protocol ospf v3[\s\S]*/)?.[0] ?? "";
  assert.match(v2, /real broadcast yes;/);
  assert.match(v2, /ptp netmask yes;/);
  assert.match(v2, /ptp address yes;/);
  assert.doesNotMatch(v2, /link lsa suppression yes;/);
  assert.match(v3, /link lsa suppression yes;/);
  assert.doesNotMatch(v3, /real broadcast yes;/);
  assert.doesNotMatch(v3, /ptp netmask yes;/);
  assert.doesNotMatch(v3, /ptp address yes;/);
  assert.doesNotMatch(config, /secondary yes;/);
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-ospf-family-")), "bird.conf");
  await fs.writeFile(file, config);
  await execFileAsync("bird", ["-p", "-c", file]);
});
