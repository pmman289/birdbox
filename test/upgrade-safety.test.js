import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryDatabase, createDatabaseFromEnvironment } from "../src/database.js";
import { InventoryStore } from "../src/store.js";
import { assertExplicitProtocolResources } from "../src/inventory-safety.js";
import { validateInventory } from "../src/bird.js";
import { configBundleForNode } from "../src/inventory-domain.js";
import { setupResourceApi } from "./helpers/resource-api.js";

const versions = [2, 8, 10, 14, 18, 19, 20, 22, 23, 25, 26, 27, 28, 29, 30, 31];
const collections = ["defines", "functions", "filters", "rpki", "staticProtocols", "directProtocols", "kernelProtocols", "pipeProtocols", "sourcePolicies", "sessions", "ibgpDomains", "ospfDomains"];
const legacyInventory = version => ({
  version,
  nodes: [
    { id: "one", name: "Existing router", transport: "agent", routerId: "192.0.2.1", deploymentMode: "include", directProtocol: { enabled: true, name: "legacy_direct", interfaces: ["eth0"] }, kernelProtocol: { enabled: true, name: "legacy_kernel", import: "all", export: "all", table: 100 } },
    { id: "two", name: "Router with omitted defaults", transport: "agent", routerId: "192.0.2.2", deploymentMode: "include" },
  ],
});
function assertNoInventedResources(state) {
  for (const key of collections) assert.deepEqual(state[key], [], `${key} must stay empty`);
  for (const node of state.nodes) assert.doesNotMatch(configBundleForNode(state, node).main, /^protocol\s+/m, `${node.id} must have no generated protocol in include mode`);
}

test("normalization safety guard rejects invented or removed protocol resources but accepts explicit user changes", () => {
 const raw = legacyInventory(28), empty = validateInventory(raw);
 const samples = {
  directProtocols: { id: "added_direct", nodeId: "one", name: "added_direct" },
  kernelProtocols: { id: "added_kernel", nodeIds: ["one"], name: "added_kernel" },
  pipeProtocols: { id: "added_pipe", nodeIds: ["one"], name: "added_pipe", family: "ipv4", table: { name: "master4", source: "existing" }, peerTable: { name: "peer4", source: "managed" } },
 };
 for (const [key, resource] of Object.entries(samples)) {
  const explicit = { ...raw, [key]: [resource] }, candidate = validateInventory(explicit);
  assert.throws(() => assertExplicitProtocolResources(raw, candidate), error => error.code === "INVENTORY_PROTOCOL_SET_CHANGED" && error.status === 409);
  assert.throws(() => assertExplicitProtocolResources(explicit, empty), error => error.code === "INVENTORY_PROTOCOL_SET_CHANGED");
  assert.doesNotThrow(() => assertExplicitProtocolResources(explicit, candidate));
 }
});

for (const version of versions) for (const explicitEmpty of [false, true]) {
 test(`v${version} upgrade with ${explicitEmpty ? "empty" : "omitted"} collections never creates protocols, deploys, or writes on read/restart`, async t => {
  const input = legacyInventory(version);
  if (explicitEmpty) for (const key of collections) input[key] = [];
  const h = await setupResourceApi(t, { inventory: input });
  assert.equal(h.calls.length, 0, "initialization must not contact nodes");
  await h.deploymentService.recover();
  assert.equal(h.calls.length, 0, "startup without a pending journal must not deploy");
  const state = await h.store.read(), revision = h.store.revisionOf(state);
  assert.equal(state.version, 31); assertNoInventedResources(state);
  assert.equal(state.nodes[0].directProtocol.enabled, true);
  assert.equal(state.nodes[0].kernelProtocol.enabled, true);
  const persisted = await h.database.readState("inventory");
  for (const node of state.nodes) {
    const response = await h.request("GET", `/api/dashboard?nodeId=${node.id}`);
    assert.equal(response.statusCode, 200, response.body);
    assertNoInventedResources(response.json().inventory);
    for (const url of ["/api/directs/editor-context", "/api/kernels/editor-context", "/api/pipes/tables", "/api/ospf"]) {
      const read = await h.request("GET", url); assert.equal(read.statusCode, 200, read.body);
    }
  }
  assert.ok(h.calls.every(call => call.method === "bird.inspect"), "dashboard may only inspect nodes");
  assert.deepEqual(await h.database.readState("inventory"), persisted, "reads must not change data or revision");
  const restarted = new InventoryStore({ database: h.database, dataDir: "/unused", nodesPath: "/unused/nodes.json", legacySessionPath: "/unused/session.json" });
  assertNoInventedResources(await restarted.read());
  assert.equal(restarted.revisionOf(await restarted.read()), revision);
  assert.deepEqual(await h.database.readState("inventory"), persisted, "restart must be idempotent");
 });
}

test("legacy JSON and seed-node imports keep all absent protocol collections empty", async t => {
 for (const seedOnly of [false, true]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-upgrade-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inventory = legacyInventory(28), nodesPath = path.join(root, "nodes.json");
  if (seedOnly) await fs.writeFile(nodesPath, JSON.stringify(inventory.nodes));
  else await fs.writeFile(path.join(root, "inventory.json"), JSON.stringify(inventory));
  const store = new InventoryStore({ database: new MemoryDatabase(), dataDir: root, nodesPath, legacySessionPath: path.join(root, "no-session.json") });
  const state = await store.read(); assert.equal(state.nodes.length, 2); assertNoInventedResources(state);
 }
});

test("previewing and explicitly saving another resource on upgraded nodes never adds Direct/Kernel/Pipe", async t => {
 const h = await setupResourceApi(t, { inventory: legacyInventory(28) });
 const original = await h.store.read(), persisted = await h.database.readState("inventory");
 const preview = await h.request("POST", "/api/statics/preview", {
  label: "Explicit route", name: "requested_static", nodeId: "one", family: "ipv4", routes: [{ id: "route_one", prefix: "198.51.100.0/24", type: "blackhole" }],
 });
 assert.equal(preview.statusCode, 200, preview.body); const candidate = preview.json(); assert.equal(candidate.valid, true);
 assert.deepEqual(await h.database.readState("inventory"), persisted);
 assert.ok(h.calls.every(call => call.method === "bird.stage"));
 for (const config of candidate.configs) assert.doesNotMatch(config.config, /^protocol\s+(?:direct|kernel|pipe)\s/m);
 h.calls.length = 0;
 const saved = await h.request("POST", "/api/statics", { ...candidate.resource, previewId: candidate.previewId, inventoryRevision: candidate.inventoryRevision });
 assert.equal(saved.statusCode, 201, saved.body);
 const state = await h.store.read(); assert.equal(state.staticProtocols.length, 1);
 for (const key of collections.filter(key => key !== "staticProtocols")) assert.deepEqual(state[key], original[key]);
 assert.deepEqual(state.nodes, original.nodes);
 assert.ok(h.calls.some(call => call.method === "bird.apply"));
 assert.ok(h.calls.every(call => call.nodeId === "one"), "the other legacy node must not be deployed");
 for (const call of h.calls.filter(call => call.params.config)) assert.doesNotMatch(call.params.config, /^protocol\s+(?:direct|kernel|pipe)\s/m);
});

for (const version of [26, 27, 28, 29, 30, 31]) test(`v${version} keeps existing Kernel policy defaults and disabled resources without inventing extra protocols`, async t => {
 const input = legacyInventory(version);
 input.directProtocols = [{ id: "kept_direct", nodeId: "one", name: "kept_direct", enabled: false }];
 input.kernelProtocols = [
  { id: "legacy_defaults", name: "legacy_defaults", nodeIds: ["one"], ipv4: true, ipv6: false },
  { id: "explicit_policy", name: "explicit_policy", nodeIds: ["two"], ipv4: true, ipv6: false, importPolicy: { mode: "form", formAction: "none" }, exportPolicy: { mode: "form", formAction: "all" }, enabled: false },
 ];
 const h = await setupResourceApi(t, { inventory: input });
 const state = await h.store.read();
 assert.equal(state.directProtocols.length, 1); assert.equal(state.directProtocols[0].enabled, false);
 assert.deepEqual(state.kernelProtocols.map(resource => resource.id), ["legacy_defaults", "explicit_policy"]);
 const legacy = state.kernelProtocols[0], explicit = state.kernelProtocols[1];
 assert.equal(legacy.importPolicy.formAction, "all"); assert.equal(legacy.exportPolicy.formAction, "none");
 assert.equal(legacy.importPolicies.ipv4.formAction, "all"); assert.equal(legacy.exportPolicies.ipv4.policy.formAction, "none");
 assert.equal(explicit.importPolicy.formAction, "none"); assert.equal(explicit.exportPolicy.formAction, "all"); assert.equal(explicit.enabled, false);
 assert.deepEqual(state.pipeProtocols, []);
 const config = configBundleForNode(state, state.nodes[0]).main;
 assert.match(config, /protocol kernel legacy_defaults\s*\{/); assert.match(config, /import all;/); assert.match(config, /export none;/);
 assert.doesNotMatch(config, /protocol direct|protocol pipe|protocol kernel legacy_kernel/);
 assert.doesNotMatch(configBundleForNode(state, state.nodes[1]).main, /^protocol\s/m);
 assert.equal(h.calls.length, 0);
 const record = await h.database.readState("inventory");
 await h.store.initialize(); await h.store.read(); assert.deepEqual(await h.database.readState("inventory"), record);
});

test("MySQL upgrades legacy nodes without creating protocols and preserves Kernel semantics across restart", { skip: !process.env.BIRDBOX_TEST_MYSQL_URL }, async t => {
 const database = createDatabaseFromEnvironment({ NODE_ENV: "integration", BIRDBOX_DATABASE_URL: process.env.BIRDBOX_TEST_MYSQL_URL });
 t.after(() => database.close()); await database.initialize();
 for (const version of versions) {
  const input = legacyInventory(version), stateKey = `upgrade_${process.pid}_${version}_${Date.now()}`;
  await database.createState(stateKey, input);
  const options = { database, dataDir: "/unused", nodesPath: "/unused/nodes.json", legacySessionPath: "/unused/session.json", stateKey };
  const store = new InventoryStore(options); assertNoInventedResources(await store.read());
  const migrated = await database.readState(stateKey);
  assertNoInventedResources(await new InventoryStore(options).read());
  assert.deepEqual(await database.readState(stateKey), migrated);
 }
 const stateKey = `upgrade_kernel_${process.pid}_${Date.now()}`, input = legacyInventory(28);
 input.kernelProtocols = [{ id: "kept", name: "kept_kernel", nodeIds: ["one"], ipv6: false }];
 await database.createState(stateKey, input);
 const options = { database, dataDir: "/unused", nodesPath: "/unused/nodes.json", legacySessionPath: "/unused/session.json", stateKey };
 const store = new InventoryStore(options), state = await store.read();
 assert.equal(state.kernelProtocols.length, 1); assert.equal(state.kernelProtocols[0].importPolicy.formAction, "all"); assert.equal(state.kernelProtocols[0].exportPolicy.formAction, "none");
 const migrated = await database.readState(stateKey);
 assert.deepEqual(await new InventoryStore(options).read(), state);
 assert.deepEqual(await database.readState(stateKey), migrated);
});
