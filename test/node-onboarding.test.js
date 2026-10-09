import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  NodeOnboardingService,
  globalRpkiFileRequirements,
  onboardingValidationError,
} from "../src/node-onboarding-service.js";
import { validateInventory } from "../src/bird.js";
import { expandIbgpDomain, normalizeIbgpDomain } from "../src/ibgp-domain.js";
import { normalizeOspfDomain } from "../src/ospf.js";
import { AgentBroker } from "../src/agent-broker.js";
import { MemoryDatabase } from "../src/database.js";

const globalFileRpki = {
  id: "rpki_global_files",
  nodeIds: null,
  label: "DN42 ROA",
  name: "dn42_roa",
  enabled: true,
  sourceType: "file",
  roa4Table: "ROA_DN42_V4",
  roa6Table: "ROA_DN42_V6",
  file4: "/etc/bird/roa_dn42.conf",
  file6: "/etc/bird/roa_dn42_v6.conf",
};

function inventoryWithRpki(rpki) {
  return {
    version: 25,
    nodes: [],
    peers: [],
    defines: [],
    functions: [],
    filters: [],
    rpki,
    staticProtocols: [],
    sessions: [],
    ibgpDomains: [],
  };
}

function shellSyntax(script) {
  const child = spawn("sh", ["-n"], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(script);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

test("adds actionable global RPKI file requirements to node onboarding", async () => {
  const inventory = inventoryWithRpki([
    globalFileRpki,
    { ...globalFileRpki, id: "rpki_disabled", label: "Disabled ROA", enabled: false },
    { ...globalFileRpki, id: "rpki_scoped", label: "Scoped ROA", nodeIds: ["existing"] },
    {
      id: "rpki_global_server",
      nodeIds: null,
      label: "RPKI RTR",
      name: "rpki_rtr",
      enabled: true,
      sourceType: "server",
      roa4Table: "ROA_RTR_V4",
      roa6Table: null,
      remote: "rpki.example",
      port: 323,
      transport: "tcp",
    },
  ]);
  const requirements = globalRpkiFileRequirements(inventory);
  assert.deepEqual(requirements, [
    {
      resourceId: "rpki_global_files",
      resourceLabel: "DN42 ROA",
      family: "ipv4",
      path: "/etc/bird/roa_dn42.conf",
    },
    {
      resourceId: "rpki_global_files",
      resourceLabel: "DN42 ROA",
      family: "ipv6",
      path: "/etc/bird/roa_dn42_v6.conf",
    },
  ]);

  const service = new NodeOnboardingService({
    store: { read: async () => inventory },
    deploymentService: {},
    withDeploymentLock: async (operation) => operation(),
    controllerPublicKey: () => "ssh-ed25519 test-controller-key birdbox",
    makeId: () => "unused",
    addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }),
    getEvents: () => [],
  });
  const response = await service.createSetupScript({
    name: "New router",
    transport: "ssh",
    sshHost: "192.0.2.10",
    sshUser: "birdbox",
    routerId: "192.0.2.10",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.payload.rpkiRequirements, requirements);
  assert.match(response.payload.script, /全节点 RPKI 资源“DN42 ROA”缺少 IPV4 ROA 文件：\/etc\/bird\/roa_dn42\.conf/);
  assert.match(response.payload.script, /若资源不适用于此节点，请在 Birdbox 中把 RPKI 作用域改为指定节点/);
  assert.doesNotMatch(response.payload.script, /RPKI RTR/);
  assert.ok(response.payload.script.indexOf("RPKI_MISSING=0") < response.payload.script.indexOf("test -f \"$MAIN_CONFIG\""));
  const syntax = await shellSyntax(response.payload.script);
  assert.equal(syntax.code, 0, syntax.stderr);
});

test("defaults new onboarding to an Agent installer with valid shell syntax", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  const service = new NodeOnboardingService({
    store: { read: async () => inventoryWithRpki([]) }, deploymentService: {},
    withDeploymentLock: async (operation) => operation(), controllerPublicKey: () => "",
    makeId: () => "agent_test", addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }), getEvents: () => [],
    agentBroker: broker, agentControllerUrl: "https://controller.example",
  });
  const response = await service.createSetupScript({ name: "Agent router", routerId: "192.0.2.10" });
  assert.equal(response.status, 200);
  assert.equal(response.payload.nodeId, "agent_test");
  assert.match(response.payload.script, /birdbox-agent/);
  assert.match(response.payload.script, /BIRDBOX_AGENT_REQUIRE_HTTPS=true/);
  assert.match(response.payload.setupScriptUrl, /^https:\/\/controller\.example\/api\/nodes\/setup-script\/[A-Za-z0-9_-]{32,}$/);
  assert.match(response.payload.script, /systemd|openwrt|init\.d/);
  assert.ok(response.payload.script.indexOf("CHECKSUM_URL") < response.payload.script.indexOf("mv -f \"$TMP\""));
  assert.ok(response.payload.script.includes("EXPECTED=$(sed 's/[[:space:]]//g' < \"$CHECKSUM_TMP\")"));
  assert.doesNotMatch(response.payload.script, /tr -d '\[:space:\]'/);
  assert.match(response.payload.script, /if \/etc\/init\.d\/birdbox-agent running/);
  assert.match(response.payload.script, /then \/etc\/init\.d\/birdbox-agent restart; else \/etc\/init\.d\/birdbox-agent start; fi/);
  assert.match(response.payload.script, /Birdbox Agent 已启动，等待主控注册/);
  assert.match(response.payload.script, /Birdbox Agent 启动失败，请执行 \/etc\/init\.d\/birdbox-agent status 和 logread 查看原因/);
  const syntax = await shellSyntax(response.payload.script);
  assert.equal(syntax.code, 0, syntax.stderr);
  const deliveryToken = response.payload.setupScriptUrl.split("/").pop();
  assert.equal(await service.getSetupScript(deliveryToken), response.payload.script);
  assert.equal(await service.getSetupScript(deliveryToken), response.payload.script);
  assert.equal(await service.getSetupScript(deliveryToken), response.payload.script);
  await assert.rejects(() => service.getSetupScript(deliveryToken), /准备脚本不存在或已过期/);
});

test("creates an Agent node after registration without requiring inbound SSH", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  let inventory = inventoryWithRpki([]);
  const service = new NodeOnboardingService({
    store: {
      read: async () => inventory,
      mutate: async (mutator) => { const draft = structuredClone(inventory); const result = await mutator(draft); inventory = validateInventory(draft); return { state: inventory, result }; },
    }, deploymentService: {}, withDeploymentLock: async (operation) => operation(), controllerPublicKey: () => "",
    makeId: () => "agent_created", addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }), getEvents: () => [], agentBroker: broker,
  });
  const payload = { name: "Created Agent", transport: "agent", routerId: "192.0.2.11", id: "agent_created" };
  await service.createSetupScript(payload);
  const token = (await service.createSetupScript(payload)).payload.agentToken;
  await broker.register({ nodeId: "agent_created", token, agentVersion: "test", protocolVersion: 1 });
  const tested = await service.test(payload);
  assert.equal(tested.payload.ok, true);
  const created = await service.create(payload);
  assert.equal(created.payload.node.transport, "agent");
  assert.equal(created.payload.deployment.applied, false);
});

test("keeps the existing node ID in an Agent upgrade script", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  const legacyNode = {
    id: "legacy_upgrade_node",
    name: "Legacy router",
    kind: "managed-node",
    transport: "ssh",
    sshHost: "192.0.2.20",
    sshPort: 22,
    sshUser: "birdbox",
    sshIdentity: "managed",
    deploymentMode: "include",
    mainConfigPath: "/etc/bird/bird.conf",
    generatedConfigPath: "/var/lib/birdbox/generated.conf",
    socketPath: "/run/bird/bird.ctl",
    routerId: "192.0.2.20",
    igpAddress: "192.0.2.20",
    listenPort: 179,
  };
  const service = new NodeOnboardingService({
    store: { read: async () => ({ ...inventoryWithRpki([]), nodes: [legacyNode] }) },
    deploymentService: {},
    withDeploymentLock: async (operation) => operation(),
    controllerPublicKey: () => "",
    makeId: () => "unused",
    addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }),
    getEvents: () => [],
    agentBroker: broker,
    agentControllerUrl: "https://controller.example",
  });
  const response = await service.createAgentUpgradeScript(legacyNode.id);
  assert.equal(response.payload.nodeId, legacyNode.id);
  assert.match(response.payload.script, /BIRDBOX_NODE_ID='legacy_upgrade_node'/);
  assert.doesNotMatch(response.payload.script, /BIRDBOX_NODE_ID='node_onboarding'/);
});

test("maps a missing global RPKI file validation error to its resource and remedy", () => {
  const requirements = globalRpkiFileRequirements(inventoryWithRpki([globalFileRpki]));
  const raw = "Cannot open file /etc/bird/roa_dn42_v6.conf: No such file or directory";
  const message = onboardingValidationError(requirements, raw);
  assert.match(message, /全节点 RPKI 资源“DN42 ROA”/);
  assert.match(message, /IPV6 ROA 文件：\/etc\/bird\/roa_dn42_v6\.conf/);
  assert.match(message, /请先在目标节点部署并持续更新该文件/);
  assert.match(message, /BIRD 原始错误/);
  assert.equal(onboardingValidationError(requirements, "unrelated failure"), "unrelated failure");
});

test("rejects onboarding before SSH when a global policy depends on scoped RPKI", async () => {
  const inventory = validateInventory({
    nodes: [{ id: "existing", name: "Existing", transport: "ssh", sshHost: "existing.example", routerId: "192.0.2.1" }],
    peers: [],
    defines: [],
    functions: [{
      id: "function_rpki",
      nodeIds: null,
      label: "RPKI policy",
      name: "function_rpki",
      source: "function function_rpki() { return roa_check(ROA_DN42_V4, net, bgp_path.last) = ROA_VALID; }",
      enabled: true,
    }],
    filters: [],
    rpki: [{ ...globalFileRpki, nodeIds: ["existing"] }],
    staticProtocols: [],
    sessions: [],
    ibgpDomains: [],
  }, { allowInvalidResourceDependencies: true });
  const service = new NodeOnboardingService({
    store: { read: async () => inventory },
    deploymentService: {},
    withDeploymentLock: async (operation) => operation(),
    controllerPublicKey: () => "",
    makeId: () => "unused",
    addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }),
    getEvents: () => [],
  });

  await assert.rejects(
    () => service.test({ name: "New router", transport: "ssh", sshHost: "new.example", sshUser: "birdbox", routerId: "192.0.2.2" }),
    (error) => /作用域不兼容的 RPKI dn42_roa/.test(error.message)
      && /Function function_rpki -> RPKI dn42_roa/.test(error.message),
  );
});

test("force-forgetting a node narrows multi-node Filter and RPKI scopes", async () => {
  let inventory = validateInventory({
    nodes: [
      { id: "left", name: "Left", transport: "ssh", sshHost: "left.example", routerId: "192.0.2.1" },
      { id: "right", name: "Right", transport: "ssh", sshHost: "right.example", routerId: "192.0.2.2" },
    ],
    peers: [],
    defines: [],
    functions: [{
      id: "function_shared",
      nodeIds: ["left", "right"],
      label: "Shared RPKI policy",
      name: "function_shared",
      source: "function function_shared() { return roa_check(ROA_SHARED_V4, net, bgp_path.last) = ROA_VALID; }",
      enabled: true,
    }],
    filters: [
      { id: "filter_shared", nodeIds: ["left", "right"], label: "Shared filter", name: "shared_filter", source: "filter shared_filter { if function_shared() then accept; reject; }", enabled: true },
      { id: "filter_left", nodeIds: ["left"], label: "Left filter", name: "left_filter", source: "filter left_filter { accept; }", enabled: true },
      { id: "filter_global", nodeIds: null, label: "Global filter", name: "global_filter", source: "filter global_filter { accept; }", enabled: true },
    ],
    rpki: [
      { ...globalFileRpki, id: "rpki_shared", name: "shared_roa", nodeIds: ["left", "right"], roa4Table: "ROA_SHARED_V4", roa6Table: "ROA_SHARED_V6" },
      { ...globalFileRpki, id: "rpki_left", name: "left_roa", nodeIds: ["left"], roa4Table: "ROA_LEFT_V4", roa6Table: "ROA_LEFT_V6" },
      { ...globalFileRpki, id: "rpki_global", name: "global_roa", nodeIds: null, roa4Table: "ROA_GLOBAL_V4", roa6Table: "ROA_GLOBAL_V6" },
    ],
    staticProtocols: [],
    sessions: [],
    ibgpDomains: [],
  });
  const service = new NodeOnboardingService({
    store: {
      read: async () => inventory,
      replace: async (_current, replacement) => {
        inventory = replacement;
        return replacement;
      },
    },
    deploymentService: {},
    withDeploymentLock: async (operation) => operation(),
    controllerPublicKey: () => "",
    makeId: () => "unused",
    addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }),
    getEvents: () => [],
  });

  const result = await service.decommission("left", true);

  assert.deepEqual(result.state.nodes.map((node) => node.id), ["right"]);
  assert.deepEqual(result.state.functions.map((resource) => [resource.id, resource.nodeIds]), [
    ["function_shared", ["right"]],
  ]);
  assert.deepEqual(result.state.filters.map((resource) => [resource.id, resource.nodeIds]), [
    ["filter_shared", ["right"]],
    ["filter_global", null],
  ]);
  assert.deepEqual(result.state.rpki.map((resource) => [resource.id, resource.nodeIds]), [
    ["rpki_shared", ["right"]],
    ["rpki_global", null],
  ]);
});

test("normal node deletion explains OSPF membership before remote cleanup", async () => {
  const nodes = [
    { id: "left", name: "Left", transport: "ssh", sshHost: "left.example", routerId: "192.0.2.1" },
    { id: "right", name: "Right", transport: "ssh", sshHost: "right.example", routerId: "192.0.2.2" },
  ];
  const ospf = normalizeOspfDomain({
    id: "ospf", name: "Core OSPF",
    nodeConfigs: nodes.map((node) => ({ nodeId: node.id, enabled: true, versions: ["ospfv2"], routerId: node.routerId })),
    links: [{ id: "link", fromNodeId: "left", toNodeId: "right", area: "0.0.0.0", localInterface: "eth0", remoteInterface: "eth0" }],
  });
  let inventory = validateInventory({
    version: 28, nodes, peers: [], defines: [], functions: [], filters: [], rpki: [],
    staticProtocols: [], directProtocols: [], kernelProtocols: [], sourcePolicies: [], sessions: [],
    ibgpDomains: [], ospfDomains: [ospf], ospfLayout: {},
  });
  const service = new NodeOnboardingService({
    store: { read: async () => inventory, replace: async (_current, replacement) => { inventory = replacement; return replacement; } },
    deploymentService: {},
    withDeploymentLock: async (operation) => operation(),
    controllerPublicKey: () => "",
    makeId: () => "unused",
    addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }),
    getEvents: () => [],
  });

  await assert.rejects(() => service.decommission("left", false), /请先从 OSPF 域中移除该节点或删除对应域/);
  assert.deepEqual(inventory.nodes.map((node) => node.id), ["left", "right"]);
});

test("force-forgetting an OSPF node removes virtual links targeting it", async () => {
  const nodes = [
    { id: "left", name: "Left", transport: "ssh", sshHost: "left.example", routerId: "192.0.2.1" },
    { id: "offline", name: "Offline", transport: "agent", routerId: "192.0.2.2" },
  ];
  const ospf = normalizeOspfDomain({
    id: "ospf", name: "Core OSPF",
    nodeConfigs: [
      { nodeId: "left", enabled: true, versions: ["ospfv2"], routerId: "192.0.2.1", areaOptions: { "0.0.0.0": {} }, virtualLinks: [{ id: "192.0.2.2", area: "1.1.1.1" }] },
      { nodeId: "offline", enabled: true, versions: ["ospfv2"], routerId: "192.0.2.2", areaOptions: { "0.0.0.0": {} } },
    ],
    links: [],
  });
  let inventory = validateInventory({
    version: 28, nodes, peers: [], defines: [], functions: [], filters: [], rpki: [],
    staticProtocols: [], directProtocols: [], kernelProtocols: [], sourcePolicies: [], sessions: [],
    ibgpDomains: [], ospfDomains: [ospf], ospfLayout: {},
  });
  const service = new NodeOnboardingService({
    store: { read: async () => inventory, replace: async (_current, replacement) => { inventory = replacement; return replacement; } },
    deploymentService: {},
    withDeploymentLock: async (operation) => operation(),
    controllerPublicKey: () => "",
    makeId: () => "unused",
    addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }),
    getEvents: () => [],
  });

  const result = await service.decommission("offline", true);
  assert.equal(result.state.ospfDomains[0]?.nodeConfigs[0]?.virtualLinks?.length, 0);
});

test("force-forgetting an offline iBGP member detaches its domain resources atomically", async () => {
  const nodes = [
    { id: "left", name: "Left", transport: "ssh", sshHost: "left.example", routerId: "192.0.2.1" },
    { id: "offline", name: "Offline", transport: "agent", routerId: "192.0.2.2" },
  ];
  const domain = normalizeIbgpDomain({
    id: "domain", name: "Core", asn: 65000,
    members: [{ nodeId: "left", address: "192.0.2.1" }, { nodeId: "offline", address: "192.0.2.2" }],
    adjacencies: [{ id: "adj", leftNodeId: "left", rightNodeId: "offline", leftSessionId: "left_session", rightSessionId: "offline_session" }],
    layout: { left: { x: 0, y: 0, locked: false }, offline: { x: 100, y: 0, locked: false } },
  });
  const expanded = expandIbgpDomain(domain, nodes);
  let inventory = validateInventory({
    version: 28, nodes, peers: expanded.peers, defines: [], functions: [], filters: [], rpki: [],
    staticProtocols: [], directProtocols: [], kernelProtocols: [], sourcePolicies: [], sessions: expanded.sessions,
    ibgpDomains: [domain], ospfDomains: [], ospfLayout: {},
  });
  const service = new NodeOnboardingService({
    store: {
      read: async () => inventory,
      replace: async (_current, replacement) => { inventory = replacement; return replacement; },
    },
    deploymentService: {},
    withDeploymentLock: async (operation) => operation(),
    controllerPublicKey: () => "",
    makeId: () => "unused",
    addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }),
    getEvents: () => [],
  });

  const result = await service.decommission("offline", true);

  assert.equal(result.forced, true);
  assert.deepEqual(result.state.nodes.map((node) => node.id), ["left"]);
  assert.deepEqual(result.state.ibgpDomains[0]?.members.map((member) => member.nodeId), ["left"]);
  assert.deepEqual(result.state.ibgpDomains[0]?.adjacencies, []);
  assert.deepEqual(result.state.peers, []);
  assert.deepEqual(result.state.sessions, []);
});
