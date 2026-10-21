import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePipeProtocol, pipeManagedTables, knownPipeTables } from "../src/bird-pipe.js";
import { validateInventory } from "../src/bird.js";
import { configForNode } from "../src/inventory-domain.js";
import { inspectProtocolDetails, inspectProtocolRoutes } from "../src/bird-runtime.js";
import { parsePipeRuntime } from "../src/bird-pipe-runtime.js";
const exec = promisify(execFile);
const nodes = [{ id: "one", name: "One", transport: "local", routerId: "192.0.2.1" }, { id: "two", name: "Two", transport: "agent", routerId: "192.0.2.2" }];
const pipe = (patch = {}) => ({ id: "pipe_one", label: "Test pipe", name: "test_pipe", nodeIds: ["one"], family: "ipv4", table: { name: "master4", source: "existing" }, peerTable: { name: "peer4", source: "managed" }, ...patch });
const inventory = (pipes = [], patch = {}) => validateInventory({ nodes, pipeProtocols: pipes, ...patch });
test("Pipe defaults, AF, scopes and invalid references", () => {
  const p = normalizePipeProtocol(pipe());
  assert.equal(p.exportPolicy.formAction, "all"); assert.equal(p.importPolicy.formAction, "none");
  assert.equal(inventory().version, 31); assert.deepEqual(inventory().pipeProtocols, []);
  assert.equal(normalizePipeProtocol(pipe({ nodeIds: null })).nodeIds, null);
  // The same spelling can denote different families on disjoint nodes.
  assert.doesNotThrow(() => inventory([pipe(), pipe({ id: "v6", name: "pipe_v6", nodeIds: ["two"], family: "ipv6", table: { name: "master6" } })]));
  for (const patch of [{ nodeIds: [] }, { name: "x;shutdown" }, { peerTable: { name: "master4" } }, { family: "ipv6" }, { peerTable: { name: "master4", source: "managed" } }, { peerTable: { name: "bb_spe_t_x", source: "managed" } }, { peerTable: { name: "birdbox_device", source: "managed" } }]) assert.throws(() => normalizePipeProtocol(pipe(patch)));
  assert.throws(() => inventory([pipe({ nodeIds: ["missing"] })]), /不存在的节点/);
});
test("Pipe managed tables are shared per node, retained when disabled and removed at last reference", () => {
  const second = pipe({ id: "second", name: "pipe_two", table: { name: "peer4", source: "existing" }, peerTable: { name: "other4", source: "managed" } });
  let state = inventory([pipe({ enabled: false }), second]);
  const config = configForNode(state, state.nodes[0]);
  assert.equal((config.match(/ipv4 table peer4;/g) ?? []).length, 1);
  assert.doesNotMatch(config, /protocol pipe test_pipe/); assert.match(config, /protocol pipe pipe_two/);
  assert.ok(config.indexOf("ipv4 table peer4;") < config.indexOf("protocol pipe"));
  assert.doesNotMatch(configForNode(state, state.nodes[1]), /peer4|protocol pipe/);
  state = inventory([]); assert.doesNotMatch(configForNode(state, state.nodes[0]), /peer4/);
  assert.throws(() => pipeManagedTables([normalizePipeProtocol(pipe()), normalizePipeProtocol(pipe({ id: "v6", family: "ipv6", table: { name: "master6" } }))]), /地址族冲突/);
  assert.throws(() => inventory([pipe({ peerTable: { name: "test_pipe", source: "managed" } })]), /标识符冲突/);
  assert.equal(knownPipeTables(inventory([pipe({ enabled: false })])).filter(t => t.name === "peer4").length, 1);
});
test("Pipe independent policies enforce full scope, enabled resources, recursive Function dependencies and cycles", () => {
  const fn = { id: "fn", name: "test_fn", label: "Function", nodeIds: ["one"], enabled: true, callable: true, source: "function test_fn() { return true; }" };
  const policy = { mode: "combined", steps: [{ type: "function", functionId: "fn", action: "accept" }], formAction: "none" };
  const p = pipe({ exportPolicy: policy });
  const state = inventory([p], { functions: [fn] });
  const config = configForNode(state, state.nodes[0]);
  assert.match(config, /import none;/); assert.match(config, /if test_fn\(\) then accept;/);
  assert.ok(config.indexOf("function test_fn") < config.indexOf("protocol pipe"));
  assert.throws(() => inventory([pipe({ ...p, nodeIds: null })], { functions: [fn] }), /不可用|作用域/);
  assert.throws(() => inventory([p], { functions: [{ ...fn, enabled: false }] }), /不可用|停用/);
  assert.throws(() => inventory([p], { functions: [{ ...fn, source: "function test_fn() { return test_fn(); }" }] }), /循环/);
  assert.throws(() => inventory([pipe({ nodeIds: null, exportPolicy: { mode: "custom", filterId: "filter" } })], { filters: [{ id: "filter", name: "scope_filter", enabled: true, source: "filter scope_filter { accept; }", nodeIds: ["one", "two"] }] }), /不可用/);
  const dep = { ...fn, id: "dep", name: "dep_fn", source: "function dep_fn() { return true; }", enabled: false };
  assert.throws(() => inventory([p], { functions: [dep, { ...fn, source: "function test_fn() { return dep_fn(); }" }] }), /停用/);
  assert.throws(() => inventory([pipe({ exportPolicy: { mode: "custom", filterId: "filter" } })], { filters: [{ id: "filter", name: "filter_fn", source: "filter filter_fn { accept; }", nodeIds: ["two"] }] }), /不可用/);
});
test("Pipe runtime uses native protocol state and preserves unknown statistics", () => {
  const raw = "1002-test_pipe Pipe --- up 00:00 master4 <=> peer4\n1006-  Channel main\n    Table: master4\n    Peer table: peer4\n    Import state: up\n    Routes: 0 imported, 2 exported\n1002-other Pipe --- down\n    Routes: 99 imported, 99 exported";
  const result = parsePipeRuntime(raw, "test_pipe"); assert.equal(result.state, "up"); assert.equal(result.primary.exported, 2); assert.equal(result.peer.exported, null);
  assert.equal(parsePipeRuntime("No protocols match", "test_pipe").state, "not_configured");
  assert.equal(parsePipeRuntime("test_pipe Pipe --- up", "test_pipe").primary.imported, null);
  assert.equal(parsePipeRuntime("test_pipe Pipe --- down 00:00", "test_pipe").state, "down");
});
// No kernel/BGP protocols or host route changes: private daemon, socket and temporary config only.
for (const family of ["ipv4", "ipv6"]) test(`real BIRD ${family}: forward, reverse default deny, bidirectional, Filter and original attributes`, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-pipe-native-"));
  const socketPath = path.join(root, "bird.ctl"), configPath = path.join(root, "bird.conf");
  let child;
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) { const stopped = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await stopped; } await fs.rm(root, { recursive: true, force: true }); });
  const master = family === "ipv4" ? "master4" : "master6";
  const forward = family === "ipv4" ? "198.51.100.0/24" : "2001:db8:1::/48";
  const blocked = family === "ipv4" ? "203.0.113.0/24" : "2001:db8:2::/48";
  const reverse = family === "ipv4" ? "192.0.2.0/24" : "2001:db8:3::/48";
  const node = { ...nodes[0], socketPath };
  async function write(reverseAllowed, filtered) {
    const state = inventory([pipe({ family, table: { name: master, source: "existing" }, importPolicy: { mode: "form", formAction: reverseAllowed ? "all" : "none" }, ...(filtered ? { exportPolicy: { mode: "custom", filterId: "drop" } } : {}) })], { nodes: [node], filters: filtered ? [{ id: "drop", name: "drop_prefix", enabled: true, nodeIds: null, source: `filter drop_prefix { if net = ${blocked} then reject; accept; }` }] : [] });
    const generated = configForNode(state, state.nodes[0]);
    assert.doesNotMatch(generated, /protocol kernel/);
    await fs.writeFile(configPath, `${generated}\nprotocol static primary_seed { ${family} { table ${master}; }; route ${forward} blackhole { bgp_local_pref = 177; bgp_community.add((64512,17)); }; route ${blocked} blackhole; }\nprotocol static peer_seed { ${family} { table peer4; }; route ${reverse} blackhole; }\n`);
    await exec("bird", ["-p", "-c", configPath]);
  }
  await write(false, false);
  child = spawn("bird", ["-f", "-c", configPath, "-s", socketPath, "-P", path.join(root, "bird.pid")], { stdio: "ignore" });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { await exec("birdc", ["-s", socketPath, "show status"]); ready = true; break; } catch { await new Promise(r => setTimeout(r, 25)); } }
  assert.ok(ready, "private BIRD started");
  const query = table => inspectProtocolRoutes(node, "test_pipe", family, "import", { tableOnly: true, table });
  let peer = await query("peer4"), primary = await query(master);
  assert.equal(peer.ok, true); assert.ok(peer.routes.some(r => r.prefix === forward)); assert.ok(!primary.routes.some(r => r.prefix === reverse));
  const origin = peer.routes.find(r => r.prefix === forward); assert.match(origin.summary, /primary_seed/); assert.match(origin.details, /BGP.local_pref: 177/); assert.match(origin.details, /\(64512,17\)/);
  let runtime = parsePipeRuntime((await inspectProtocolDetails(node, "test_pipe")).output, "test_pipe"); assert.equal(runtime.state, "up"); assert.equal(runtime.primary.exported, 2); assert.equal(runtime.primary.imported, 0);
  await write(true, false); await exec("birdc", ["-s", socketPath, "configure"]);
  for (let i = 0; i < 40; i++) { primary = await query(master); if (primary.routes.some(r => r.prefix === reverse)) break; await new Promise(r => setTimeout(r, 25)); }
  assert.ok(primary.routes.some(r => r.prefix === reverse));
  await write(true, true); await exec("birdc", ["-s", socketPath, "configure"]);
  for (let i = 0; i < 40; i++) { peer = await query("peer4"); if (!peer.routes.some(r => r.prefix === blocked)) break; await new Promise(r => setTimeout(r, 25)); }
  assert.ok(!peer.routes.some(r => r.prefix === blocked)); assert.ok(peer.routes.some(r => r.prefix === forward));
  const target = forward.split("/")[0]; const lookup = await inspectProtocolRoutes(node, "test_pipe", family, "import", { tableOnly: true, table: "peer4", target });
  assert.equal(lookup.routes[0]?.prefix, forward);
  const version = await exec("bird", ["--version"]);
  t.diagnostic(`${version.stdout}${version.stderr}`.trim() + "; local birdc transport; private socket; no kernel protocols");
});
