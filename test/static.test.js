import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeStaticProtocol, staticRouteAction } from '../src/bird-static.js';
import { parseStaticRuntime } from '../src/bird-static-runtime.js';
import { validateInventory } from '../src/bird-inventory.js';
import { configForNode } from '../src/inventory-domain.js';
import { defineRoute, routeForwarding } from '../apps/web/src/shared/static-route-sources.ts';
const node = { id: 'local', name: 'Local', transport: 'local', routerId: '192.0.2.1' };
const hop = (address, iface = null, rest = {}) => ({ address, interface: iface, weight: 1, bfd: false, onlink: false, ...rest });
const route = (rest = {}) => ({ id: 'r1', prefix: '198.51.100.0/24', type: 'blackhole', ...rest });
const resource = (rest = {}) => ({ id: 'static_test', nodeId: 'local', name: 'static_test', label: 'Static', routes: [route()], ...rest });
test('Static normalizes legacy defaults and direct routes without a Define; duplicate prefixes retain separate identities', () => {
 const value = normalizeStaticProtocol(resource({ routes: [route(), route({ id: 'r2', type: 'prohibit' })] }));
 assert.equal(value.routes.length, 2); assert.deepEqual(value.table, { name: 'master4', source: 'existing' });
 assert.equal(value.importPolicy.formAction, 'all'); assert.equal(value.checkLink, false);
 assert.throws(() => normalizeStaticProtocol(resource({ routes: [route(), route()] })), /ID 重复/);
});
test('Static validates AF, scoped IPv6, interfaces, ECMP, onlink, BFD and field limits', () => {
 for (const invalid of [route({ prefix: '2001:db8::/48' }), route({ type: 'via', nextHops: [] }), route({ type: 'via', nextHops: [hop('2001:db8::1')] }), route({ type: 'via', nextHops: [hop(null)] }), route({ type: 'via', nextHops: [hop('192.0.2.2', null, { onlink: true })] }), route({ type: 'via', nextHops: [hop(null, 'eth0', { bfd: true })] }), route({ type: 'via', nextHops: [hop('192.0.2.2', null, { weight: 257 })] }), route({ type: 'via', nextHops: [hop('192.0.2.2', 'eth0;shutdown')] }), route({ type: 'via', nextHops: [hop('192.0.2.2'), hop('192.0.2.2')] }), route({ type: 'recursive', recursiveVia: 'bad' })]) assert.throws(() => normalizeStaticProtocol(resource({ routes: [invalid] })));
 const v6 = rest => resource({ family: 'ipv6', routes: [route({ prefix: '2001:db8::/48', type: 'via', ...rest })] });
 assert.throws(() => normalizeStaticProtocol(v6({ nextHops: [hop('fe90::1')] })), /必须指定接口/);
 const normalized = normalizeStaticProtocol(v6({ nextHops: [hop('fe80::1%eth0.1')] }));
 assert.equal(normalized.routes[0].nextHops[0].address, 'fe80::1'); assert.equal(normalized.routes[0].nextHops[0].interface, 'eth0.1');
 assert.match(staticRouteAction(normalized.routes[0]), /via fe80::1 dev "eth0.1"/);
 assert.throws(() => normalizeStaticProtocol(resource({ table: { name: 'master6' } })), /master6/);
});
test('Static and Pipe share managed table ownership, retain disabled owners and reject AF or symbol collisions', () => {
 const a = resource({ enabled: false, table: { name: 'business', source: 'managed' } });
 const b = { id: 'pipe_test', name: 'pipe_test', label: 'Pipe', nodeIds: ['local'], family: 'ipv4', table: { name: 'master4', source: 'existing' }, peerTable: { name: 'business', source: 'managed' } };
 const state = validateInventory({ nodes: [node], staticProtocols: [a], pipeProtocols: [b] });
 const config = configForNode(state, state.nodes[0]); assert.equal((config.match(/ipv4 table business;/g) ?? []).length, 1); assert.doesNotMatch(config, /protocol static/);
 assert.throws(() => validateInventory({ nodes: [node], staticProtocols: [a, resource({ id: 's6', name: 's6', family: 'ipv6', table: { name: 'business', source: 'managed' }, routes: [route({ prefix: '2001:db8::/48' })] })] }), /地址族冲突/);
 assert.throws(() => validateInventory({ nodes: [node], staticProtocols: [resource({ table: { name: 'static_test', source: 'managed' } })] }), /标识符冲突/);
});
test('Static native BIRD parses ECMP, interface, onlink, recursive, BFD, repeated prefixes and per-route attributes for both families', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'birdbox-static-native-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
 const resources = ['ipv4', 'ipv6'].map((family, index) => resource({ id: `s${index}`, name: `s${index}`, family, table: { name: `custom${index}`, source: 'managed' }, checkLink: true, igpTable: family === 'ipv4' ? 'master4' : 'master6', routes: [
  route({ id: 'ecmp', prefix: family === 'ipv4' ? '198.51.100.0/24' : '2001:db8:1::/48', type: 'via', nextHops: [hop(family === 'ipv4' ? '192.0.2.1' : 'fe80::1', 'eth0', { bfd: true, weight: 2 }), hop(family === 'ipv4' ? '192.0.2.3' : 'fe80::3', 'eth0', { onlink: true }), hop(null, 'eth1')] }),
  route({ id: 'recursive', prefix: family === 'ipv4' ? '198.51.101.0/24' : '2001:db8:2::/48', type: 'recursive', recursiveVia: family === 'ipv4' ? '192.0.2.10' : '2001:db8::10' }),
  route({ id: 'backup', prefix: family === 'ipv4' ? '198.51.100.0/24' : '2001:db8:1::/48', type: 'prohibit', filter: { operations: [{ type: 'set', attribute: 'preference', value: 100 }], custom: 'ospf_metric1 = 10;' } })
 ] }));
 const state = validateInventory({ nodes: [node], staticProtocols: resources });
 const config = configForNode(state, state.nodes[0]); assert.match(config, /protocol bfd birdbox_bfd/);
 const file = path.join(root, 'bird.conf'); await fs.writeFile(file, config); await promisify(execFile)('/usr/sbin/bird', ['-p', '-c', file]);
 const rawState = validateInventory({ nodes: [node], staticProtocols: [resource({ routes: [], raw: 'route 198.51.100.0/24 via 192.0.2.2 bfd;' })] }); assert.match(configForNode(rawState, rawState.nodes[0]), /protocol bfd birdbox_bfd/);
});
test('Static runtime uses actual state and counters, never assumes up from routes', () => {
 assert.deepEqual(parseStaticRuntime('1002-static_test Static master4 down 00:00\n Routes: 3 imported, 0 exported', 'static_test'), { state: 'down', imported: 3, exported: 0 });
 assert.equal(parseStaticRuntime('1002-static_test Static master4 up 00:00', 'static_test').state, 'up');
 assert.equal(parseStaticRuntime('', 'static_test').state, 'not_configured');
});

test('Define forwarding has the same ECMP, interface, BFD, recursive and AF validation as direct routes', () => {
 const options = { defineId: 'prefixes', action: 'blackhole', routes: [] };
 for (const forwarding of [
  { type: 'via', nextHops: [hop('192.0.2.2', 'eth0', { bfd: true, weight: 2 }), hop(null, 'eth1')] },
  { type: 'recursive', recursiveVia: '192.0.2.3' },
  { type: 'via', nextHops: [hop('192.0.2.4', 'eth0', { onlink: true })], enabled: false },
 ]) {
  const linked = normalizeStaticProtocol(resource({ ...options, routeActions: { '198.51.100.0/24': forwarding } }));
  const direct = normalizeStaticProtocol(resource({ routes: [route(forwarding)] })).routes[0];
  assert.deepEqual(linked.routeActions['198.51.100.0/24'], { type: direct.type, nextHops: direct.nextHops, recursiveVia: direct.recursiveVia, enabled: direct.enabled });
 }
 for (const action of [ { type: 'via', nextHops: [] }, { type: 'via', nextHops: [hop('2001:db8::1')] }, { type: 'via', nextHops: [hop('192.0.2.2', null, { onlink: true })] }, { type: 'recursive', recursiveVia: 'bad' } ]) {
  assert.throws(() => normalizeStaticProtocol(resource({ ...options, action })));
  assert.throws(() => normalizeStaticProtocol(resource({ ...options, routeActions: { '198.51.100.0/24': action } })));
 }
 const legacy = normalizeStaticProtocol(resource({ ...options, action: 'via 192.0.2.1', routeActions: { '198.51.100.0/24': 'reject' } }));
 assert.equal(legacy.action, 'via 192.0.2.1'); assert.equal(legacy.routeActions['198.51.100.0/24'], 'reject');
});

test('Unified source adapters preserve legacy forwarding and give every route independent defaults and attributes', () => {
 const legacy = defineRoute('198.51.100.0/24', 'prefixes', 'via 192.0.2.1', { operations: [], custom: '' });
 assert.equal(legacy.type, 'via'); assert.equal(legacy.nextHops[0].address, '192.0.2.1');
 assert.equal(defineRoute('198.51.100.0/24', 'prefixes', 'reject', { operations: [], custom: '' }).type, 'unreachable');
 const action = { type: 'via', nextHops: [hop('192.0.2.2')], recursiveVia: null, enabled: false };
 const filter = { operations: [{ type: 'set', attribute: 'preference', value: 100 }], custom: 'ospf_metric1 = 10;' };
 const first = defineRoute('198.51.100.0/24', 'prefixes', action, filter), second = defineRoute('198.51.101.0/24', 'prefixes', action, filter);
 first.nextHops[0].address = '192.0.2.3'; first.filter.operations[0].value = 200;
 assert.equal(second.nextHops[0].address, '192.0.2.2'); assert.equal(action.nextHops[0].address, '192.0.2.2'); assert.equal(second.filter.operations[0].value, 100); assert.equal(filter.operations[0].value, 100);
 const forwarding = routeForwarding(first); forwarding.nextHops[0].address = '192.0.2.4';
 assert.equal(first.nextHops[0].address, '192.0.2.3'); assert.equal(forwarding.enabled, false); assert.equal(forwarding.prefix, undefined); assert.equal(forwarding.filter, undefined);
});

test('Linked Define routes render native dual-stack forwarding and attributes, skip disabled prefixes and keep empty protocols', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'birdbox-define-static-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
 const defines = ['ipv4', 'ipv6'].map((family, i) => ({ id: `prefixes${i}`, name: `prefixes${i}`, label: family, type: family === 'ipv4' ? 'cidr4' : 'cidr6', entries: family === 'ipv4' ? ['198.51.100.0/24', '198.51.101.0/24', '198.51.102.0/24'] : ['2001:db8:1::/48', '2001:db8:2::/48', '2001:db8:3::/48'] }));
 const resources = defines.map((def, i) => resource({ id: `s${i}`, name: `s${i}`, family: i === 0 ? 'ipv4' : 'ipv6', defineId: def.id, action: { type: 'blackhole' }, routes: [], routeActions: {
  [def.entries[0]]: { type: 'via', nextHops: [hop(i === 0 ? '192.0.2.2' : 'fe80::2', 'eth0', { bfd: true, weight: 2 }), hop(null, 'eth1')] },
  [def.entries[1]]: { type: 'recursive', recursiveVia: i === 0 ? '192.0.2.3' : '2001:db8::3' },
  [def.entries[2]]: { type: 'prohibit', enabled: false },
 }, routeFilters: { [def.entries[0]]: { operations: [{ type: 'set', attribute: 'preference', value: 170 }], custom: 'ospf_metric1 = 10;' } } }));
 const state = validateInventory({ nodes: [node], defines, staticProtocols: resources });
 const config = configForNode(state, state.nodes[0]);
 assert.match(config, /route 198\.51\.100\.0\/24 via 192\.0\.2\.2 dev "eth0" bfd weight 2 via "eth1"/);
 assert.match(config, /route 2001:db8:1::\/48 via fe80::2 dev "eth0" bfd weight 2 via "eth1"/);
 assert.match(config, /route 2001:db8:2::\/48 recursive 2001:db8::3;/);
 assert.match(config, /preference = 170;/); assert.doesNotMatch(config, /route (198\.51\.102\.0|2001:db8:3::)/);
 const file = path.join(root, 'bird.conf'); await fs.writeFile(file, config); await promisify(execFile)('/usr/sbin/bird', ['-p', '-c', file]);
 for (const s of state.staticProtocols) for (const action of Object.values(s.routeActions)) action.enabled = false;
 const disabled = configForNode(state, state.nodes[0]); assert.match(disabled, /protocol static s0/); assert.match(disabled, /protocol static s1/); assert.doesNotMatch(disabled, /\n  route /);
});
