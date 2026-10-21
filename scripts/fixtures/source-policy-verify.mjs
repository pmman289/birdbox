import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const cookie = await fs.readFile('/verification/cookie', 'utf8'), nodeId = 'node_installer_e2e';
async function api(path, method = 'GET', body, status = 200) {
 const r = await fetch(`http://127.0.0.1:3000${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
 const value = await r.json(); assert.equal(r.status, status, `${path}: ${JSON.stringify(value)}`); return value;
}
const accepted = p => ({ ...p.resource, mode: 'apply', previewId: p.previewId, candidateHash: p.candidateHash, inventoryRevision: p.inventoryRevision });
const idsFile = '/verification/source.json';
const action = process.argv[2];
const ids = action === 'create' ? {} : JSON.parse(await fs.readFile(idsFile, 'utf8'));
if (action === 'create') {
 const define = (await api('/api/defines', 'POST', { name: 'NATIVE_INTERNAL4', label: 'Internal prefixes', nodeIds: [nodeId], type: 'cidr4', entries: ['198.51.100.0/24'] }, 201)).resource;
 ids.defineId = define.id;
 const body = { nodeIds: [nodeId], label: 'Native source mapping', groups: [{ egressAddress: '192.0.2.2', sources: ['198.18.120.1/32'] }], copyInternalRoutes: true, internalDefineIds: [define.id] };
 const before = (await api('/api/dashboard')).inventory;
 const context = await api('/api/source-policies/editor-context');
 const sketch = await api('/api/source-policies/preview', 'POST', { ...body, mode: 'plan', inventoryRevision: context.inventoryRevision }); assert.equal(sketch.valid, undefined);
 const p = await api('/api/source-policies/preview', 'POST', { ...body, inventoryRevision: context.inventoryRevision }); assert.equal(p.valid, true); assert.deepEqual((await api('/api/dashboard')).inventory, before);
 const saved = await api('/api/source-policies', 'POST', accepted(p), 201); assert.deepEqual(saved.resource, p.resource);
 assert.equal((await api(`/api/dashboard?nodeId=${nodeId}`)).config, p.configs[0].config);
 ids.resource = saved.resource; ids.tableName = /ipv4 table (bb_spe_t_\w+);/.exec(p.configs[0].config)[1];
 await api('/api/source-policies', 'POST', accepted(p), 409);
 await api(`/api/defines/${define.id}`, 'DELETE', undefined, 409);
 console.log('PASS: source mapping actual HTTP reviewed create; readonly sketch/full preflight; exact IDs, group/table/priority and config identity; CAS and internal Define protection');
} else if (action === 'delete') {
 const c = await api(`/api/source-policies/editor-context?id=${ids.resource.id}`);
 await api(`/api/source-policies/${ids.resource.id}`, 'DELETE', { inventoryRevision: c.inventoryRevision });
 await api(`/api/defines/${ids.defineId}`, 'DELETE');
 assert.equal((await api('/api/dashboard')).inventory.sourcePolicies.length, 0);
 console.log('PASS: source mapping deletion and internal Define dependency cleanup');
} else {
 const c = await api(`/api/source-policies/editor-context?id=${ids.resource.id}`);
 const changes = action === 'edit' ? { label: 'Native updated mapping', groups: [{ ...c.resource.groups[0], egressAddress: '192.0.2.3', sources: ['198.18.120.2/32'] }] } : { enabled: action === 'enable' };
 const p = await api('/api/source-policies/preview', 'POST', { ...c.resource, ...changes, inventoryRevision: c.inventoryRevision }); assert.ok(p.valid);
 const saved = await api(`/api/source-policies/${ids.resource.id}`, 'PUT', accepted(p));
 assert.equal(saved.resource.groups[0].id, ids.resource.groups[0].id); assert.equal(saved.resource.groups[0].kernelTable, ids.resource.groups[0].kernelTable); assert.equal(saved.resource.rulePriorityBase, ids.resource.rulePriorityBase);
 ids.previous = ids.resource; ids.resource = saved.resource;
 console.log(`PASS: source mapping reviewed ${action} retains stable allocations`);
}
if (action !== 'delete') {
 const before = (await api('/api/dashboard')).inventory;
 const runtime = await api(`/api/source-policies/${ids.resource.id}/runtime`), node = runtime.nodes[0], group = node.groups[0];
 assert.equal(node.rules.error, null); assert.equal(node.rules.persistence, 'ready');
 assert.equal(node.rules.installed, ids.resource.enabled ? 2 : 0); assert.equal(node.rules.missing.length, 0); assert.equal(node.rules.unexpected.length, 0);
 assert.ok(group.protocols.every(p => p.state === (ids.resource.enabled ? 'up' : 'disabled')), JSON.stringify(group.protocols));
 assert.equal(group.routeError, null);
 assert.equal(group.kernelRoutes.some(r => r.prefix === 'default' && r.gateway === ids.resource.groups[0].egressAddress), ids.resource.enabled);
 const routes = await api(`/api/source-policies/${ids.resource.id}/routes?nodeId=${nodeId}&groupId=${ids.resource.groups[0].id}&target=198.51.100.1`);
 assert.equal(routes.routes.some(r => r.prefix === '198.51.100.0/24'), ids.resource.enabled);
 assert.deepEqual((await api('/api/dashboard')).inventory, before);
 console.log('PASS: native readonly runtime API matches actual protocol, persisted rules, kernel routes and BIRD target query');
}
await fs.writeFile(idsFile, JSON.stringify(ids));
