import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeOspfDomain, normalizePolicyFilter, normalizePolicyFunction, ospfProtocolName, renderBirdConfig, validateInventory } from "../src/bird.js";
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

test("allows node-scoped OSPF policy resources on the matching endpoint", () => {
  const base = domain();
  const functionResource = normalizePolicyFunction({
    id: "fn_n1", nodeIds: ["n1"], label: "Node one function", name: "ospf_node_one", enabled: true,
    callable: true, source: "function ospf_node_one() { return true; }",
  });
  const policyWithFunction = { ...policy("all"), mode: "combined", steps: [{ type: "function", functionId: functionResource.id, action: "execute" }] };
  base.nodeConfigs[0].importPolicies.ospfv2 = policyWithFunction;
  const inventory = validateInventory({
    version: 28,
    nodes: [node("n1", "192.0.2.1"), { ...node("n2", "192.0.2.2"), transport: "ssh", sshHost: "n2.example" }],
    peers: [], defines: [], functions: [functionResource], filters: [], rpki: [], staticProtocols: [],
    directProtocols: [], kernelProtocols: [], sourcePolicies: [], sessions: [], ibgpDomains: [],
    ospfDomains: [base], ospfLayout: {},
  });
  assert.equal(inventory.functions[0].nodeIds?.[0], "n1");
});

test("preserves explicit OSPF import and export all actions through normalization", () => {
  const input = domain();
  input.nodeConfigs[0].exportPolicies = { ospfv2: policy("all"), ospfv3: policy("all") };
  const normalized = normalizeOspfDomain(input);
  assert.equal(normalized.nodeConfigs[0].exportPolicies.ospfv2.formAction, "all");
  assert.equal(normalized.nodeConfigs[0].exportPolicies.ospfv3.formAction, "all");
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [normalized]);
  assert.equal((config.match(/export all;/g) ?? []).length, 2);
});

test("defaults missing legacy OSPF policies separately for each version", () => {
  const input = { ...domain(), nodeConfigs: [{ nodeId: "n1", versions: ["ospfv2", "ospfv3"] }], links: [] };
  const normalized = normalizeOspfDomain(input);
  assert.equal(normalized.nodeConfigs[0].importPolicies.ospfv2.formAction, "all");
  assert.equal(normalized.nodeConfigs[0].exportPolicies.ospfv2.formAction, "none");
  assert.equal(normalized.nodeConfigs[0].exportPolicies.ospfv3.formAction, "none");
});

test("rejects CIDR mode on OSPF import policies", () => {
  const input = domain();
  input.nodeConfigs[0].importPolicies.ospfv2 = policy("cidr");
  assert.throws(() => normalizeOspfDomain(input), /导入策略不支持 CIDR/);
});

test("keeps endpoint interface options and neighbors independent", () => {
  const input = domain();
  input.links[0].localOptions = { type: "nbma", neighbors: [{ address: "192.0.2.2", eligible: true }, { address: "2001:db8::2", eligible: true }], deadMode: "seconds", checkLink: true };
  input.links[0].remoteOptions = { type: "ptp", neighbors: [], deadMode: "count", checkLink: false };
  const normalized = normalizeOspfDomain(input);
  assert.equal(normalized.links[0].localOptions.type, "nbma");
  assert.equal(normalized.links[0].remoteOptions.type, "ptp");
  const local = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [normalized]);
  const remote = renderBirdConfig(node("n2", "192.0.2.2"), [], [], [], [], [], [], [], [], [normalized]);
  assert.match(local, /type nbma;/);
  assert.match(local, /192\.0\.2\.2 eligible;/);
  assert.match(remote, /type ptp;/);
  assert.match(remote, /dead count 4;/);
  assert.match(remote, /check link no;/);
  assert.doesNotMatch(remote, /192\.0\.2\.2 eligible;/);
});

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

test("adds a global BFD instance when OSPF requests interface BFD", async () => {
  const input = domain();
  input.nodeConfigs[0].bfd = true;
  const normalized = normalizeOspfDomain(input);
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [normalized]);
  assert.match(config, /interface "eth0"[\s\S]*bfd yes;/);
  assert.match(config, /protocol bfd birdbox_bfd \{\n\}/);
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-ospf-bfd-")), "bird.conf");
  await fs.writeFile(file, config);
  await execFileAsync("bird", ["-p", "-c", file]);
});

test("keeps explicitly disabled OSPF endpoints disabled while preserving topology", () => {
  const input = domain();
  input.nodeConfigs = input.nodeConfigs.map((config) => ({ ...config, enabled: false }));
  const normalized = normalizeOspfDomain(input);
  assert.deepEqual(normalized.nodeConfigs.map((config) => config.enabled), [false, false]);
  assert.equal(normalized.links.length, 1);
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [normalized]);
  assert.doesNotMatch(config, /protocol ospf/);
});

test("omits enabled OSPF protocols until a node has an area", async () => {
  const input = {
    ...domain(),
    nodeConfigs: [{ ...domain().nodeConfigs[0], versions: ["ospfv2", "ospfv3"] }],
    links: [],
  };
  const normalized = normalizeOspfDomain(input);
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [normalized]);
  assert.doesNotMatch(config, /protocol ospf/);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-ospf-empty-"));
  try {
    const file = path.join(directory, "bird.conf");
    await fs.writeFile(file, config);
    await execFileAsync("bird", ["-p", "-c", file]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rejects an invalid OSPF Router ID before rendering", () => {
  const input = domain();
  input.nodeConfigs = input.nodeConfigs.map((config, index) => index === 0 ? { ...config, routerId: "not-an-ip" } : config);
  assert.throws(() => normalizeOspfDomain(input), /Router ID.*IPv4/);
});

test("rejects malformed OSPF interface names before rendering", () => {
  const input = domain();
  input.links[0].localInterface = "eth0\" }; protocol static injected {";
  assert.throws(() => normalizeOspfDomain(input), /接口名称无效/);
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

test("does not emit orphaned OSPF passwords when authentication is disabled", async () => {
  const input = normalizeOspfDomain({
    ...domain(),
    links: [{ ...domain().links[0], options: { type: "ptp", password: "stale-secret", passwordOptions: { algorithm: "hmac-sha256" } } }],
  });
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [input]);
  assert.doesNotMatch(config, /stale-secret|password/);
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-ospf-password-")), "bird.conf");
  await fs.writeFile(file, config);
  await execFileAsync("bird", ["-p", "-c", file]);
});

test("drops stale OSPF layout coordinates for removed nodes", () => {
  const d = normalizeOspfDomain({
    ...domain(),
    layout: {
      n1: { x: 42, y: 24 },
      removed_node: { x: 300, y: 200 },
      n2: { x: "not-a-number", y: Infinity },
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
      { ...base.links[0], localOptions: { ...shared, neighbors: [{ address: "192.0.2.2" }, { address: "2001:db8::2" }] }, remoteOptions: { ...shared, neighbors: [{ address: "192.0.2.1" }, { address: "2001:db8::1" }] } },
      { ...base.links[0], id: "l2", localInterface: "eth0", remoteInterface: "eth2", localOptions: { ...shared, neighbors: [{ address: "192.0.2.2" }, { address: "2001:db8::2" }] }, remoteOptions: { ...shared, neighbors: [{ address: "192.0.2.1" }, { address: "2001:db8::1" }] } },
    ],
  });
  assert.equal(d.links.length, 2);
});

test("renders explicit NBMA interface addresses without inferring Router IDs", () => {
  const base = domain();
  const shared = { type: "nbma", checkLink: true, deadMode: "count" };
  const normalized = normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config) => ({ ...config, routerId: config.nodeId === "n1" ? "198.51.100.1" : "198.51.100.2" })),
    links: [
      { ...base.links[0], localOptions: { ...shared, neighbors: [{ address: "192.0.2.2" }, { address: "2001:db8::2" }] }, remoteOptions: { ...shared, neighbors: [{ address: "192.0.2.1" }, { address: "2001:db8::1" }] } },
      { ...base.links[0], id: "l2", localInterface: "eth0", remoteInterface: "eth2", localOptions: { ...shared, neighbors: [{ address: "192.0.2.2" }, { address: "2001:db8::2" }] }, remoteOptions: { ...shared, neighbors: [{ address: "192.0.2.1" }, { address: "2001:db8::1" }] } },
    ],
  });
  const config = renderBirdConfig(node("n1", "198.51.100.1"), [], [], [], [], [], [], [], [], [normalized]);
  assert.match(config, /192\.0\.2\.2/);
  assert.doesNotMatch(config, /198\.51\.100\.2/);
});

test("filters shared NBMA neighbor addresses by protocol family", () => {
  const base = domain();
  const normalized = normalizeOspfDomain({
    ...base,
    links: [{
      ...base.links[0],
      localOptions: { type: "nbma", neighbors: [{ address: "192.0.2.2" }, { address: "2001:db8::2" }] },
      remoteOptions: { type: "nbma", neighbors: [{ address: "192.0.2.1" }, { address: "2001:db8::1" }] },
    }],
  });
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [normalized]);
  const v2 = config.match(/protocol ospf v2[\s\S]*?protocol ospf v3/)?.[0] ?? "";
  const v3 = config.match(/protocol ospf v3[\s\S]*/)?.[0] ?? "";
  assert.match(v2, /192\.0\.2\.2;/);
  assert.doesNotMatch(v2, /2001:db8::2/);
  assert.match(v3, /2001:db8::2;/);
  assert.doesNotMatch(v3, /192\.0\.2\.2/);
});

test("rejects NBMA neighbors that cannot serve an enabled protocol family", () => {
  const base = domain();
  assert.throws(() => normalizeOspfDomain({
    ...base,
    links: [{ ...base.links[0], localOptions: { type: "nbma", neighbors: [{ address: "192.0.2.2" }] } }],
  }), /ospfv3.*邻居地址必须使用IPv6/);
});

test("rejects NBMA interfaces without explicit neighbor addresses", () => {
  const base = domain();
  assert.throws(() => normalizeOspfDomain({
    ...base,
    links: [{ ...base.links[0], options: { type: "nbma", checkLink: true, deadMode: "count" } }],
  }), /NBMA.*实际邻居地址/);
});

test("preserves eligible neighbors when merging shared NBMA interfaces", async () => {
  const base = domain();
  const options = { type: "nbma", neighbors: [{ address: "192.0.2.2", eligible: false }] };
  const normalized = normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config) => ({ ...config, versions: ["ospfv2"] })),
    links: [
      { ...base.links[0], options },
      { ...base.links[0], id: "l2", remoteInterface: "eth2", options: { ...options, neighbors: [
        { address: "192.0.2.2", eligible: true },
        { address: "192.0.2.3", eligible: true },
      ] } },
    ],
  });
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [normalized]);
  assert.match(config, /192\.0\.2\.2 eligible;/);
  assert.match(config, /192\.0\.2\.3 eligible;/);
  assert.equal((config.match(/192\.0\.2\.2 eligible;/g) ?? []).length, 1);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-ospf-eligible-"));
  try {
    const file = path.join(directory, "bird.conf");
    await fs.writeFile(file, config);
    await execFileAsync("bird", ["-p", "-c", file]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rejects shared NBMA interfaces with conflicting advanced parameters", () => {
  const base = domain();
  const shared = { type: "nbma", checkLink: true, deadMode: "count" };
  assert.throws(() => normalizeOspfDomain({
    ...base,
    links: [
      { ...base.links[0], localOptions: { ...shared, neighbors: [{ address: "192.0.2.2" }, { address: "2001:db8::2" }] }, remoteOptions: { ...shared, neighbors: [{ address: "192.0.2.1" }, { address: "2001:db8::1" }] } },
      { ...base.links[0], id: "l2", localInterface: "eth0", remoteInterface: "eth2", localOptions: { ...shared, neighbors: [{ address: "192.0.2.2" }, { address: "2001:db8::2" }], priority: 10 }, remoteOptions: { ...shared, neighbors: [{ address: "192.0.2.1" }, { address: "2001:db8::1" }] } },
    ],
  }), /共享链路高级参数必须一致/);
});

test("validates OSPF node references", () => {
  assert.throws(() => validateInventory({ version: 28, nodes: [node("n1", "192.0.2.1")], peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], sourcePolicies: [], sessions: [], ibgpDomains: [], ospfDomains: [{ ...domain(), nodeConfigs: domain().nodeConfigs.filter((item) => item.nodeId === "n1") }] }), /不存在的节点|链路两端/);
});

test("rejects a link whose endpoint has no domain member config", () => {
  const base = domain();
  assert.throws(() => normalizeOspfDomain({
    ...base,
    nodeConfigs: [base.nodeConfigs[0]],
  }), /两端节点必须加入当前域/);
});

function inventoryWithOspfDomains(domains, defines = []) {
  return {
    version: 28,
    nodes: [node("n1", "192.0.2.1"), { ...node("n2", "192.0.2.2"), transport: "ssh", sshHost: "192.0.2.2", sshUser: "birdbox" }],
    peers: [], defines, functions: [], filters: [], rpki: [], staticProtocols: [],
    sourcePolicies: [], sessions: [], ibgpDomains: [], ospfDomains: domains,
  };
}

test("accepts an empty OSPF domain while it is being assembled", () => {
  const inventory = inventoryWithOspfDomains([{ id: "empty", name: "Empty OSPF", nodeConfigs: [], links: [], layout: {} }]);
  const normalized = validateInventory(inventory);
  assert.deepEqual(normalized.ospfDomains[0].nodeConfigs, []);
  assert.deepEqual(normalized.ospfDomains[0].links, []);
});

test("requires a Define when OSPF export policy selects CIDR mode", () => {
  const ospf = normalizeOspfDomain({
    ...domain(),
    nodeConfigs: domain().nodeConfigs.map((config) => ({
      ...config,
      versions: ["ospfv2"],
      exportPolicies: { ...config.exportPolicies, ospfv2: policy("cidr") },
    })),
  });
  assert.throws(() => validateInventory(inventoryWithOspfDomains([ospf])), /导出 CIDR 策略必须选择 Define/);
});

test("does not require an unused Define for a custom OSPF export filter", () => {
  const filter = normalizePolicyFilter({
    id: "ospf_filter", nodeIds: ["n1", "n2"], label: "OSPF filter", name: "ospf_filter",
    enabled: true, source: "filter ospf_filter { accept; }",
  });
  const ospf = normalizeOspfDomain({
    ...domain(),
    links: [],
    nodeConfigs: domain().nodeConfigs.map((config) => ({
      ...config,
      exportPolicies: {
        ...config.exportPolicies,
        ospfv2: { mode: "custom", formAction: "cidr", filterId: filter.id, steps: [{ type: "function", functionId: "stale_function", action: "execute" }] },
      },
      exportDefineIds: { ...config.exportDefineIds, ospfv2: null },
    })),
  });
  assert.doesNotThrow(() => validateInventory({ ...inventoryWithOspfDomains([ospf]), filters: [filter] }));
});

test("rejects duplicate OSPF names and sanitized protocol-name collisions", () => {
  const withArea = (value) => ({ ...value, nodeConfigs: value.nodeConfigs.map((config) => ({ ...config, areaOptions: { "0.0.0.0": {} } })) });
  const first = withArea({ ...domain(), id: "a", name: "First OSPF", links: [] });
  const second = withArea({ ...domain(), id: "b", name: "Second OSPF", links: [] });
  const protocolName = ospfProtocolName(normalizeOspfDomain(first), "ospfv2");
  assert.throws(() => validateInventory(inventoryWithOspfDomains([first], [{ id: "d", name: protocolName, type: "cidr4", entries: ["192.0.2.0/24"], enabled: true }])), /全局标识符冲突/);
  assert.throws(() => validateInventory(inventoryWithOspfDomains([{ ...first, id: "other", name: "Same OSPF" }, { ...second, id: "other2", name: "Same OSPF" }])), /OSPF 域名称重复/);
});

test("rejects duplicate enabled OSPF Router IDs within one protocol version", () => {
  const input = domain();
  input.nodeConfigs = input.nodeConfigs.map((config) => ({ ...config, versions: ["ospfv2"], routerId: "192.0.2.99" }));
  assert.throws(() => validateInventory(inventoryWithOspfDomains([input])), /ospfv2 Router ID 192\.0\.2\.99.*重复使用/);
});

test("allows the same OSPF Router ID across protocol versions", () => {
  const input = domain();
  input.nodeConfigs = input.nodeConfigs.map((config, index) => ({
    ...config,
    versions: [index === 0 ? "ospfv2" : "ospfv3"],
    routerId: "192.0.2.99",
  }));
  assert.doesNotThrow(() => validateInventory(inventoryWithOspfDomains([input])));
});

test("ignores duplicate Router IDs on disabled OSPF node drafts", () => {
  const input = domain();
  input.nodeConfigs = input.nodeConfigs.map((config) => ({ ...config, versions: ["ospfv2"], routerId: "192.0.2.99", enabled: config.nodeId === "n1" }));
  assert.doesNotThrow(() => validateInventory(inventoryWithOspfDomains([input])));
});

test("allows duplicate OSPF Router IDs in separate domains", () => {
  const first = domain();
  first.nodeConfigs = first.nodeConfigs.map((config, index) => ({ ...config, versions: ["ospfv2"], routerId: `192.0.2.${99 - index}` }));
  const second = { ...domain(), id: "ospf_other", name: "Other OSPF" };
  second.nodeConfigs = second.nodeConfigs.map((config, index) => ({ ...config, versions: ["ospfv2"], routerId: `192.0.2.${99 - index}` }));
  assert.doesNotThrow(() => validateInventory(inventoryWithOspfDomains([first, second])));
});

test("rejects OSPF custom policies without a Filter", () => {
  const invalid = { ...domain(), links: [], nodeConfigs: domain().nodeConfigs.map((config) => ({
    ...config,
    importPolicies: { ...config.importPolicies, ospfv2: { mode: "custom", formAction: "all", filterId: null, steps: [] } },
  })) };
  assert.throws(() => validateInventory(inventoryWithOspfDomains([invalid])), /自定义策略必须选择 Filter/);
});

test("normalizes and renders BIRD OSPF advanced protocol and interface options", async () => {
  const d = normalizeOspfDomain({ ...domain(), nodeConfigs: domain().nodeConfigs.map((config) => ({ ...config, protocolOptions: { rfc1583compat: true, rfc5838: false, instanceId: 7, stubRouter: true, tick: 2, ecmp: true, ecmpLimit: 8, mergeExternal: true, gracefulRestartMode: "on", gracefulRestartTime: 90 }, areaOptions: { "0.0.0.0": { networks: [{ prefix: "192.0.2.0/24", hidden: true }] } }, virtualLinks: [{ id: "192.0.2.9", area: "1.1.1.1", hello: 10, dead: 40 }] })), links: [{ ...domain().links[0], authentication: "md5", options: { type: "ptp", instanceId: 7, poll: 20, retransmit: 5, transmitDelay: 1, priority: 10, wait: 40, deadMode: "seconds", rxBuffer: "large", txLength: 1400, linkLsaSuppression: true, strictNonbroadcast: true, realBroadcast: true, ptpNetmask: true, ptpAddress: true, secondary: true, checkLink: false, ecmpWeight: 2, ttlSecurity: "tx-only", txClass: 46, txDscp: 46, txPriority: 3, password: "secret", passwordOptions: { id: 7, algorithm: "hmac-sha256" }, neighbors: [{ address: "192.0.2.2", eligible: true }, { address: "2001:db8::2", eligible: true }] } }] });
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [d]);
  for (const expected of ["rfc1583compat yes;", "rfc5838 no;", "instance id 7;", "stub router yes;", "ecmp yes limit 8;", "merge external yes;", "type ptp;", "dead 40;", "rx buffer large;", "ttl security tx only;", "algorithm hmac sha256;", "neighbors {", "virtual link 192.0.2.9"]) assert.match(config, new RegExp(expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  assert.match(config, /interface "eth0" instance 7 \{/);
  assert.doesNotMatch(config, /secondary yes;/);
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-ospf-advanced-")), "bird.conf");
  await fs.writeFile(file, config);
  await execFileAsync("bird", ["-p", "-c", file]);
});

test("supports IPv6 Area prefixes in OSPFv3 and keeps them out of OSPFv2", async () => {
  const input = domain();
  input.nodeConfigs = input.nodeConfigs.map((config) => ({
    ...config,
    versions: ["ospfv2", "ospfv3"],
    areaOptions: {
      "0.0.0.0": {
        networks: [{ prefix: "192.0.2.0/24" }, { prefix: "2001:db8:1::/64", hidden: true }],
        external: [{ prefix: "2001:db8:2::/48", tag: 42 }],
        stubnets: [{ prefix: "2001:db8:3::/64", cost: 10 }],
      },
    },
  }));
  const normalized = normalizeOspfDomain(input);
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [normalized]);
  const v2 = config.match(/protocol ospf v2[\s\S]*?protocol ospf v3/)?.[0] ?? "";
  const v3 = config.match(/protocol ospf v3[\s\S]*/)?.[0] ?? "";
  assert.match(v2, /192\.0\.2\.0\/24/);
  assert.doesNotMatch(v2, /2001:db8/);
  assert.match(v3, /2001:db8:1::\/64 hidden/);
  assert.match(v3, /2001:db8:2::\/48 tag 42/);
  assert.match(v3, /stubnet 2001:db8:3::\/64/);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-ospf-v6-area-"));
  try {
    const file = path.join(directory, "bird.conf");
    await fs.writeFile(file, config);
    await execFileAsync("bird", ["-p", "-c", file]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("does not reject an unrelated v2 Simple-authenticated link while rendering v3", () => {
  const base = domain();
  const configs = [
    { ...base.nodeConfigs[0], nodeId: "n1", versions: ["ospfv2"], routerId: "192.0.2.1" },
    { ...base.nodeConfigs[1], nodeId: "n2", versions: ["ospfv2"], routerId: "192.0.2.2" },
    { ...base.nodeConfigs[0], nodeId: "n3", versions: ["ospfv3"], routerId: "192.0.2.3" },
    { ...base.nodeConfigs[1], nodeId: "n4", versions: ["ospfv3"], routerId: "192.0.2.4" },
  ];
  const normalized = normalizeOspfDomain({
    ...base,
    nodeConfigs: configs,
    links: [
      { ...base.links[0], id: "v2_simple", fromNodeId: "n1", toNodeId: "n2", localInterface: "v2a", remoteInterface: "v2b", authentication: "simple", localOptions: { type: "ptp", password: "v2-secret" }, remoteOptions: { type: "ptp", password: "v2-secret" } },
      { ...base.links[0], id: "v3_crypto", fromNodeId: "n3", toNodeId: "n4", localInterface: "v3a", remoteInterface: "v3b", authentication: "md5", localOptions: { type: "ptp", password: "v3-secret", passwordOptions: { algorithm: "hmac-sha256" } }, remoteOptions: { type: "ptp", password: "v3-secret", passwordOptions: { algorithm: "hmac-sha256" } } },
    ],
  });
  const config = renderBirdConfig(node("n3", "192.0.2.3"), [], [], [], [], [], [], [], [], [normalized]);
  assert.match(config, /protocol ospf v3/);
  assert.doesNotMatch(config, /v2_simple/);
});

test("does not let a disabled OSPFv3 endpoint block an active OSPFv2 link", () => {
  const base = domain();
  const normalized = normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config, index) => ({
      ...config,
      enabled: index === 0,
      versions: index === 0 ? ["ospfv2"] : ["ospfv3"],
    })),
    links: [{
      ...base.links[0],
      authentication: "simple",
      localOptions: { type: "ptp", password: "v2-secret" },
      remoteOptions: { type: "ptp", password: "disabled-v3-secret" },
    }],
  });
  const config = renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [normalized]);
  assert.match(config, /protocol ospf v2/);
  assert.doesNotMatch(config, /protocol ospf v3/);
  assert.match(config, /authentication simple;/);
});

test("ignores stale policy references on a disabled OSPF node", () => {
  const base = domain();
  const normalized = normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config, index) => index === 0
      ? config
      : {
        ...config,
        enabled: false,
        importPolicies: { ...config.importPolicies, ospfv2: { mode: "combined", formAction: "all", filterId: null, steps: [{ type: "function", functionId: "missing_fn", action: "execute" }] } },
        exportPolicies: { ...config.exportPolicies, ospfv2: { mode: "custom", formAction: "all", filterId: "missing_filter", steps: [] } },
        exportDefineIds: { ...config.exportDefineIds, ospfv2: "missing_define" },
      }),
  });
  assert.doesNotThrow(() => validateInventory(inventoryWithOspfDomains([normalized])));
});

test("rejects OSPF authentication injection and out-of-range DSCP during normalization", () => {
  const base = domain();
  assert.throws(() => normalizeOspfDomain({
    ...base,
    links: [{ ...base.links[0], options: {
      type: "ptp", password: "secret", passwordOptions: { id: "7; } protocol static injected {", algorithm: "hmac-sha256" }, txDscp: 64,
    } }],
  }), /TX DSCP/);
  const invalidAlgorithm = {
    ...base,
    links: [{ ...base.links[0], authentication: "md5", options: { type: "ptp", password: "secret", passwordOptions: { algorithm: "hmac-sha256; }" } } }],
  };
  assert.throws(() => normalizeOspfDomain(invalidAlgorithm), /认证算法无效/);
});

test("rejects incomplete OSPF authentication and invalid area timers", () => {
  const base = domain();
  assert.throws(() => normalizeOspfDomain({
    ...base,
    links: [{ ...base.links[0], authentication: "md5", localOptions: { type: "ptp", password: "only-one-endpoint" }, remoteOptions: { type: "ptp" } }],
  }), /必须配置(?:本端|对端)密码/);
  assert.throws(() => normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config) => ({ ...config, areaOptions: { "0.0.0.0": { defaultCost: "not-a-number" } } })),
  }), /Default Cost/);
  assert.throws(() => normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config) => ({ ...config, areaOptions: { "0.0.0.0": { summary: true } } })),
  }), /Summary.*Stub 或 NSSA/);
  assert.throws(() => normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config) => ({ ...config, areaOptions: { "0.0.0.0": { defaultCost2: 20 } } })),
  }), /Default Cost2.*NSSA/);
  assert.throws(() => normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config) => ({
      ...config,
      areaOptions: { "0.0.0.0": { external: [{ prefix: "198.51.100.0/24", hidden: true, tag: 7 }] } },
    })),
  }), /External.*Hidden.*Tag/);
  assert.throws(() => normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config) => ({ ...config, areaOptions: { "1.1.1.1": { nssa: true, defaultNssa: true } } })),
  }), /Default NSSA.*Summary/);
  assert.throws(() => normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config) => ({ ...config, areaOptions: { "1.1.1.1": { stub: true, nssa: true } } })),
  }), /不能同时配置 Stub 和 NSSA/);
  assert.throws(() => normalizeOspfDomain({
    ...base,
    links: [{ ...base.links[0], authentication: "simple", options: { type: "ptp", password: "secret" } }],
  }), /OSPFv3.*Simple/);
  const legacyIpsec = normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config) => ({ ...config, versions: ["ospfv2"] })),
    links: [{ ...base.links[0], authentication: "ipsec", options: { type: "ptp", password: "secret" } }],
  });
  assert.equal(legacyIpsec.links[0].authentication, "ipsec");
  assert.doesNotThrow(() => validateInventory(inventoryWithOspfDomains([legacyIpsec])));
  assert.throws(() => renderBirdConfig(node("n1", "192.0.2.1"), [], [], [], [], [], [], [], [], [legacyIpsec]), /IPsec.*不受 BIRD 配置支持/);
  assert.doesNotThrow(() => normalizeOspfDomain({
    ...base,
    nodeConfigs: [...base.nodeConfigs.map((config) => ({ ...config, versions: ["ospfv2"] })), { ...base.nodeConfigs[0], nodeId: "n3", versions: ["ospfv3"], routerId: "192.0.2.3" }],
    links: [{ ...base.links[0], authentication: "simple", options: { type: "ptp", password: "secret" } }],
  }));
  assert.throws(() => normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config) => ({ ...config, virtualLinks: [{ id: "192.0.2.9", area: "1.1.1.1", authentication: "simple", password: "secret" }] })),
  }), /虚链路.*OSPFv3.*Simple/);
  assert.throws(() => normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config) => ({ ...config, virtualLinks: [{ id: "192.0.2.9", area: "1.1.1.1", authentication: "cryptographic", password: "secret", passwordOptions: { algorithm: "keyed-md5" } }] })),
  }), /虚链路.*OSPFv3.*HMAC/);
  assert.throws(() => normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config) => ({ ...config, virtualLinks: [{ id: "192.0.2.9", area: "1.1.1.1", authentication: "cryptographic" }] })),
  }), /虚链路.*必须配置密码/);
  assert.throws(() => normalizeOspfDomain({
    ...base,
    links: [],
    nodeConfigs: base.nodeConfigs.map((config) => ({ ...config, virtualLinks: [{ id: "192.0.2.9", area: "1.1.1.1" }] })),
  }), /必须配置 Backbone Area/);
  assert.doesNotThrow(() => normalizeOspfDomain({
    ...base,
    nodeConfigs: base.nodeConfigs.map((config) => config.nodeId === "n2" ? { ...config, enabled: false } : config),
    links: [{ ...base.links[0], authentication: "md5", localOptions: { type: "ptp", password: "secret" }, remoteOptions: { type: "ptp" } }],
  }));
  assert.throws(() => normalizeOspfDomain({
    ...base,
    links: [{ ...base.links[0], hello: 10, dead: 35 }],
  }), /Dead.*整数倍/);
  assert.throws(() => normalizeOspfDomain({
    ...base,
    links: [{ ...base.links[0], authentication: "md5", localOptions: { type: "ptp", password: "secret", passwordOptions: { generateFrom: "bad-time" } }, remoteOptions: { type: "ptp", password: "secret" } }],
  }), /时间字段格式无效/);
  assert.throws(() => normalizeOspfDomain({
    ...base,
    links: [{ ...base.links[0], authentication: "md5", localOptions: { type: "ptp", password: "secret", passwordOptions: { generateFrom: "2026-02-30 00:00:00" } }, remoteOptions: { type: "ptp", password: "secret" } }],
  }), /时间字段无效/);
  assert.throws(() => normalizeOspfDomain({
    ...base,
    links: [{ ...base.links[0], authentication: "md5", localOptions: { type: "ptp", password: "secret", passwordOptions: { generateFrom: "2026-01-02 00:00:00", generateTo: "2026-01-01 00:00:00" } }, remoteOptions: { type: "ptp", password: "secret" } }],
  }), /时间窗口顺序无效/);
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
