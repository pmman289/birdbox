import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createHttpApplication } from "../src/http/application.js";

const node = (id, name = id) => ({
  id,
  kind: "managed-node",
  name,
  transport: "agent",
  sshHost: null,
  sshPort: null,
  sshUser: null,
  sshIdentity: "default",
  deploymentMode: "include",
  mainConfigPath: "/etc/bird.conf",
  generatedConfigPath: "/etc/birdbox/generated.conf",
  socketPath: "/run/bird.ctl",
  routerId: id === "slow" ? "192.0.2.2" : "192.0.2.1",
  igpAddress: null,
  listenPort: 179,
  directProtocol: { enabled: false, name: "direct", ipv4: true, ipv6: true, interfaces: [] },
  kernelProtocol: { enabled: false, name: "kernel", ipv4: true, ipv6: true, import: "all", export: "all", table: null, scanTime: null, persist: false },
});

const runtime = (reachable = true, error = null) => ({
  reachable,
  error,
  v2: { state: reachable ? "Full/PtP" : null, neighbors: reachable ? 1 : 0, routes: reachable ? 1 : null },
  v3: { state: null, neighbors: 0, routes: null },
  neighbors: [],
  routes: [],
  routesTruncated: false,
  interfaces: [],
});

test("OSPF runtime isolates a timed out node and returns other nodes", async (context) => {
  const fast = node("fast", "Fast node");
  const slow = node("slow", "Slow node");
  const store = {
    read: async () => ({
      version: 28,
      nodes: [fast, slow], peers: [], defines: [], functions: [], filters: [], rpki: [],
      staticProtocols: [], directProtocols: [], kernelProtocols: [], sourcePolicies: [], sessions: [], ibgpDomains: [],
      ospfDomains: [{ id: "domain", name: "Test domain", nodeConfigs: [{ nodeId: "fast", enabled: true, versions: ["ospfv2"] }, { nodeId: "slow", enabled: true, versions: ["ospfv2"] }], links: [], layout: {} }],
      ospfLayout: {},
    }),
  };
  const inspector = async (item) => {
    if (item.id === "slow") await new Promise((resolve) => setTimeout(resolve, 250));
    return runtime();
  };
  const app = await createHttpApplication({
    publicDirectory: path.resolve("public"),
    appVersion: "test",
    authStore: { isAuthenticated: async () => true },
    store,
    secureCookieSetting: false,
    ping: async () => true,
    isDeploymentLocked: () => false,
    loadDashboard: async () => { throw new Error("not used"); },
    withDeploymentLock: async (operation) => operation(),
    withNodeOperationLock: async (_nodeId, operation) => operation(),
    mutationService: {},
    addEvent: () => ({ timestamp: new Date().toISOString(), level: "info", message: "", nodeId: null }),
    getEvents: () => [],
    agentBroker: {},
    inspectOspfRuntime: inspector,
    ospfRuntimeTimeoutMs: 30,
  });
  context.after(() => app.close());

  const started = Date.now();
  const response = await app.inject({ method: "GET", url: "/api/ospf/domain/runtime" });
  const elapsed = Date.now() - started;
  assert.equal(response.statusCode, 200);
  assert.ok(elapsed < 180, `runtime endpoint waited ${elapsed}ms for a timed out node`);
  const body = response.json();
  assert.equal(body.nodes.length, 2);
  assert.equal(body.nodes.find((item) => item.nodeId === "fast").runtime.reachable, true);
  assert.equal(body.nodes.find((item) => item.nodeId === "slow").runtime.reachable, false);
  assert.match(body.nodes.find((item) => item.nodeId === "slow").runtime.error, /超时/);
});

test("OSPF runtime converts a node inspector exception into a node error", async (context) => {
  const only = node("broken", "Broken node");
  const store = {
    read: async () => ({ version: 28, nodes: [only], peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], directProtocols: [], kernelProtocols: [], sourcePolicies: [], sessions: [], ibgpDomains: [], ospfDomains: [{ id: "domain", name: "Test domain", nodeConfigs: [{ nodeId: "broken", enabled: true, versions: ["ospfv2"] }], links: [], layout: {} }], ospfLayout: {} }),
  };
  const app = await createHttpApplication({
    publicDirectory: path.resolve("public"), appVersion: "test", authStore: { isAuthenticated: async () => true }, store,
    secureCookieSetting: false, ping: async () => true, isDeploymentLocked: () => false, loadDashboard: async () => { throw new Error("not used"); },
    withDeploymentLock: async (operation) => operation(), withNodeOperationLock: async (_nodeId, operation) => operation(),
    mutationService: {}, addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }), getEvents: () => [], agentBroker: {},
    inspectOspfRuntime: () => { throw new Error("simulated inspector failure"); }, ospfRuntimeTimeoutMs: 30,
  });
  context.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/ospf/domain/runtime" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.nodes[0].runtime.reachable, false);
  assert.equal(body.nodes[0].runtime.error, "simulated inspector failure");
});

test("OSPF runtime polling keeps a 20-node domain bounded across repeated rounds", async (context) => {
  const nodes = Array.from({ length: 20 }, (_, index) => node(`n${index}`, `Node ${index}`));
  let active = 0;
  let maxActive = 0;
  const inspector = async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (Number(item.id.slice(1)) % 5 === 0) await new Promise((resolve) => setTimeout(resolve, 80));
    active -= 1;
    return runtime();
  };
  const store = { read: async () => ({ version: 28, nodes, peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], directProtocols: [], kernelProtocols: [], sourcePolicies: [], sessions: [], ibgpDomains: [], ospfDomains: [{ id: "domain", name: "Capacity domain", nodeConfigs: nodes.map((item) => ({ nodeId: item.id, enabled: true, versions: ["ospfv2"] })), links: [], layout: {} }], ospfLayout: {} }) };
  const app = await createHttpApplication({
    publicDirectory: path.resolve("public"), appVersion: "test", authStore: { isAuthenticated: async () => true }, store,
    secureCookieSetting: false, ping: async () => true, isDeploymentLocked: () => false, loadDashboard: async () => { throw new Error("not used"); },
    withDeploymentLock: async (operation) => operation(), withNodeOperationLock: async (_nodeId, operation) => operation(),
    mutationService: {}, addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }), getEvents: () => [], agentBroker: {},
    inspectOspfRuntime: inspector, ospfRuntimeTimeoutMs: 25,
  });
  context.after(() => app.close());
  const durations = [];
  for (let round = 0; round < 10; round += 1) {
    const started = Date.now();
    const response = await app.inject({ method: "GET", url: "/api/ospf/domain/runtime" });
    durations.push(Date.now() - started);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().nodes.length, 20);
  }
  assert.ok(Math.max(...durations) < 150, `runtime polling exceeded bound: ${durations.join(",")}`);
  assert.ok(maxActive <= 20);
});
