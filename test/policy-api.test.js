import test from 'node:test';
import assert from 'node:assert/strict';
import { setupResourceApi } from './helpers/resource-api.js';
import { policyResourceReferences } from '../packages/contracts/src/define-references.js';
const body = kind => ({ label: `API ${kind}`, name: kind === 'functions' ? 'api_tag' : 'api_accept', nodeIds: ['one', 'two'], enabled: true, source: kind === 'functions' ? 'function api_tag() { bgp_local_pref = 150; }' : 'filter api_accept { accept; }' });
const accepted = p => ({ ...p.resource, mode: 'apply', inventoryRevision: p.inventoryRevision, previewId: p.previewId, candidateHash: p.candidateHash });
async function preview(h, kind, input) { const r = await h.request('POST', `/api/${kind}/preview`, input); assert.equal(r.statusCode, 200, r.body); return r.json(); }
for (const kind of ['functions', 'filters']) test(`${kind}: HTTP readonly preflight → bound apply → scope edit → disable/enable → delete, and stale tokens/CAS`, async t => {
 const h = await setupResourceApi(t); const context = (await h.request('GET', `/api/${kind}/editor-context`)).json(); assert.equal(context.resource, null); assert.equal(typeof context.inventoryRevision, 'number');
 const before = await h.store.read(); h.calls.length = 0;
 const p = await preview(h, kind, { ...body(kind), inventoryRevision: context.inventoryRevision }); assert.ok(p.valid); assert.equal(p.configs.length, 2); assert.match(p.configs[0].diff, kind === 'functions' ? /function api_tag/ : /filter api_accept/);
 assert.deepEqual(await h.store.read(), before); assert.equal(h.calls.some(c => c.method === 'bird.apply'), false);
 assert.equal((await h.request('POST', `/api/${kind}`, { ...accepted(p), label: 'tampered' })).json().code, 'POLICY_PREVIEW_STALE');
 assert.equal((await h.request('POST', `/api/${kind}`, { ...body(kind), mode: 'apply' })).json().code, 'POLICY_PREVIEW_STALE');
 const other = kind === 'functions' ? 'filters' : 'functions'; assert.equal((await h.request('POST', `/api/${other}`, { ...body(other), ...accepted(p) })).json().code, 'POLICY_PREVIEW_STALE');
 const created = await h.request('POST', `/api/${kind}`, accepted(p)); assert.equal(created.statusCode, 201, created.body); assert.equal(created.json().resource.id, p.resource.id);
 assert.equal(h.calls.filter(c => c.method === 'bird.stage' && c.nodeId === 'one').at(-1).params.config, p.configs.find(c => c.nodeId === 'one').config);
 const id = p.resource.id, url = `/api/${kind}/${id}`;
 assert.equal((await h.request('PUT', url, accepted(p))).json().code, 'STATE_CONFLICT');
 const loaded = (await h.request('GET', `/api/${kind}/editor-context?id=${id}`)).json(); assert.equal(loaded.resource.name, p.resource.name);
 const changed = await preview(h, kind, { ...p.resource, nodeIds: ['two'], inventoryRevision: loaded.inventoryRevision }); assert.equal(changed.configs.length, 2); assert.match(changed.configs.find(c => c.nodeId === 'one').diff, /^---/);
 h.calls.length = 0; assert.equal((await h.request('PUT', url, accepted(changed))).statusCode, 200); assert.ok(h.calls.some(c => c.method === 'bird.apply' && c.nodeId === 'one'));
 for (const enabled of [false, true]) { const stopped = await preview(h, kind, { ...changed.resource, enabled }); assert.ok(stopped.valid); assert.equal((await h.request('PUT', url, accepted(stopped))).statusCode, 200); assert.equal((await h.store.read())[kind][0].enabled, enabled); }
 assert.equal((await h.request('DELETE', url, { inventoryRevision: context.inventoryRevision })).json().code, 'STATE_CONFLICT');
 assert.equal((await h.request('DELETE', url)).statusCode, 200); assert.equal((await h.store.read())[kind].length, 0);
 const deleted = (await h.request('GET', `/api/${kind}/editor-context?id=${id}`)).json(); assert.equal(deleted.resource, null);
});
test('policy preflight includes IRR bundles, isolates failed nodes, rejects invalid reviewed candidates and rolls back failures', async t => {
 const h = await setupResourceApi(t);
 await h.store.mutate(s => s.defines.push({ id: 'irr', name: 'IRR_V4', label: 'IRR', type: 'cidr4', nodeIds: null, enabled: true, entries: ['203.0.113.0/24'], entrySource: { kind: 'irr-as-set', asSet: 'AS-LAB', server: 'rr.example', databases: [], refreshIntervalSeconds: 900, prefixLimit: 100, allowMoreSpecific: false }, sync: { status: 'ready', contentHash: 'test', lastAttemptAt: null, lastSuccessAt: null, nextRefreshAt: null, error: null } }));
 h.failures.set('one:bird.stage', 'node timed out'); const invalid = await preview(h, 'functions', body('functions')); assert.equal(invalid.valid, false); assert.equal(invalid.configs.find(c => c.nodeId === 'two').validation.ok, true); assert.equal((await h.request('POST', '/api/functions', accepted(invalid))).json().code, 'POLICY_PREVIEW_STALE');
 assert.ok(h.calls.filter(c => c.method === 'bird.stage').every(c => c.params.resources.some(r => r.content.includes('IRR_V4'))));
 h.failures.clear(); const p = await preview(h, 'functions', body('functions')); const before = await h.store.read();
 h.failures.set('two:bird.stage', 'syntax rejected'); assert.equal((await h.request('POST', '/api/functions', accepted(p))).statusCode, 422); assert.deepEqual(await h.store.read(), before);
 h.failures.clear(); h.failures.set('two:bird.apply', 'reload failed'); assert.equal((await h.request('POST', '/api/functions', accepted(p))).statusCode, 500); assert.ok(h.calls.some(c => c.method === 'bird.rollback')); assert.deepEqual(await h.store.read(), before);
 h.failures.clear(); assert.equal((await h.request('POST', '/api/functions', accepted(p))).statusCode, 201);
});
test('policy references track direct Function/Filter consumers and indirect dependencies; native dependency protections survive edits', async t => {
 const h = await setupResourceApi(t);
 const fn = (await h.request('POST', '/api/functions', body('functions'))).json().resource;
 const filter = (await h.request('POST', '/api/filters', { label: 'Composed', name: 'api_composed', nodeIds: ['one', 'two'], source: 'filter api_composed { api_tag(); accept; }' })).json().resource;
 const pipe = (await h.request('POST', '/api/pipes', { name: 'api_pipe', label: 'Dependent pipe', nodeIds: ['one'], family: 'ipv4', table: { name: 'master4', source: 'existing' }, peerTable: { name: 'POLICY_PEER4', source: 'managed' }, importPolicy: { mode: 'custom', filterId: filter.id } })).json().resource; assert.ok(pipe);
 const refs = (await h.request('GET', `/api/functions/editor-context?id=${fn.id}`)).json().references; assert.ok(refs.some(r => r.kind === 'filters' && r.id === filter.id)); assert.ok(refs.some(r => r.kind === 'pipes' && r.id === pipe.id && r.via.length));
 assert.ok(policyResourceReferences(await h.store.read(), filter, 'filters').some(r => r.kind === 'pipes' && r.id === pipe.id));
 assert.equal((await h.request('PUT', `/api/functions/${fn.id}`, { name: 'renamed', source: 'function renamed() { bgp_local_pref = 150; }' })).statusCode, 409);
 assert.equal((await h.request('PUT', `/api/functions/${fn.id}`, { enabled: false })).statusCode, 400);
 assert.equal((await h.request('PUT', `/api/functions/${fn.id}`, { nodeIds: ['two'] })).statusCode, 400);
 assert.equal((await h.request('DELETE', `/api/functions/${fn.id}`)).statusCode, 409); assert.equal((await h.request('DELETE', `/api/filters/${filter.id}`)).statusCode, 409);
 assert.equal((await h.request('DELETE', `/api/pipes/${pipe.id}`)).statusCode, 200); assert.equal((await h.request('DELETE', `/api/filters/${filter.id}`)).statusCode, 200); assert.equal((await h.request('DELETE', `/api/functions/${fn.id}`)).statusCode, 200);
});
