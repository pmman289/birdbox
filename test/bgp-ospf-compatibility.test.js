import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIbgpDomain, expandIbgpDomain } from '../src/bird.js';
import { InventoryStore } from '../src/store.js';
import { configBundleForNode } from '../src/inventory-domain.js';
import { setupResourceApi } from './helpers/resource-api.js';
import { MemoryDatabase, createDatabaseFromEnvironment } from '../src/database.js';

const policy = formAction => ({ mode: 'form', formAction, steps: [], filterId: null });
function legacyInventory(version, enabled = true) {
 const nodes = ['one', 'two'].map((id, i) => ({ id, name: id, transport: 'agent', routerId: `192.0.2.${i + 1}`, deploymentMode: 'include' }));
 const domain = normalizeIbgpDomain({ id: 'old_ibgp', name: 'Existing iBGP', asn: 64512,
  members: nodes.map((n, i) => ({ nodeId: n.id, address: `192.0.2.${i + 1}` })),
  adjacencies: [{ id: 'old_pair', leftNodeId: 'one', rightNodeId: 'two', leftSessionId: 'old_left', rightSessionId: 'old_right', enabled }], layout: {} });
 const initial = expandIbgpDomain(domain, nodes);
 initial.sessions.forEach((s, i) => {
  s.localPort = i ? 2179 : 1179;
  s.channels.ipv4.importPolicy = policy(i ? 'all' : 'none');
  s.channels.ipv6.exportPolicy = policy(i ? 'all' : 'none');
 });
 const expanded = expandIbgpDomain(domain, nodes, initial.sessions);
 const storedDomain = structuredClone(domain);
 if (version < 23) {
  storedDomain.families = ['ipv4', 'ipv6'];
  storedDomain.members = storedDomain.members.map(({ nodeId, address }) => ({ nodeId, address4: address, address6: null }));
 }
 return { version, nodes,
  peers: [...expanded.peers, { id: 'old_remote', nodeId: 'one', name: 'Existing upstream', address: '198.51.100.2', asn: 64513 }],
  sessions: [...expanded.sessions, { id: 'old_ebgp', nodeId: 'one', peerId: 'old_remote', protocolName: 'old_upstream', localAddress: '192.0.2.1', localAsn: 64512, localPort: 179, enabled,
   bgp: { authentication: 'md5', password: 'isolated-legacy-key', connectionMode: 'multihop', multihopTtl: 5 },
   channels: { ipv4: { enabled: true, importPolicy: policy('none'), exportPolicy: policy('all') }, ipv6: { enabled: false, importPolicy: policy('all'), exportPolicy: policy('none') } } }],
  ibgpDomains: [storedDomain], ospfDomains: [{ id: 'old_ospf', name: 'Existing OSPF',
   nodeConfigs: nodes.map(n => ({ nodeId: n.id, enabled, versions: ['ospfv2', 'ospfv3'], importPolicies: { ospfv2: policy('none'), ospfv3: policy('all') }, exportPolicies: { ospfv2: policy('all'), ospfv3: policy('none') } })),
   links: [{ id: 'old_link', fromNodeId: 'one', toNodeId: 'two', localInterface: 'eth0', remoteInterface: 'eth1', area: '0.0.0.0', cost: 20, hello: 5, dead: 20,
    localOptions: { type: 'ptp', priority: 11 }, remoteOptions: { type: 'ptp', priority: 22 } }], layout: {} }] };
}
// iBGP replacement can reorder independent BGP declarations; compare each
// complete declaration rather than treating their order as a routing change.
const ordered = text => text.split(/(?=^protocol )/m).map(block => block.trim()).sort().join('\n\n');
const configs = state => Object.fromEntries(state.nodes.map(n => { const bundle = configBundleForNode(state, n); return [n.id, { ...bundle, main: ordered(bundle.main) }]; }));
const accepted = p => ({ ...p.domain, mode: 'apply', inventoryRevision: p.inventoryRevision, previewId: p.previewId, candidateHash: p.candidateHash });

test('JSON persistence keeps OSPF initialization idempotent and confirms commits after a lost response', async () => {
 class JsonDatabase extends MemoryDatabase {
  async createState(key, value) { return super.createState(key, JSON.parse(JSON.stringify(value))); }
  async replaceState(key, revision, value) {
   const result = await super.replaceState(key, revision, JSON.parse(JSON.stringify(value)));
   if (this.loseResponse) { this.loseResponse = false; throw new Error('commit response lost'); }
   return result;
  }
 }
 const database = new JsonDatabase(); await database.createState('inventory', legacyInventory(28));
 const options = { database, dataDir: '/unused', nodesPath: '/unused/nodes.json', legacySessionPath: '/unused/session.json' };
 const store = new InventoryStore(options), state = await store.read(), persisted = await database.readState('inventory');
 assert.deepEqual(await new InventoryStore(options).read(), state);
 assert.deepEqual(await database.readState('inventory'), persisted);
 const changed = structuredClone(state); changed.nodes[0].name = 'Explicit rename'; database.loseResponse = true;
 const committed = await store.replace(state, changed);
 assert.equal(committed.nodes[0].name, 'Explicit rename'); assert.equal(store.revisionOf(committed), persisted.revision + 1);
 assert.deepEqual(configs(committed), configs(state));
});

for (const version of [22, 23, 28, 30]) for (const enabled of [true, false]) {
 test(`v${version} ${enabled ? 'active' : 'disabled'} eBGP/iBGP/OSPF survives upgrade, restart, readonly review and reviewed API roundtrip`, async t => {
  const h = await setupResourceApi(t, { inventory: legacyInventory(version, enabled) });
  const baseline = await h.store.read(), originalConfigs = configs(baseline);
  assert.equal(h.calls.length, 0, 'upgrade must not contact or deploy nodes');
  assert.deepEqual(baseline.sessions.map(s => s.id), ['old_left', 'old_right', 'old_ebgp']);
  assert.deepEqual(baseline.ibgpDomains[0].adjacencies.map(a => a.id), ['old_pair']);
  assert.deepEqual(baseline.sessions.map(s => s.enabled), [enabled, enabled, enabled]);
  for (const key of ['directProtocols', 'kernelProtocols', 'pipeProtocols', 'staticProtocols']) assert.deepEqual(baseline[key], []);
  const persisted = await h.database.readState('inventory');
  const restarted = new InventoryStore({ database: h.database, dataDir: '/unused', nodesPath: '/unused/nodes.json', legacySessionPath: '/unused/session.json' });
  assert.deepEqual(await restarted.read(), baseline);
  assert.deepEqual(await h.database.readState('inventory'), persisted);
  for (const url of ['/api/ibgp-domains', '/api/ospf', '/api/sessions/editor-context?nodeId=one&peerId=old_remote']) {
   const read = await h.request('GET', url); assert.equal(read.statusCode, 200, read.body);
  }
  assert.equal(h.calls.length, 0); assert.deepEqual(await h.database.readState('inventory'), persisted);
  const context = (await h.request('GET', '/api/sessions/editor-context?nodeId=one&peerId=old_remote')).json();
  assert.equal(context.session.bgp.password, '********');
  const ep = await h.request('POST', '/api/sessions/preview', { ...context.session, inventoryRevision: context.inventoryRevision });
  assert.equal(ep.statusCode, 200, ep.body); const e = ep.json(); assert.ok(e.valid);
  assert.deepEqual(await h.database.readState('inventory'), persisted);
  assert.equal(h.calls.some(c => c.method === 'bird.apply'), false);
  const applied = await h.request('POST', '/api/sessions/apply', { ...e.session, mode: 'apply', inventoryRevision: e.inventoryRevision, previewId: e.previewId, candidateHash: e.candidateHash });
  assert.equal(applied.statusCode, enabled ? 202 : 200, applied.body);
  assert.equal((await h.store.read()).sessions.find(s => s.id === 'old_ebgp').bgp.password, 'isolated-legacy-key');
  assert.deepEqual(configs(await h.store.read()), originalConfigs, 'eBGP no-op edit must preserve all node configs');
  for (const [listUrl, previewUrl, saveUrl] of [
   ['/api/ibgp-domains', '/api/ibgp-domains/preview', '/api/ibgp-domains/old_ibgp'],
   ['/api/ospf', '/api/ospf/preview', '/api/ospf/old_ospf'],
  ]) {
   const list = (await h.request('GET', listUrl)).json();
   const before = await h.database.readState('inventory'); h.calls.length = 0;
   const review = await h.request('POST', previewUrl, { ...list.domains[0], inventoryRevision: list.inventoryRevision });
   assert.equal(review.statusCode, 200, review.body); const p = review.json(); assert.ok(p.valid);
   assert.deepEqual(await h.database.readState('inventory'), before); assert.equal(h.calls.some(c => c.method === 'bird.apply'), false);
   const save = await h.request('PUT', saveUrl, { ...accepted(p), ...(p.sessions ? { sessionUpdates: p.sessions } : {}) });
   assert.equal(save.statusCode, 200, save.body);
   assert.deepEqual(configs(await h.store.read()), originalConfigs, `${listUrl} no-op edit must preserve all node configs`);
  }
  const saved = await h.store.read();
  assert.deepEqual(saved.nodes, baseline.nodes); assert.deepEqual(saved.sessions.map(s => s.id).sort(), baseline.sessions.map(s => s.id).sort());
  assert.deepEqual(saved.ospfDomains[0].links[0].localOptions.priority, 11); assert.equal(saved.ospfDomains[0].links[0].remoteOptions.priority, 22);
  for (const key of ['directProtocols', 'kernelProtocols', 'pipeProtocols', 'staticProtocols']) assert.deepEqual(saved[key], []);
 });
}

test('legacy per-node OSPF Area settings survive opening and reviewing the topology model', async t => {
 const input = legacyInventory(28);
 input.ospfDomains[0].nodeConfigs.forEach((n, i) => { n.areaOptions = { '0.0.0.0': { defaultCost: i ? 50 : 10, networks: [{ prefix: i ? '198.51.100.0/24' : '203.0.113.0/24', hidden: true }] } }; });
 const h = await setupResourceApi(t, { inventory: input });
 const before = configs(await h.store.read());
 const listed = (await h.request('GET', '/api/ospf')).json();
 const review = await h.request('POST', '/api/ospf/preview', listed.domains[0]);
 assert.equal(review.statusCode, 200, review.body); const p = review.json(); assert.ok(p.valid);
 for (const c of p.configs) assert.equal(ordered(c.config), before[c.nodeId].main.replaceAll('isolated-legacy-key', '********'), 'reviewing an unchanged legacy domain must not alter per-node Area configuration');
 const saved = await h.request('PUT', '/api/ospf/old_ospf', accepted(p)); assert.equal(saved.statusCode, 200, saved.body);
 assert.deepEqual(configs(await h.store.read()), before);
 const changed = structuredClone(p.domain); changed.members[0].routerId = '192.0.2.10';
 const edit = (await h.request('POST', '/api/ospf/preview', changed)).json(); assert.ok(edit.valid);
 assert.equal(edit.domain.nodeConfigs[1].areaOptions['0.0.0.0'].defaultCost, 50);
 assert.equal(edit.domain.nodeConfigs[0].areaOptions['0.0.0.0'].networks[0].hidden, true);
});

test('OSPF explicit Area edits override legacy type flags, retain prefix attributes and allow clearing prefixes', async t => {
 const input = legacyInventory(28);
 input.ospfDomains[0].links[0].area = '0.0.0.1';
 input.ospfDomains[0].nodeConfigs.forEach(n => { n.areaOptions = { '0.0.0.1': { stub: true, networks: [{ prefix: '203.0.113.0/24', hidden: true }] } }; });
 const h = await setupResourceApi(t, { inventory: input });
 const domain = (await h.request('GET', '/api/ospf')).json().domains[0];
 domain.areas[0].type = 'normal'; domain.areas[0].options.defaultCost = 30;
 let response = await h.request('POST', '/api/ospf/preview', domain); assert.equal(response.statusCode, 200, response.body);
 let p = response.json(); assert.ok(p.valid);
 for (const n of p.domain.nodeConfigs) { assert.equal(n.areaOptions['0.0.0.1'].stub, false); assert.equal(n.areaOptions['0.0.0.1'].networks[0].hidden, true); }
 p.domain.areas[0].prefixes = [];
 response = await h.request('POST', '/api/ospf/preview', p.domain); assert.equal(response.statusCode, 200, response.body);
 p = response.json(); assert.ok(p.valid); assert.deepEqual(p.domain.areas[0].prefixes, []);
 const save = await h.request('PUT', '/api/ospf/old_ospf', accepted(p)); assert.equal(save.statusCode, 200, save.body);
 for (const n of (await h.store.read()).ospfDomains[0].nodeConfigs) assert.deepEqual(n.areaOptions['0.0.0.1'].networks, []);
});

test('MySQL preserves populated legacy BGP/OSPF inventories and generated configs across repeated restarts', { skip: !process.env.BIRDBOX_TEST_MYSQL_URL }, async t => {
 const database = createDatabaseFromEnvironment({ NODE_ENV: 'integration', BIRDBOX_DATABASE_URL: process.env.BIRDBOX_TEST_MYSQL_URL });
 t.after(() => database.close()); await database.initialize();
 for (const version of [22, 23, 28, 30]) for (const enabled of [false, true]) {
  const stateKey = `bgp_ospf_${process.pid}_${version}_${enabled}_${Date.now()}`;
  await database.createState(stateKey, legacyInventory(version, enabled));
  const options = { database, stateKey, dataDir: '/unused', nodesPath: '/unused/nodes.json', legacySessionPath: '/unused/session.json' };
  const first = await new InventoryStore(options).read(), record = await database.readState(stateKey);
  const next = await new InventoryStore(options).read();
  assert.deepEqual(next, first); assert.deepEqual(configs(next), configs(first));
  assert.deepEqual(await database.readState(stateKey), record);
  assert.equal(next.sessions.length, 3); assert.equal(next.ibgpDomains[0].adjacencies.length, 1); assert.equal(next.ospfDomains[0].links.length, 1);
  assert.ok(next.sessions.every(s => s.enabled === enabled));
  for (const key of ['directProtocols', 'kernelProtocols', 'pipeProtocols', 'staticProtocols']) assert.deepEqual(next[key], []);
  const store = new InventoryStore(options), snapshot = await store.read();
  const edited = structuredClone(snapshot); edited.nodes[0].name = 'Explicit rename';
  const replaceState = database.replaceState.bind(database);
  database.replaceState = async (...args) => { await replaceState(...args); throw new Error('simulated lost MySQL commit response'); };
  try {
   const committed = await store.replace(snapshot, edited);
   assert.equal(committed.nodes[0].name, 'Explicit rename');
   assert.equal(store.revisionOf(committed), record.revision + 1);
  } finally { database.replaceState = replaceState; }
  assert.deepEqual(configs(await new InventoryStore(options).read()), configs(first));
 }
});
