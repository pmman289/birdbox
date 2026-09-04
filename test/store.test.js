import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { InventoryStore } from "../src/store.js";
import { MemoryDatabase } from "../src/database.js";

test("starts with an empty inventory so the first node can be onboarded from the UI", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-store-empty-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "nodes.json"), "[]\n");
  const store = new InventoryStore({
    database: new MemoryDatabase(),
    dataDir: root,
    nodesPath: path.join(root, "nodes.json"),
    legacySessionPath: path.join(root, "session.json"),
  });

  const state = await store.read();
  assert.deepEqual(state.nodes, []);
  assert.deepEqual(state.sessions, []);
});

test("confirms an inventory CAS that committed before its response was lost", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-store-confirm-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  class AmbiguousCommitDatabase extends MemoryDatabase {
    failAfterCommit = false;

    async replaceState(...args) {
      const result = await super.replaceState(...args);
      if (this.failAfterCommit) {
        this.failAfterCommit = false;
        const error = new Error("connection lost after commit");
        error.code = "ECONNRESET";
        throw error;
      }
      return result;
    }
  }
  const database = new AmbiguousCommitDatabase();
  const initial = { version: 20, nodes: [], peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], sessions: [], ibgpDomains: [] };
  await database.createState("inventory", initial);
  const store = new InventoryStore({
    database,
    dataDir: root,
    nodesPath: path.join(root, "nodes.json"),
    legacySessionPath: path.join(root, "session.json"),
  });
  const current = await store.read();
  const target = { ...current, defines: [{
    id: "define_confirmed", nodeIds: null, label: "Confirmed", name: "CONFIRMED", type: "expression", value: "1", enabled: true,
  }] };
  database.failAfterCommit = true;

  const replaced = await store.replace(current, target);
  assert.deepEqual(replaced, target);
  assert.equal((await database.readState("inventory")).revision, 3);
});

test("loads legacy dependency mismatches but requires a valid graph for the next write", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-store-dependencies-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const database = new MemoryDatabase();
  await database.createState("inventory", {
    version: 25,
    nodes: [{ id: "local", name: "Local", transport: "local", routerId: "192.0.2.1" }],
    peers: [],
    defines: [],
    functions: [{
      id: "function_rpki",
      nodeIds: null,
      label: "RPKI policy",
      name: "function_rpki",
      source: "function function_rpki() { return roa_check(ROA_LOCAL, net, bgp_path.last) = ROA_VALID; }",
      enabled: true,
    }],
    filters: [],
    rpki: [{
      id: "rpki_local",
      nodeIds: ["local"],
      label: "Local ROA",
      name: "local_roa",
      sourceType: "file",
      roa4Table: "ROA_LOCAL",
      roa6Table: null,
      file4: "/dev/null",
      file6: null,
      enabled: true,
    }],
    staticProtocols: [],
    sessions: [],
    ibgpDomains: [],
  });
  const store = new InventoryStore({
    database,
    dataDir: root,
    nodesPath: path.join(root, "nodes.json"),
    legacySessionPath: path.join(root, "session.json"),
  });

  const current = await store.read();
  assert.deepEqual(current.rpki[0].nodeIds, ["local"]);
  await assert.rejects(
    () => store.replace(current, { ...current, nodes: [{ ...current.nodes[0], name: "Renamed" }] }),
    /作用域不兼容的 RPKI local_roa/,
  );
  const repaired = await store.replace(current, {
    ...current,
    rpki: [{ ...current.rpki[0], nodeIds: null }],
  });
  assert.equal(repaired.rpki[0].nodeIds, null);
});

test("refuses a newer inventory format without changing the stored document", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-store-newer-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const database = new MemoryDatabase();
  const futureInventory = {
    version: 29,
    futureOnly: { preserve: true },
    nodes: [], peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], sessions: [],
  };
  await database.createState("inventory", futureInventory);
  const store = new InventoryStore({
    database,
    dataDir,
    nodesPath: path.join(root, "nodes.json"),
    legacySessionPath: path.join(dataDir, "session.json"),
  });

  await assert.rejects(
    () => store.initialize(),
    (error) => error.code === "INVENTORY_VERSION_TOO_NEW" && error.status === 409,
  );
  const persisted = await database.readState("inventory");
  assert.equal(persisted.revision, 1);
  assert.deepEqual(persisted.value, futureInventory);
});

test("migrates legacy shared-resource scopes to nodeIds", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-store-resource-scope-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const database = new MemoryDatabase();
  await database.createState("inventory", {
    version: 23,
    nodes: [
      { id: "left", name: "Left", transport: "local", routerId: "192.0.2.1", listenPort: 179 },
      { id: "right", name: "Right", transport: "ssh", sshHost: "right.example", sshUser: "birdbox", routerId: "192.0.2.2", listenPort: 179 },
    ],
    peers: [],
    defines: [{ id: "legacy_define", nodeId: "left", label: "Legacy", name: "LEGACY", type: "expression", value: "1", enabled: true }],
    functions: [{ id: "legacy_function", nodeId: null, label: "Global helper", name: "global_helper", source: "function global_helper() { return true; }", enabled: true }],
    filters: [{ id: "legacy_filter", nodeId: "right", label: "Legacy filter", name: "legacy_filter", source: "filter legacy_filter { accept; }", enabled: true }],
    rpki: [{ id: "legacy_rpki", nodeId: "left", label: "Legacy ROA", name: "legacy_roa", sourceType: "file", roa4Table: "LEGACY_ROA4", roa6Table: null, file4: "/dev/null", file6: null, enabled: true }],
    staticProtocols: [], sessions: [], ibgpDomains: [],
  });
  const store = new InventoryStore({
    database,
    dataDir: root,
    nodesPath: path.join(root, "nodes.json"),
    legacySessionPath: path.join(root, "session.json"),
  });

  const state = await store.read();
  assert.equal(state.version, 28);
  assert.deepEqual(state.defines[0].nodeIds, ["left"]);
  assert.deepEqual(state.functions[0].nodeIds, null);
  assert.deepEqual(state.filters[0].nodeIds, ["right"]);
  assert.deepEqual(state.rpki[0].nodeIds, ["left"]);
  assert.equal(Object.hasOwn(state.defines[0], "nodeId"), false);
  assert.equal(Object.hasOwn(state.functions[0], "nodeId"), false);
  assert.equal(Object.hasOwn(state.filters[0], "nodeId"), false);
  assert.equal(Object.hasOwn(state.rpki[0], "nodeId"), false);
  assert.deepEqual((await database.readState("inventory")).value, state);
});

test("migrates v22 iBGP members to one transport address", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-store-ibgp-address-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const database = new MemoryDatabase();
  await database.createState("inventory", {
    version: 22,
    nodes: [
      { id: "left", name: "Left", transport: "local", routerId: "192.0.2.1", listenPort: 179 },
      { id: "right", name: "Right", transport: "ssh", sshHost: "192.0.2.2", sshUser: "bird", routerId: "192.0.2.2", listenPort: 179 },
    ],
    peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], sessions: [],
    ibgpDomains: [{
      id: "core", name: "Core", asn: 64512, families: ["ipv4"],
      members: [
        { nodeId: "left", address4: "192.0.2.1", address6: null },
        { nodeId: "right", address4: "192.0.2.2", address6: null },
      ],
      adjacencies: [], layout: {},
    }],
  });
  const store = new InventoryStore({
    database,
    dataDir: root,
    nodesPath: path.join(root, "nodes.json"),
    legacySessionPath: path.join(root, "session.json"),
  });

  const state = await store.read();
  assert.equal(state.version, 28);
  assert.deepEqual(state.ibgpDomains[0].members, [
    { nodeId: "left", address: "192.0.2.1" },
    { nodeId: "right", address: "192.0.2.2" },
  ]);
  assert.equal("families" in state.ibgpDomains[0], false);
});

test("migrates Static channel policies to node resources while upgrading v18 inventory", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-store-static-policy-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const database = new MemoryDatabase();
  await database.createState("inventory", {
    version: 18,
    nodes: [{ id: "local", name: "Local", transport: "local", routerId: "192.0.2.1", listenPort: 179 }],
    peers: [{ id: "peer_one", nodeId: "local", name: "Peer", address: "192.0.2.2", asn: 65002, port: 179 }],
    defines: [{
      id: "prefix_one", nodeId: "local", label: "Routes", name: "ROUTES", type: "cidr4",
      entries: ["10.0.0.0/24"], enabled: true,
    }],
    functions: [], filters: [], rpki: [],
    sessions: [{
      id: "session_one", nodeId: "local", peerId: "peer_one", protocolName: "peer_bgp",
      localAddress: null, localAsn: 65001, localPort: 179, enabled: true,
      channels: {
        ipv4: {
          enabled: true,
          static: { defineId: "prefix_one", action: "blackhole", import: "none", export: "all", raw: "" },
        },
        ipv6: { enabled: false },
      },
    }],
  });
  const store = new InventoryStore({
    database,
    dataDir: root,
    nodesPath: path.join(root, "nodes.json"),
    legacySessionPath: path.join(root, "session.json"),
  });
  const state = await store.read();
  assert.equal(state.version, 28);
  assert.equal(state.sessions[0].localAddress, null);
  assert.equal(state.sessions[0].channels.ipv4.static, undefined);
  assert.deepEqual(state.staticProtocols.map((resource) => ({
    nodeId: resource.nodeId,
    name: resource.name,
    family: resource.family,
    defineId: resource.defineId,
    action: resource.action,
    import: resource.import,
    export: resource.export,
    enabled: resource.enabled,
  })), [{
    nodeId: "local", name: "birdbox_static4_peer_bgp", family: "ipv4",
    defineId: "prefix_one", action: "blackhole", import: "none", export: "all", enabled: true,
  }]);
  assert.deepEqual(state.staticProtocols[0].routeFilters, { "10.0.0.0/24": { operations: [], custom: "" } });
});

test("migrates node-level BGP settings and advertised prefixes to schema v19", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-store-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, "inventory.json"), JSON.stringify({
    version: 2,
    nodes: [{
      id: "local",
      name: "Local",
      transport: "local",
      routerId: "192.0.2.1",
      address: "192.0.2.10",
      asn: 65001,
      listenPort: 11790,
    }],
    peers: [{ id: "peer_one", nodeId: "local", name: "Peer", address: "192.0.2.2", asn: 65002, port: 179 }],
    sessions: [{
      id: "session_one",
      nodeId: "local",
      peerId: "peer_one",
      protocolName: "peer_bgp",
      advertisePrefix: "10.10.0.0/16",
      multihop: true,
      enabled: true,
    }],
  }));

  const store = new InventoryStore({
    database: new MemoryDatabase(),
    dataDir,
    nodesPath: path.join(root, "unused-nodes.json"),
    legacySessionPath: path.join(dataDir, "session.json"),
  });
  const state = await store.read();

  assert.equal(state.version, 28);
  assert.equal(state.nodes[0].address, undefined);
  assert.equal(state.nodes[0].asn, undefined);
  assert.equal(state.sessions[0].localAddress, "192.0.2.10");
  assert.equal(state.sessions[0].localAsn, 65001);
  assert.equal(state.sessions[0].localPort, 11790);
  assert.equal(state.sessions[0].bgp.connectionMode, "multihop");
  assert.equal(state.sessions[0].bgp.multihopTtl, 10);
  assert.equal(state.sessions[0].channels.ipv4.static, undefined);
  assert.deepEqual(state.staticProtocols.map((resource) => [resource.family, resource.defineId, resource.action]), [
    ["ipv4", state.defines[0].id, "blackhole"],
  ]);
  assert.equal(state.sessions[0].channels.ipv4.exportDefineId, state.defines[0].id);
  assert.equal(state.sessions[0].channels.ipv4.enabled, true);
  assert.equal(state.sessions[0].channels.ipv6.enabled, true);
  assert.deepEqual(state.defines[0].entries, ["10.10.0.0/16"]);
  assert.equal(state.defines[0].name, "PL_PEER_BGP");
  assert.equal(state.defines[0].label, "peer_bgp CIDRs");
  assert.equal(state.defines[0].type, "cidr4");
  assert.deepEqual(state.functions, []);
  assert.deepEqual(state.filters, []);
  assert.equal(state.prefixLists, undefined);
  assert.deepEqual(state.sessions[0].channels.ipv4.importPolicy, { mode: "form", steps: [], filterId: null, formAction: "all" });
  assert.deepEqual(state.sessions[0].channels.ipv4.exportPolicy, { mode: "form", steps: [], filterId: null, formAction: "cidr" });
  assert.deepEqual(await store.read(), state);
});

test("migrates v8 Function order and combined policies to ordered v19 channel steps", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-store-policy-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, "inventory.json"), JSON.stringify({
    version: 8,
    nodes: [{ id: "local", name: "Local", transport: "local", routerId: "192.0.2.1", listenPort: 11790 }],
    peers: [{ id: "peer_one", nodeId: "local", name: "Peer", address: "192.0.2.2", asn: 65002, port: 179 }],
    prefixLists: [],
    functions: [
      { id: "function_late", nodeId: null, name: "late", source: "function late() { return true; }", order: 200, enabled: true },
      { id: "function_guard", nodeId: null, name: "guard", source: "function guard() { return true; }", order: 100, enabled: true },
    ],
    filters: [],
    sessions: [{
      id: "session_one", nodeId: "local", peerId: "peer_one", prefixListId: null,
      protocolName: "peer_bgp", localAddress: "192.0.2.1", localAsn: 65001, routeAction: null,
      importPolicy: { mode: "combined", functionIds: ["function_guard"], filterId: null },
      exportPolicy: { mode: "form", functionIds: [], filterId: null },
      multihop: false, enabled: true,
    }],
  }));

  const store = new InventoryStore({
    database: new MemoryDatabase(),
    dataDir,
    nodesPath: path.join(root, "unused-nodes.json"),
    legacySessionPath: path.join(dataDir, "session.json"),
  });
  const state = await store.read();
  assert.equal(state.version, 28);
  assert.deepEqual(state.staticProtocols, []);
  assert.equal(state.sessions[0].channels.ipv4.exportPolicy.formAction, "none");
  assert.deepEqual(state.functions.map((resource) => resource.name), ["guard", "late"]);
  assert.equal(state.functions[0].order, undefined);
  assert.deepEqual(state.sessions[0].channels.ipv4.importPolicy.steps, [
    { type: "function", functionId: "function_guard", action: "execute" },
    { type: "form" },
  ]);
});

test("merges v10 CIDR lists before expression Defines and preserves v19 resource references", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-store-v11-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, "inventory.json"), JSON.stringify({
    version: 10,
    nodes: [{ id: "local", name: "Local", transport: "local", routerId: "192.0.2.1", listenPort: 11790 }],
    peers: [{ id: "peer_one", nodeId: "local", name: "Peer", address: "192.0.2.2", asn: 65002, port: 179 }],
    prefixLists: [{
      id: "prefix_global", nodeId: null, name: "Global CIDRs", symbol: "PL_GLOBAL",
      entries: ["10.250.1.0/24"],
    }],
    defines: [{
      id: "define_pref", nodeId: null, name: "DEFAULT_PREF", value: "150", enabled: true,
    }],
    functions: [],
    filters: [],
    sessions: [{
      id: "session_one", nodeId: "local", peerId: "peer_one", prefixListId: "prefix_global",
      protocolName: "peer_bgp", localAddress: "192.0.2.1", localAsn: 65001, routeAction: "blackhole",
      importPolicy: { mode: "form", steps: [], filterId: null },
      exportPolicy: { mode: "form", steps: [], filterId: null },
      multihop: false, enabled: true,
    }],
  }));

  const store = new InventoryStore({
    database: new MemoryDatabase(),
    dataDir,
    nodesPath: path.join(root, "unused-nodes.json"),
    legacySessionPath: path.join(dataDir, "session.json"),
  });
  const state = await store.read();

  assert.equal(state.version, 28);
  assert.deepEqual(state.defines.map((resource) => [resource.id, resource.type]), [
    ["prefix_global", "cidr4"],
    ["define_pref", "expression"],
  ]);
  assert.equal(state.defines[0].nodeIds, null);
  assert.equal(state.defines[0].label, "Global CIDRs");
  assert.equal(state.sessions[0].channels.ipv4.exportDefineId, "prefix_global");
  assert.equal(state.sessions[0].localPort, 11790);
  assert.equal(state.sessions[0].bgp.connectionMode, "direct");
  assert.equal(state.sessions[0].channels.ipv4.importPolicy.formAction, "all");
  assert.equal(state.sessions[0].channels.ipv4.exportPolicy.formAction, "cidr");
  assert.equal(state.sessions[0].channels.ipv4.static, undefined);
  assert.deepEqual(state.staticProtocols.map((resource) => [resource.defineId, resource.action]), [["prefix_global", "blackhole"]]);
  assert.equal(state.sessions[0].prefixListId, undefined);
  assert.equal(state.prefixLists, undefined);
});

test("migrates v14 export policy and Static settings to a v19 node resource", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-store-v13-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir);
  const base = {
    version: 14,
    nodes: [{ id: "local", name: "Local", transport: "local", routerId: "192.0.2.1", listenPort: 11790 }],
    peers: [{ id: "peer_one", nodeId: "local", name: "Peer", address: "192.0.2.2", asn: 65002, port: 179 }],
    defines: [{ id: "prefix_one", nodeId: null, label: "Exports", name: "PL_EXPORTS", type: "cidr", entries: ["10.0.0.0/24"], enabled: true }],
    functions: [], filters: [],
    sessions: [{
      id: "session_one", nodeId: "local", peerId: "peer_one", exportDefineId: "prefix_one",
      protocolName: "peer_bgp", localAddress: "192.0.2.1", localAsn: 65001, localPort: 11790,
      routeAction: "blackhole", importPolicy: { mode: "form", steps: [], filterId: null, formAction: "all" },
      exportPolicy: { mode: "form", steps: [], filterId: null }, bgp: { connectionMode: "direct", multihopTtl: 10 },
      ipv4: {}, enabled: true,
    }],
  };
  await fs.writeFile(path.join(dataDir, "inventory.json"), JSON.stringify(base));
  const store = new InventoryStore({ database: new MemoryDatabase(), dataDir, nodesPath: "", legacySessionPath: "" });
  const state = await store.read();
  assert.equal(state.version, 28);
  assert.equal(state.sessions[0].channels.ipv4.exportPolicy.formAction, "cidr");
  assert.equal(state.sessions[0].channels.ipv6.exportPolicy.formAction, "none");
  assert.equal(state.sessions[0].channels.ipv4.static, undefined);
  assert.deepEqual(state.staticProtocols.map(({ defineId, action, import: importPolicy, export: exportPolicy, raw }) => ({
    defineId, action, import: importPolicy, export: exportPolicy, raw,
  })), [{
    defineId: "prefix_one", action: "blackhole", import: "all", export: "none", raw: "",
  }]);
  assert.equal(state.defines[0].type, "cidr4");
});
