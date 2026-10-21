import test from 'node:test';
import assert from 'node:assert/strict';
import { setupResourceApi } from './helpers/resource-api.js';
import { sourcePolicyManagedRules, sourcePolicyNames } from '../src/bird-source-policy.js';

const input = (extra = {}) => ({ label: '业务源地址出口', nodeIds: ['one', 'two'], groups: [{ egressAddress: '192.0.2.100', sources: ['198.18.100.8/24'] }], copyInternalRoutes: false, internalDefineIds: [], enabled: true, ...extra });
const accepted = p => ({ ...p.resource, mode: 'apply', inventoryRevision: p.inventoryRevision, previewId: p.previewId, candidateHash: p.candidateHash });
async function preview(h, body) { const response = await h.request('POST', '/api/source-policies/preview', body); assert.equal(response.statusCode, 200, response.body); return response.json(); }

test('source policy readonly runtime separates native rules/routes from configuration and isolates a failed node; route selectors come from saved groups', async t => {
 const h = await setupResourceApi(t), p = await preview(h, input());
 assert.equal((await h.request('POST', '/api/source-policies', accepted(p))).statusCode, 201);
 const resource = p.resource, group = resource.groups[0], names = sourcePolicyNames(resource, group), rules = sourcePolicyManagedRules([resource]);
 const snapshot = { rules: rules.map(({ priority, source, destination, table }) => ({ priority, ...(source ? { source } : {}), ...(destination ? { destination } : {}), table })), rawRules: [], persistence: { state: 'ready', error: null }, tables: [{ table: group.kernelTable, routes: [{ dst: 'default', gateway: group.egressAddress, dev: 'lab0' }], truncated: false, error: null }] };
 h.outputs.set('one:network.ip_rules.inspect', JSON.stringify(snapshot));
 h.failures.set('two:network.ip_rules.inspect', 'node offline'); h.failures.set('two:bird.protocol', 'node offline');
 h.outputs.set('one:bird.protocol', `1002-${names.staticProtocol} Static ${names.table} up 00:00\n1002-${names.kernelProtocol} Kernel ${names.table} up 00:00`);
 h.calls.length = 0; const before = await h.store.read();
 const result = await h.request('GET', `/api/source-policies/${resource.id}/runtime`); assert.equal(result.statusCode, 200, result.body);
 const [one, two] = result.json().nodes;
 assert.equal(one.rules.installed, 2); assert.equal(one.rules.persistence, 'ready'); assert.deepEqual(one.rules.missing, []);
 assert.equal(one.groups[0].kernelRoutes[0].gateway, group.egressAddress); assert.equal(one.groups[0].protocols[0].state, 'up');
 assert.equal(two.rules.installed, null); assert.match(two.rules.error, /offline/); assert.ok(two.groups[0].protocols.every(protocol => protocol.state === 'error'));
 assert.ok(h.calls.every(call => ['network.ip_rules.inspect', 'bird.protocol'].includes(call.method))); assert.deepEqual(await h.store.read(), before);
 const inspection = h.calls.find(call => call.method === 'network.ip_rules.inspect'); assert.deepEqual(inspection.params.tables, [group.kernelTable]);
 const route = await h.request('GET', `/api/source-policies/${resource.id}/routes?nodeId=one&groupId=${group.id}&target=198.51.100.1`);
 assert.equal(route.statusCode, 200, route.body); const query = h.calls.findLast(call => call.method === 'bird.routes'); assert.equal(query.params.table, names.table); assert.equal(query.params.protocolName, undefined); assert.equal(query.params.target, '198.51.100.1');
 assert.equal((await h.request('GET', `/api/source-policies/${resource.id}/routes?nodeId=one&groupId=other`)).statusCode, 400);
 assert.equal((await h.request('GET', `/api/source-policies/${resource.id}/routes?nodeId=one&groupId=${group.id}&target=1.1.1.1%3Bwhoami`)).statusCode, 400);
 snapshot.rules.pop(); snapshot.persistence.state = 'pending'; h.outputs.set('one:network.ip_rules.inspect', JSON.stringify(snapshot));
 const missing = (await h.request('GET', `/api/source-policies/${resource.id}/runtime`)).json().nodes[0]; assert.equal(missing.rules.installed, 1); assert.equal(missing.rules.missing.length, 1); assert.equal(missing.rules.persistence, 'pending');
 h.outputs.set('one:network.ip_rules.inspect', '{"rules":[],"tables":[null]}');
 const malformed = await h.request('GET', `/api/source-policies/${resource.id}/runtime`); assert.equal(malformed.statusCode, 200); assert.equal(malformed.json().nodes[0].rules.installed, null); assert.match(malformed.json().nodes[0].rules.error, /不完整/);
});

test('disabled source mappings allow a shared gateway exception without reporting false stale rules; local gateway groups are skipped', async t => {
 const h = await setupResourceApi(t), first = await preview(h, input({ nodeIds: ['one'] }));
 await h.request('POST', '/api/source-policies', accepted(first));
 const second = await preview(h, input({ nodeIds: ['one'], groups: [{ egressAddress: '192.0.2.100', sources: ['198.18.101.0/24'] }] }));
 await h.request('POST', '/api/source-policies', accepted(second));
 const disabled = await preview(h, { ...first.resource, enabled: false }); await h.request('PUT', `/api/source-policies/${first.resource.id}`, accepted(disabled));
 const gateway = sourcePolicyManagedRules([second.resource]).find(r => r.kind === 'gateway');
 const base = { rules: [{ priority: gateway.priority, destination: gateway.destination, table: gateway.table }], rawRules: [], persistence: { state: 'ready', error: null }, tables: [{ table: first.resource.groups[0].kernelTable, routes: [], error: null, truncated: false }] };
 h.outputs.set('one:network.ip_rules.inspect', JSON.stringify(base));
 const result = (await h.request('GET', `/api/source-policies/${first.resource.id}/runtime`)).json().nodes[0];
 assert.equal(result.rules.expected, 0); assert.deepEqual(result.rules.unexpected, []); assert.ok(result.groups[0].protocols.every(p => p.state === 'disabled'));
 await h.store.mutate(s => { s.nodes[0].igpAddress = '192.0.2.100'; });
 const skipped = (await h.request('GET', `/api/source-policies/${second.resource.id}/runtime`)).json().nodes[0]; assert.equal(skipped.groups[0].skipped, true); assert.deepEqual(skipped.groups[0].protocols, []);
});

test('source policy plan is local-only; full preflight freezes IDs/tables/priorities through create, scope move, disable/enable and deletion', async t => {
 const h = await setupResourceApi(t), before = await h.store.read();
 const context = (await h.request('GET', '/api/source-policies/editor-context')).json(); assert.equal(context.resource, null);
 const sketch = await preview(h, { ...input(), mode: 'plan', inventoryRevision: context.inventoryRevision });
 assert.equal(sketch.valid, undefined); assert.equal(sketch.previewId, undefined); assert.equal(h.calls.length, 0); assert.deepEqual(await h.store.read(), before);
 const p = await preview(h, { ...input(), inventoryRevision: context.inventoryRevision });
 assert.ok(p.valid); assert.equal(p.configs.length, 2); assert.deepEqual(p.resource.groups[0].sources, ['198.18.100.0/24']); assert.notEqual(p.resource.id, 'source_policy_preview');
 assert.equal(h.calls.some(c => ['bird.apply', 'network.ip_rules'].includes(c.method)), false); assert.deepEqual(await h.store.read(), before);
 assert.equal((await h.request('POST', '/api/source-policies', { ...accepted(p), groups: [{ ...p.resource.groups[0], kernelTable: 50001 }] })).json().code, 'SOURCE_POLICY_PREVIEW_STALE');
 const saved = await h.request('POST', '/api/source-policies', accepted(p)); assert.equal(saved.statusCode, 201, saved.body); const resource = saved.json().resource;
 assert.deepEqual(resource, p.resource); assert.equal(h.calls.filter(c => c.method === 'bird.stage').at(-1).params.config, p.configs[0].config);
 const rules = h.calls.filter(c => c.method === 'network.ip_rules'); assert.equal(rules.length, 2); assert.ok(rules.every(c => c.params.rules.some(r => r.table === resource.groups[0].kernelTable && r.source === '198.18.100.0/24')));
 const id = resource.id, url = `/api/source-policies/${id}`;
 const moved = await preview(h, { ...resource, nodeIds: ['two'] }); assert.deepEqual(moved.configs.map(c => c.nodeId), ['one', 'two']);
 h.calls.length = 0; assert.equal((await h.request('PUT', url, accepted(moved))).statusCode, 200);
 const removed = h.calls.find(c => c.nodeId === 'one' && c.method === 'network.ip_rules'); assert.deepEqual(removed.params.rules, []); assert.ok(removed.params.removeRules.length);
 for (const enabled of [false, true]) {
  const changed = await preview(h, { ...moved.resource, enabled }); assert.ok(changed.valid); h.calls.length = 0;
  assert.equal((await h.request('PUT', url, accepted(changed))).statusCode, 200);
  const applied = h.calls.find(c => c.nodeId === 'two' && c.method === 'network.ip_rules'); assert.equal(applied.params.rules.length > 0, enabled);
  assert.deepEqual((await h.store.read()).sourcePolicies[0].groups, moved.resource.groups);
 }
 assert.equal((await h.request('DELETE', url, { inventoryRevision: context.inventoryRevision })).json().code, 'STATE_CONFLICT');
 const latest = (await h.request('GET', `/api/source-policies/editor-context?id=${id}`)).json();
 const deleted = await h.request('DELETE', url, { inventoryRevision: latest.inventoryRevision }); assert.equal(deleted.statusCode, 200, deleted.body);
 assert.equal((await h.store.read()).sourcePolicies.length, 0); assert.ok(deleted.json().manualPlans[0].removeManagedRules.length);
 assert.equal((await h.request('GET', `/api/source-policies/editor-context?id=${id}`)).json().resource, null);
});

test('source policy CAS, candidate expiry/missing proof and cross-resource IDs cannot apply a different reviewed plan', async t => {
 const h = await setupResourceApi(t), p = await preview(h, input());
 assert.equal((await h.request('POST', '/api/source-policies', { ...input(), mode: 'apply' })).json().code, 'SOURCE_POLICY_PREVIEW_STALE');
 assert.equal((await h.request('POST', '/api/source-policies', { ...accepted(p), candidateHash: 'wrong' })).json().code, 'SOURCE_POLICY_PREVIEW_STALE');
 await h.store.mutate(s => { s.nodes[0].name = 'changed elsewhere'; }); h.calls.length = 0;
 assert.equal((await h.request('POST', '/api/source-policies', accepted(p))).json().code, 'STATE_CONFLICT'); assert.equal(h.calls.length, 0);
 const revision = (await h.request('GET', '/api/source-policies/editor-context')).json().inventoryRevision;
 const refreshed = await preview(h, { ...input(), inventoryRevision: revision }); assert.equal((await h.request('POST', '/api/source-policies', accepted(refreshed))).statusCode, 201);
 const second = await preview(h, input({ groups: [{ egressAddress: '192.0.2.101', sources: ['198.18.101.0/24'] }] }));
 assert.equal((await h.request('PUT', `/api/source-policies/${refreshed.resource.id}`, accepted(second))).json().code, 'SOURCE_POLICY_PREVIEW_STALE');
});

test('source policy full bundles isolate node preflight failure; Agent rule failure rolls back BIRD, rules, inventory and lock', async t => {
 const h = await setupResourceApi(t);
 await h.store.mutate(s => s.defines.push({ id: 'irr', name: 'INTERNAL_IRR4', label: 'Internal IRR', type: 'cidr4', nodeIds: null, enabled: true, entries: ['203.0.113.0/24'], entrySource: { kind: 'irr-as-set', asSet: 'AS-LAB', server: 'rr.example', databases: [], refreshIntervalSeconds: 900, prefixLimit: 100, allowMoreSpecific: false }, sync: { status: 'ready', contentHash: 'test', lastAttemptAt: null, lastSuccessAt: null, nextRefreshAt: null, error: null } }));
 const body = input({ copyInternalRoutes: true, internalDefineIds: ['irr'] }), before = await h.store.read();
 h.failures.set('one:bird.stage', 'node timeout'); const bad = await preview(h, body); assert.equal(bad.valid, false); assert.equal(bad.configs.find(c => c.nodeId === 'two').validation.ok, true);
 assert.ok(h.calls.filter(c => c.method === 'bird.stage').every(c => c.params.resources.some(r => r.content.includes('INTERNAL_IRR4'))));
 assert.equal((await h.request('POST', '/api/source-policies', accepted(bad))).json().code, 'SOURCE_POLICY_PREVIEW_STALE'); assert.deepEqual(await h.store.read(), before);
 h.failures.clear(); const good = await preview(h, body);
 let failures = 0; h.failures.set('two:network.ip_rules', () => failures++ === 0 ? 'rule installation failed' : null);
 const failed = await h.request('POST', '/api/source-policies', accepted(good)); assert.equal(failed.statusCode, 502, failed.body);
 assert.deepEqual(await h.store.read(), before); assert.ok(h.calls.some(c => c.method === 'bird.rollback')); assert.ok(h.calls.some(c => c.method === 'network.ip_rules' && !c.params.rules.length && c.params.removeRules.length));
 assert.equal((await h.deploymentService.readJournal()).active, null);
 h.failures.clear(); assert.equal((await h.request('POST', '/api/source-policies', accepted(good))).statusCode, 201);
});

test('source policy interrupted journal recovers system rules without request-scoped hooks and retains journal on rule failure', async t => {
 const h = await setupResourceApi(t);
 const created = await h.request('POST', '/api/source-policies', input()); assert.equal(created.statusCode, 201, created.body);
 const before = await h.store.read(), after = structuredClone(before);
 after.sourcePolicies[0].groups[0].sources = ['198.18.101.0/24'];
 const journal = await h.deploymentService.beginJournal(before, after, ['one', 'two']);
 h.calls.length = 0; h.failures.set('two:network.ip_rules', 'Agent offline');
 await assert.rejects(() => h.deploymentService.recover(), /Agent offline/);
 assert.equal((await h.deploymentService.readJournal()).active.id, journal.id); assert.deepEqual(await h.store.read(), before);
 h.failures.clear(); await h.deploymentService.recover();
 assert.deepEqual((await h.store.read()).sourcePolicies[0].groups[0].sources, ['198.18.101.0/24']);
 assert.equal((await h.deploymentService.readJournal()).active, null);
 const rules = h.calls.filter(c => c.method === 'network.ip_rules');
 assert.ok(rules.some(c => c.params.removeRules.some(r => r.source === '198.18.100.0/24') && c.params.rules.some(r => r.source === '198.18.101.0/24')));
 const rollback = await h.deploymentService.beginJournal(after, before, ['one', 'two']); await h.deploymentService.setJournalDirection(rollback, 'rollback');
 await h.deploymentService.recover(); assert.equal((await h.deploymentService.readJournal()).active, null);
});
