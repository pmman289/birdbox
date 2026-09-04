import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeOspfDomain, renderBirdConfig, validateInventory } from "../src/bird.js";
import { parseOspfSectionByTable } from "../src/bird-runtime.js";

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

function domain() {
  return { id: "ospf_main", name: "Main OSPF", nodeConfigs: ["n1", "n2"].map((nodeId) => ({ nodeId, enabled: true, versions: ["ospfv2", "ospfv3"], routerId: nodeId === "n1" ? "192.0.2.1" : "192.0.2.2", importPolicies: { ospfv2: policy("all"), ospfv3: policy("all") }, exportPolicies: { ospfv2: policy("none"), ospfv3: policy("none") }, exportDefineIds: { ospfv2: null, ospfv3: null }, bfd: false, gracefulRestart: true, redistributeStatic: false })), links: [{ id: "l1", fromNodeId: "n1", toNodeId: "n2", area: "0.0.0.0", localInterface: "eth0", remoteInterface: "eth1", cost: 20, hello: 10, dead: 40, passive: false, authentication: "none" }], layout: {} };
}

test("normalizes OSPF domain and renders both protocol versions", async () => {
  const d = normalizeOspfDomain(domain());
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [d]);
  assert.match(config, /protocol ospf v2/);
  assert.match(config, /protocol ospf v3/);
  assert.match(config, /interface "eth0"/);
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-ospf-")), "bird.conf");
  await fs.writeFile(file, config);
  await execFileAsync("bird", ["-p", "-c", file]);
});

test("rejects inconsistent parallel-link cost and reused interfaces", () => {
  assert.throws(() => normalizeOspfDomain({ ...domain(), links: [domain().links[0], { ...domain().links[0], id: "l2", localInterface: "eth2", remoteInterface: "eth3", cost: 30 }] }), /Cost/);
  assert.throws(() => normalizeOspfDomain({ ...domain(), links: [domain().links[0], { ...domain().links[0], id: "l2" }] }), /接口/);
});

test("validates OSPF node references", () => {
  assert.throws(() => validateInventory({ version: 28, nodes: [node("n1", "192.0.2.1")], peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], sourcePolicies: [], sessions: [], ibgpDomains: [], ospfDomains: [{ ...domain(), nodeConfigs: domain().nodeConfigs.filter((item) => item.nodeId === "n1") }] }), /不存在的节点|链路两端/);
});

test("normalizes and renders BIRD OSPF advanced protocol and interface options", () => {
  const d = normalizeOspfDomain({ ...domain(), nodeConfigs: domain().nodeConfigs.map((config) => ({ ...config, protocolOptions: { rfc1583compat: true, rfc5838: false, instanceId: 7, stubRouter: true, tick: 2, ecmp: true, ecmpLimit: 8, mergeExternal: true, gracefulRestartMode: "on", gracefulRestartTime: 90 }, areaOptions: { "0.0.0.0": { networks: [{ prefix: "192.0.2.0/24", hidden: true }] } }, virtualLinks: [{ id: "192.0.2.9", area: "1.1.1.1", hello: 10, dead: 40 }] })), links: [{ ...domain().links[0], options: { type: "ptp", poll: 20, retransmit: 5, transmitDelay: 1, priority: 10, wait: 40, deadMode: "seconds", rxBuffer: "large", txLength: 1400, linkLsaSuppression: true, strictNonbroadcast: true, realBroadcast: true, ptpNetmask: true, ptpAddress: true, secondary: true, checkLink: false, ecmpWeight: 2, ttlSecurity: "tx-only", txClass: 46, txDscp: 46, txPriority: 3, password: "secret", passwordOptions: { id: 7, algorithm: "hmac-sha256" }, neighbors: [{ address: "192.0.2.2", eligible: true }] } }] });
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [d]);
  for (const expected of ["rfc1583compat yes;", "rfc5838 no;", "instance id 7;", "stub router yes;", "ecmp yes limit 8;", "merge external yes;", "type ptp;", "dead 40;", "rx buffer large;", "ttl security tx only;", "secondary yes;", "algorithm hmac sha256;", "neighbors {", "virtual link 192.0.2.9"]) assert.match(config, new RegExp(expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
});
