import test from 'node:test';
import assert from 'node:assert/strict';
import { setupResourceApi } from './helpers/resource-api.js';

async function setup(t) {
 const h = await setupResourceApi(t);
 const peer = (await h.service.createPeer('one', { name: 'Lab peer', address: '192.0.2.2', asn: 64513 })).payload.peer;
 return { ...h, peer };
}
const candidate = peer => ({ nodeId: 'one', peerId: peer.id, protocolName: 'api_ebgp', localAddress: '192.0.2.1', localAsn: 64512, localPort: 179 });
const accepted = p => ({ ...p.session, mode: 'apply', inventoryRevision: p.inventoryRevision, previewId: p.previewId, candidateHash: p.candidateHash });
test('eBGP real HTTP readonly preview → reviewed apply → independent dual channels → stop → delete', async t => {
 const h = await setup(t), before = await h.store.read(); h.calls.length = 0;
 assert.equal((await h.app.inject({ method: 'GET', url: `/api/sessions/editor-context?nodeId=one&peerId=${h.peer.id}` })).statusCode, 401);
 const context = (await h.request('GET', `/api/sessions/editor-context?nodeId=one&peerId=${h.peer.id}`)).json();
 assert.equal(context.session, null); assert.equal(typeof context.inventoryRevision, 'number');
 const response = await h.request('POST', '/api/sessions/preview', { ...candidate(h.peer), inventoryRevision: context.inventoryRevision });
 assert.equal(response.statusCode, 200, response.body); const p = response.json();
 assert.ok(p.valid); assert.match(p.diff, /\+ protocol bgp api_ebgp/); assert.equal(p.sessionConfig.includes('protocol bgp api_ebgp'), true);
 assert.deepEqual(await h.store.read(), before); assert.equal(h.calls.some(c => c.method === 'bird.apply'), false);
 const applied = await h.request('POST', '/api/sessions/apply', accepted(p));
 assert.equal(applied.statusCode, 202, applied.body);
 assert.equal(applied.json().session.id, p.session.id); assert.equal(applied.json().config, p.config);
 assert.equal(h.calls.filter(c => c.method === 'bird.stage').at(-1).params.config, p.config);
 const saved = applied.json().session;
 saved.channels.ipv4.importPolicy.formAction = 'none'; saved.channels.ipv6.exportPolicy.formAction = 'all';
 const edited = (await h.request('POST', '/api/sessions/preview', saved)).json(); assert.ok(edited.valid);
 assert.equal((await h.request('POST', '/api/sessions/apply', accepted(edited))).statusCode, 202);
 const stored = (await h.store.read()).sessions[0]; assert.equal(stored.channels.ipv4.importPolicy.formAction, 'none'); assert.equal(stored.channels.ipv6.exportPolicy.formAction, 'all');
 const stopped = (await h.request('POST', '/api/sessions/preview', { ...stored, enabled: false })).json();
 assert.equal((await h.request('POST', '/api/sessions/apply', accepted(stopped))).statusCode, 200);
 const current = await h.store.read();
 assert.equal((await h.request('DELETE', `/api/sessions/${saved.id}`, { inventoryRevision: context.inventoryRevision })).statusCode, 409);
 assert.equal((await h.request('DELETE', `/api/sessions/${saved.id}`, { inventoryRevision: h.store.revisionOf(current) })).statusCode, 200);
 assert.equal((await h.store.read()).sessions.length, 0);
});
test('eBGP rejects stale/tampered/absent reviewed tokens and restores newly typed redacted secrets', async t => {
 const h = await setup(t);
 const p = (await h.request('POST', '/api/sessions/preview', { ...candidate(h.peer), bgp: { authentication: 'md5', password: 'lab-only-secret' } })).json();
 assert.equal(p.session.bgp.password, '********'); assert.doesNotMatch(JSON.stringify(p), /lab-only-secret/);
 assert.equal((await h.request('POST', '/api/sessions/apply', { ...accepted(p), localAsn: 64514 })).json().code, 'SESSION_PREVIEW_STALE');
 assert.equal((await h.request('POST', '/api/sessions/apply', { ...accepted(p), candidateHash: 'wrong' })).json().code, 'SESSION_PREVIEW_STALE');
 assert.equal((await h.request('POST', '/api/sessions/apply', { ...candidate(h.peer), mode: 'apply' })).json().code, 'SESSION_PREVIEW_STALE');
 const applied = await h.request('POST', '/api/sessions/apply', accepted(p)); assert.equal(applied.statusCode, 202, applied.body);
 assert.equal((await h.store.read()).sessions[0].bgp.password, 'lab-only-secret');
 assert.equal((await h.request('POST', '/api/sessions/apply', accepted(p))).json().code, 'STATE_CONFLICT');
 const before = await h.store.read(); h.calls.length = 0;
 assert.equal((await h.request('POST', '/api/sessions/preview', { ...candidate(h.peer), inventoryRevision: p.inventoryRevision })).json().code, 'STATE_CONFLICT');
 assert.deepEqual(await h.store.read(), before); assert.equal(h.calls.length, 0);
});
test('eBGP preflights full IRR include bundle, retains state on validation/apply failure, rolls back and releases lock', async t => {
 const h = await setup(t);
 await h.store.mutate(s => {
  s.defines.push({ id: 'irr', name: 'IRR_V4', label: 'IRR', type: 'cidr4', nodeIds: ['one'], enabled: true, entries: ['203.0.113.0/24'], entrySource: { kind: 'irr-as-set', asSet: 'AS-LAB', server: 'rr.example', databases: [], refreshIntervalSeconds: 900, prefixLimit: 100, allowMoreSpecific: false }, sync: { status: 'ready', contentHash: 'test', lastAttemptAt: null, lastSuccessAt: null, nextRefreshAt: null, error: null } });
 });
 const p = (await h.request('POST', '/api/sessions/preview', candidate(h.peer))).json(); assert.ok(p.valid);
 const stage = h.calls.filter(c => c.method === 'bird.stage').at(-1); assert.ok(stage.params.resources.length); assert.match(stage.params.resources[0].content, /define IRR_V4/);
 const before = await h.store.read(); h.failures.set('one:bird.stage', 'native preflight rejected');
 const invalid = await h.request('POST', '/api/sessions/apply', accepted(p)); assert.equal(invalid.statusCode, 422); assert.deepEqual(await h.store.read(), before);
 h.failures.clear(); h.failures.set('one:bird.apply', 'reload failed');
 const failed = await h.request('POST', '/api/sessions/apply', accepted(p)); assert.equal(failed.statusCode, 500); assert.ok(h.calls.some(c => c.method === 'bird.rollback')); assert.deepEqual(await h.store.read(), before);
 h.failures.clear(); assert.equal((await h.request('POST', '/api/sessions/apply', accepted(p))).statusCode, 202);
 const id = (await h.store.read()).sessions[0].id;
 h.calls.length = 0; assert.equal((await h.request('DELETE', `/api/sessions/${id}`)).statusCode, 200); assert.ok(h.calls.find(c => c.method === 'bird.stage').params.resources.length);
});
