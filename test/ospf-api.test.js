import test from 'node:test';
import assert from 'node:assert/strict';
import { setupResourceApi } from './helpers/resource-api.js';

const candidate = () => ({ id: 'core', name: 'Core OSPF', nodeConfigs: ['one', 'two'].map(nodeId => ({ nodeId, enabled: true, versions: ['ospfv2', 'ospfv3'] })), links: [{ id: 'pair', fromNodeId: 'one', toNodeId: 'two', localInterface: 'eth0', remoteInterface: 'eth1', cost: 10 }], layout: {} });
const accepted = p => ({ ...p.domain, mode: 'apply', inventoryRevision: p.inventoryRevision, previewId: p.previewId, candidateHash: p.candidateHash });
async function preview(h, body) { const r = await h.request('POST', '/api/ospf/preview', body); assert.equal(r.statusCode, 200, r.body); return r.json(); }

test('OSPF reviewed dual-stack lifecycle, independent endpoints, readonly drafts/preflight, member cleanup and deletion', async t => {
 const h = await setupResourceApi(t), original = await h.store.read();
 const draft = await h.request('POST', '/api/ospf', { ...candidate(), mode: 'draft' }); assert.equal(draft.statusCode, 200, draft.body);
 assert.deepEqual(await h.store.read(), original); assert.equal(h.calls.length, 0);
 assert.ok((await h.store.readOspfDrafts()).core);
 const p = await preview(h, candidate()); assert.ok(p.valid); assert.equal(p.configs.length, 2); assert.ok(p.previewId);
 assert.deepEqual(await h.store.read(), original); assert.equal(h.calls.some(c => c.method === 'bird.apply'), false);
 const created = await h.request('POST', '/api/ospf', accepted(p)); assert.equal(created.statusCode, 201, created.body);
 assert.deepEqual(await h.store.readOspfDrafts(), {});
 const changed = { ...p.domain, name: 'Renamed', links: p.domain.links.map(link => ({ ...link, endpoints: link.endpoints.map((endpoint, i) => ({ ...endpoint, options: { ...endpoint.options, priority: i ? 22 : 11 } })) })) };
 const edit = await preview(h, changed); assert.equal((await h.request('PUT', '/api/ospf/core', accepted(edit))).statusCode, 200);
 const saved = (await h.store.read()).ospfDomains[0]; assert.equal(saved.links[0].localOptions.priority, 11); assert.equal(saved.links[0].remoteOptions.priority, 22);
 for (const enabled of [false, true]) {
  const state = (await h.store.read()).ospfDomains[0];
  const next = await preview(h, { ...state, members: state.members.map(m => ({ ...m, enabled })) });
  assert.equal((await h.request('PUT', '/api/ospf/core', accepted(next))).statusCode, 200);
  assert.ok((await h.store.read()).ospfDomains[0].nodeConfigs.every(m => m.enabled === enabled));
 }
 const empty = await preview(h, { id: 'core', name: 'Empty OSPF', nodeConfigs: [], links: [] }); assert.equal(empty.configs.length, 2);
 assert.ok(empty.configs.every(c => c.diff.changed && !c.config.includes('protocol ospf')));
 h.calls.length = 0; assert.equal((await h.request('PUT', '/api/ospf/core', accepted(empty))).statusCode, 200);
 assert.equal(h.calls.filter(c => c.method === 'bird.apply').length, 2);
 assert.equal((await h.request('DELETE', '/api/ospf/core', { inventoryRevision: p.inventoryRevision })).json().code, 'STATE_CONFLICT');
 assert.equal((await h.request('DELETE', '/api/ospf/core')).statusCode, 200);
 assert.equal((await h.store.read()).ospfDomains.length, 0);
 const blank = await preview(h, { name: 'New empty domain', nodeConfigs: [], links: [] }); assert.ok(blank.valid);
 assert.equal((await h.request('POST', '/api/ospf', accepted(blank))).statusCode, 201);
});

test('OSPF rejects changed or stale candidates, restores reviewed masked credentials and redacts diff text', async t => {
 const h = await setupResourceApi(t), body = candidate();
 body.nodeConfigs.forEach(m => { m.versions = ['ospfv2']; });
 body.links[0].authentication = 'md5'; body.links[0].options = { password: 'isolated-ospf-key' };
 const p = await preview(h, body); assert.ok(p.valid); assert.doesNotMatch(JSON.stringify(p), /isolated-ospf-key/);
 assert.equal((await h.request('POST', '/api/ospf', { ...accepted(p), name: 'Tampered' })).json().code, 'OSPF_PREVIEW_STALE');
 assert.equal((await h.request('POST', '/api/ospf', { ...body, mode: 'apply' })).json().code, 'OSPF_PREVIEW_STALE');
 const applied = await h.request('POST', '/api/ospf', accepted(p)); assert.equal(applied.statusCode, 201, applied.body);
 assert.equal((await h.store.read()).ospfDomains[0].links[0].localOptions.password, 'isolated-ospf-key');
 assert.equal((await h.request('PUT', '/api/ospf/core', accepted(p))).json().code, 'STATE_CONFLICT');
});

test('OSPF full Include preflight isolates node failures and deployment rollback preserves inventory', async t => {
 const h = await setupResourceApi(t);
 await h.store.mutate(s => s.defines.push({ id: 'irr', name: 'IRR_OSPF', label: 'IRR', type: 'cidr4', nodeIds: null, enabled: true, entries: ['203.0.113.0/24'], entrySource: { kind: 'irr-as-set', asSet: 'AS-LAB', server: 'rr.example', databases: [], refreshIntervalSeconds: 900, prefixLimit: 100, allowMoreSpecific: false }, sync: { status: 'ready', contentHash: 'test', lastAttemptAt: null, lastSuccessAt: null, nextRefreshAt: null, error: null } }));
 h.failures.set('one:bird.stage', 'node offline');
 const invalid = await preview(h, candidate()); assert.equal(invalid.valid, false);
 assert.equal(invalid.configs.find(c => c.nodeId === 'one').validation.ok, false); assert.equal(invalid.configs.find(c => c.nodeId === 'two').validation.ok, true);
 assert.ok(h.calls.filter(c => c.method === 'bird.stage').every(c => c.params.resources.some(r => r.content.includes('IRR_OSPF'))));
 h.failures.clear(); const p = await preview(h, candidate()); const before = await h.store.read();
 h.failures.set('two:bird.apply', 'reload failed');
 const failed = await h.request('POST', '/api/ospf', accepted(p)); assert.equal(failed.statusCode, 500, failed.body);
 assert.deepEqual(failed.json().deployment.nodeResults.map(r => r.status), ['rolled_back', 'rolled_back']);
 assert.equal(failed.json().deployment.rollback.succeeded, true); assert.ok(failed.json().deployment.transactionId);
 assert.deepEqual(await h.store.read(), before); assert.ok(h.calls.some(c => c.method === 'bird.rollback')); assert.equal((await h.deploymentService.readJournal()).active, null);
 h.failures.clear(); assert.equal((await h.request('POST', '/api/ospf', accepted(p))).statusCode, 201);
});

test('OSPF layout persistence does not stage, lock deployments, change inventory revision or invalidate reviewed candidates', async t => {
 const h = await setupResourceApi(t);
 const p = await preview(h, candidate()), before = await h.store.read(), revision = h.store.revisionOf(before);
 h.calls.length = 0;
 // Acquiring the same deployment lock would deadlock this request.
 await h.lock(async () => {
  const r = await h.request('PATCH', '/api/ospf/layout', { layout: { one: { x: 55, y: 66 }, unknown: { x: 5, y: 6 } } });
  assert.equal(r.statusCode, 200, r.body); assert.deepEqual(r.json().layout, { one: { x: 55, y: 66, locked: false } });
 });
 assert.deepEqual(await h.store.read(), before); assert.equal(h.store.revisionOf(await h.store.read()), revision); assert.equal(h.calls.length, 0);
 const created = await h.request('POST', '/api/ospf', accepted(p)); assert.equal(created.statusCode, 201, created.body);
 const saved = await h.store.read(); h.calls.length = 0;
 await h.lock(async () => { assert.equal((await h.request('PATCH', '/api/ospf/core/layout', { layout: { two: { x: 77, y: 88 } } })).statusCode, 200); });
 assert.deepEqual(await h.store.read(), saved); assert.equal(h.calls.length, 0);
 const listed = (await h.request('GET', '/api/ospf')).json(); assert.equal(listed.domains[0].layout.two.x, 77); assert.equal(listed.layout.one.x, 55);
});

test('OSPF rechecks revision under the deployment lock instead of overwriting an intervening update', async t => {
 const h = await setupResourceApi(t), p = await preview(h, candidate());
 let saved;
 // Delay the lock boundary while an independent inventory writer commits.
 const pending = h.lock(async () => {
  saved = h.request('POST', '/api/ospf', accepted(p));
  await new Promise(resolve => setImmediate(resolve));
  await h.store.mutate(s => { s.nodes[0].name = 'Changed elsewhere'; });
 });
 await pending;
 const result = await saved; assert.equal(result.json().code, 'STATE_CONFLICT', result.body);
 assert.equal((await h.store.read()).ospfDomains.length, 0); assert.equal(h.calls.some(c => c.method === 'bird.apply'), false);
});

test('OSPF saved-only drafts can be resumed, applied or deleted without changing active inventory', async t => {
 const h = await setupResourceApi(t), initial = await h.store.read();
 const response = await h.request('POST', '/api/ospf', { ...candidate(), mode: 'draft' }); assert.equal(response.statusCode, 200);
 const listed = (await h.request('GET', '/api/ospf')).json(); assert.ok(listed.drafts.core); assert.equal(listed.domains[0].id, 'core');
 assert.deepEqual(await h.store.read(), initial);
 assert.equal((await h.request('DELETE', '/api/ospf/core', { inventoryRevision: listed.inventoryRevision })).statusCode, 200);
 assert.deepEqual(await h.store.readOspfDrafts(), {}); assert.equal(h.calls.length, 0); assert.deepEqual(await h.store.read(), initial);
});

test('OSPF saved draft credentials survive masked reload and bind to the reviewed candidate', async t => {
 const h = await setupResourceApi(t), body = candidate();
 body.nodeConfigs.forEach(m => { m.versions = ['ospfv2']; });
 body.links[0].authentication = 'md5'; body.links[0].options = { password: 'saved-draft-secret' };
 assert.equal((await h.request('POST', '/api/ospf', { ...body, mode: 'draft' })).statusCode, 200);
 const listed = (await h.request('GET', '/api/ospf')).json(); assert.doesNotMatch(JSON.stringify(listed), /saved-draft-secret/);
 const p = await preview(h, { ...listed.drafts.core.domain, inventoryRevision: listed.inventoryRevision });
 const applied = await h.request('POST', '/api/ospf', accepted(p)); assert.equal(applied.statusCode, 201, applied.body);
 assert.equal((await h.store.read()).ospfDomains[0].links[0].localOptions.password, 'saved-draft-secret');
});

test('OSPF failed preflight reports the failed node and unattempted nodes; failed rollback retains unknown result and journal', async t => {
 const h = await setupResourceApi(t), p = await preview(h, candidate());
 h.failures.set('one:bird.stage', 'offline now');
 let failed = await h.request('POST', '/api/ospf', accepted(p)); assert.equal(failed.statusCode, 422);
 assert.deepEqual(failed.json().deployment.nodeResults.map(r => r.status), ['failed', 'not_attempted']);
 assert.equal(failed.json().deployment.rollback.attempted, false);
 h.failures.clear(); h.failures.set('two:bird.apply', 'reload failed'); h.failures.set('one:bird.rollback', 'connection lost');
 failed = await h.request('POST', '/api/ospf', accepted(p)); assert.equal(failed.statusCode, 500);
 assert.deepEqual(failed.json().deployment.nodeResults.map(r => r.status), ['unknown', 'rolled_back']);
 assert.equal(failed.json().deployment.rollback.succeeded, false); assert.ok((await h.deploymentService.readJournal()).active);
});
