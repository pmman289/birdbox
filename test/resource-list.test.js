import test from 'node:test';
import assert from 'node:assert/strict';
import { activeResourceFilters, defaultResourceQuery, filterResourceItems, GLOBAL_SCOPE, nodeConnectionStatus, paginateResourceItems, resourceListItems, resourcePageButtons } from '../apps/web/src/shared/resource-list.ts';

function inventory() {
 return {
  nodes: [{ id: 'a', name: '核心路由器', transport: 'agent', routerId: '192.0.2.1' }, { id: 'b', name: '边缘路由器', transport: 'ssh', sshHost: '192.0.2.22' }],
  peers: [{ id: 'peer', name: 'Upstream', nodeId: 'a', address: '2001:db8::1', asn: 64512 }, { id: 'internal', name: 'Managed', nodeId: 'a', address: '192.0.2.2', managedBy: { kind: 'ibgp-domain' } }],
  defines: [{ id: 'global', name: 'GLOBAL_PREFIXES', label: '全局前缀', nodeIds: null, type: 'cidr4', entries: ['203.0.113.0/24'], enabled: true }, { id: 'scoped', name: 'SCOPED', nodeIds: ['b'], type: 'cidr6', entries: ['2001:db8::/48'], enabled: false }],
  staticProtocols: [{ id: 's', name: 'static_1', label: '业务路由 10', nodeId: 'a', family: 'ipv4', enabled: true, table: { name: 'business4' }, routeActions: {}, routes: [{ prefix: '198.51.100.0/24', nextHops: [{ address: '192.0.2.3', interface: 'eth0' }] }] }, { id: 's2', name: 'static_2', label: '业务路由 2', nodeId: 'b', family: 'ipv6', enabled: false, defineId: 'scoped', routeActions: { '2001:db8::/48': 'blackhole' }, routes: [] }],
  directProtocols: [{ id: 'd', nodeId: 'a', name: 'direct', ipv4: true, ipv6: true, interfaces: ['eth*'], enabled: true }],
  kernelProtocols: [{ id: 'k', nodeIds: null, name: 'kernel', ipv4: true, ipv6: false, table: 100, enabled: true }],
  pipeProtocols: [{ id: 'p', nodeIds: ['b'], name: 'exchange', family: 'ipv6', table: { name: 'business6' }, peerTable: { name: 'master6' }, enabled: true }],
  functions: [{ id: 'fn', name: 'helper', nodeIds: null, callable: false, enabled: true }],
  filters: [{ id: 'filter', name: 'allow', nodeIds: ['a'], enabled: false }],
  rpki: [{ id: 'roa', name: 'roa', nodeIds: null, sourceType: 'server', remote: 'rpki.example:3323', roa4Table: 'roa4', roa6Table: 'roa6', enabled: true }],
  sourcePolicies: [{ id: 'egress', label: '出口映射', nodeIds: ['a'], enabled: true, groups: [{ egressAddress: '192.0.2.8', sources: ['10.0.0.0/8'] }] }],
 };
}
const query = changes => ({ ...defaultResourceQuery(), ...changes });
test('resource list builds every inventory collection, excludes managed peers and searches relevant fields', () => {
 const inv = inventory();
 const cases = { nodes: '192.0.2.22', peers: 'AS64512', defines: '203.0.113', statics: 'business4', directs: 'eth*', kernels: '100', pipes: 'business6', functions: 'helper', filters: 'allow', rpki: 'rpki.example', sourcePolicies: '10.0.0.0/8' };
 for (const [kind, keyword] of Object.entries(cases)) assert.equal(filterResourceItems(resourceListItems(inv, kind), query({ keyword })).length, 1, kind);
 assert.equal(resourceListItems(inv, 'peers').length, 1);
 assert.equal(filterResourceItems(resourceListItems(inv, 'statics'), query({ keyword: 'STATIC_1 核心路由器 198.51.100' })).length, 1);
 assert.equal(filterResourceItems(resourceListItems(inv, 'statics'), query({ keyword: 'static_1 不存在' })).length, 0);
});
test('resource filters combine scope, enabled state, type and AF without excluding global resources', () => {
 const inv = inventory(), items = resourceListItems(inv, 'defines');
 assert.deepEqual(filterResourceItems(items, query({ nodeId: 'a' })).map(i => i.id), ['global']);
 assert.deepEqual(filterResourceItems(items, query({ nodeId: 'b' })).map(i => i.id), ['global', 'scoped']);
 assert.deepEqual(filterResourceItems(items, query({ nodeId: GLOBAL_SCOPE })).map(i => i.id), ['global']);
 assert.deepEqual(filterResourceItems(items, query({ nodeId: 'b', family: 'ipv6', status: 'disabled', type: 'cidr6' })).map(i => i.id), ['scoped']);
 assert.equal(filterResourceItems(resourceListItems(inv, 'directs'), query({ family: 'dual' })).length, 1);
 assert.equal(filterResourceItems(resourceListItems(inv, 'kernels'), query({ family: 'dual' })).length, 0);
 assert.equal(filterResourceItems(resourceListItems(inv, 'functions'), query({ type: 'source', status: 'enabled' })).length, 1);
 assert.equal(activeResourceFilters(query({ keyword: '  ', sort: 'name-asc' })), 0);
 assert.equal(activeResourceFilters(query({ keyword: '业务', nodeId: 'a', status: 'enabled', family: 'ipv4', type: 'manual' })), 5);
});
test('node filtering uses actual reachability, including unknown checks', () => {
 const items = resourceListItems(inventory(), 'nodes', [{ nodeId: 'a', reachable: true }, { nodeId: 'b', reachable: false }]);
 assert.deepEqual(filterResourceItems(items, query({ status: 'online', type: 'agent' })).map(i => i.id), ['a']);
 assert.deepEqual(filterResourceItems(items, query({ status: 'offline' })).map(i => i.id), ['b']);
 assert.equal(nodeConnectionStatus(undefined), 'unknown');
 assert.equal(filterResourceItems(resourceListItems(inventory(), 'nodes'), query({ status: 'unknown' })).length, 2);
});
test('view sorting uses natural names and preserves global declaration positions and source arrays', () => {
 const inv = inventory(), before = structuredClone(inv), items = resourceListItems(inv, 'statics');
 assert.deepEqual(filterResourceItems(items, query({ sort: 'name-asc' })).map(i => i.id), ['s2', 's']);
 assert.deepEqual(filterResourceItems(items, query({ sort: 'name-desc' })).map(i => i.id), ['s', 's2']);
 assert.deepEqual(filterResourceItems(items, query()).map(i => i.position), [1, 2]);
 assert.deepEqual(inv, before);
});
test('pagination covers boundaries, deletion clamping, empty results, invalid sizes and accessible page windows', () => {
 const items = Array.from({ length: 43 }, (_, i) => ({ id: String(i) }));
 const last = paginateResourceItems(items, 3, 20); assert.equal(last.start, 41); assert.equal(last.end, 43); assert.equal(last.items.length, 3);
 const deleted = paginateResourceItems(items.slice(0, 40), 3, 20); assert.equal(deleted.page, 2); assert.equal(deleted.start, 21);
 assert.deepEqual(paginateResourceItems([], 99, 10), { page: 1, pageSize: 10, pageCount: 1, total: 0, start: 0, end: 0, items: [] });
 assert.equal(paginateResourceItems(items, -1, 999).pageSize, 20);
 assert.equal(paginateResourceItems(items, NaN, 20).page, 1);
 assert.deepEqual(resourcePageButtons(1, 1), [1]);
 assert.deepEqual(resourcePageButtons(1, 5), [1, 2, 3, 4, 5]);
 assert.deepEqual(resourcePageButtons(1, 10), [1, 2, 3, 4, 5, 'gap-10', 10]);
 const buttons = resourcePageButtons(50, 100); assert.deepEqual(buttons.filter(i => typeof i === 'number'), [1, 49, 50, 51, 100]);
});
