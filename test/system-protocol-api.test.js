import test from 'node:test';
import assert from 'node:assert/strict';
import { setupResourceApi } from './helpers/resource-api.js';
import { parseSystemProtocolRuntime } from '../src/bird-system-runtime.js';
import { normalizeDirectProtocol, normalizeKernelProtocol } from '../src/bird-system-protocols.js';
const resource = (kind, rest = {}) => ({ label: kind === 'directs' ? '业务直连' : '业务内核', name: `api_${kind}`, ipv4: true, ipv6: true, ...(kind === 'directs' ? { nodeId: 'one', interfaces: ['eth0', 'vlan*'], checkLink: true } : { nodeIds: ['one'], table: 120, scanTime: 20, learn: true, metric: 42, mergePaths: 8, gracefulRestart: true }), ...rest });
const applyBody = p => ({ ...p.resource, mode: 'apply', previewId: p.previewId, candidateHash: p.candidateHash, inventoryRevision: p.inventoryRevision });
for (const kind of ['directs', 'kernels']) {
 test(`${kind}: HTTP create → preview → apply → edit/move → disable/enable → runtime/routes → delete`, async t => {
  const h = await setupResourceApi(t), collection = kind === 'directs' ? 'directProtocols' : 'kernelProtocols';
  const before = await h.store.read();
  assert.equal((await h.app.inject({ method: 'POST', url: `/api/${kind}/preview`, payload: resource(kind) })).statusCode, 401);
  const context = (await h.request('GET', `/api/${kind}/editor-context`)).json();
  const response = await h.request('POST', `/api/${kind}/preview`, { ...resource(kind), inventoryRevision: context.inventoryRevision });
  assert.equal(response.statusCode, 200, response.body); const preview = response.json(); assert.equal(preview.valid, true); assert.equal(preview.configs.length, 1);
  assert.deepEqual(await h.store.read(), before); assert.equal(h.calls.some(c => c.method === 'bird.apply'), false);
  if (kind === 'directs') assert.match(preview.configs[0].config, /check link yes/);
  else { assert.match(preview.configs[0].config, /merge paths on limit 8/); assert.match(preview.configs[0].config, /metric 42/); }
  const created = await h.request('POST', `/api/${kind}`, applyBody(preview)); assert.equal(created.statusCode, 201, created.body); const id = created.json().resource.id;
  assert.equal(id, preview.resource.id); assert.equal(h.calls.filter(c => c.method === 'bird.stage').at(-1).params.config, preview.configs[0].config);
  const moved = (await h.request('POST', `/api/${kind}/preview`, { id, ...(kind === 'directs' ? { nodeId: 'two', interfaces: ['eth1'] } : { nodeIds: ['two'] }) })).json();
  assert.deepEqual(moved.configs.map(c => c.nodeId), ['one', 'two']); assert.doesNotMatch(moved.configs[0].config, new RegExp(`protocol (direct|kernel) api_${kind}`));
  assert.equal((await h.request('PUT', `/api/${kind}/${id}`, applyBody(moved))).statusCode, 200);
  const off = (await h.request('POST', `/api/${kind}/preview`, { id, enabled: false })).json(); assert.equal(off.valid, true);
  assert.equal((await h.request('PUT', `/api/${kind}/${id}`, applyBody(off))).statusCode, 200);
  h.calls.length = 0; const disabled = (await h.request('GET', `/api/${kind}/${id}/runtime`)).json(); assert.equal(disabled.nodes[0].protocols[0].state, 'disabled'); assert.equal(h.calls.length, 0);
  const on = (await h.request('POST', `/api/${kind}/preview`, { id, enabled: true, ipv6: false })).json(); assert.equal((await h.request('PUT', `/api/${kind}/${id}`, applyBody(on))).statusCode, 200);
  h.outputs.set('two:bird.protocol', `1002-api_${kind} ${kind === 'directs' ? 'Direct' : 'Kernel'} master4 up 12:00\n1006-  Channel ipv4\n    Routes: 3 imported, 7 exported`);
  const runtime = (await h.request('GET', `/api/${kind}/${id}/runtime`)).json(); assert.equal(runtime.nodes[0].protocols[0].state, 'up'); assert.equal(runtime.nodes[0].protocols[0].imported, 3);
  assert.equal((await h.request('GET', `/api/${kind}/${id}/routes?nodeId=two&family=ipv4&direction=${kind === 'directs' ? 'import' : 'export'}`)).statusCode, 200);
  assert.equal(h.calls.filter(c => c.method === 'bird.routes').at(-1).params.protocolName, `api_${kind}`);
  assert.equal((await h.request('GET', `/api/${kind}/${id}/routes?nodeId=one&family=ipv4`)).statusCode, 400);
  assert.equal((await h.request('GET', `/api/${kind}/${id}/routes?nodeId=two&family=ipv6`)).statusCode, 400);
  assert.equal((await h.request('GET', `/api/${kind}/${id}/routes?nodeId=two&family=ipv4&target=1.1.1.1%3Bquit`)).statusCode, 400);
  assert.equal((await h.request('DELETE', `/api/${kind}/${id}`, { inventoryRevision: preview.inventoryRevision })).statusCode, 409);
  const latest = (await h.request('GET', `/api/${kind}/editor-context?id=${id}`)).json();
  assert.equal((await h.request('DELETE', `/api/${kind}/${id}`, { inventoryRevision: latest.inventoryRevision })).statusCode, 200);
  assert.equal((await h.store.read())[collection].length, 0); assert.equal((await h.deploymentService.readJournal()).active, null);
 });
 test(`${kind}: stale candidate/revision/preflight failure preserve inventory and deployment failures rollback`, async t => {
  const h = await setupResourceApi(t); let p = (await h.service.previewSystemProtocol(kind, resource(kind))).payload;
  const create = body => kind === 'directs' ? h.service.createDirect(body) : h.service.createKernel(body);
  await assert.rejects(() => create({ ...applyBody(p), label: 'changed' }), e => e.code === 'PROTOCOL_PREVIEW_STALE');
  await assert.rejects(() => create({ ...resource(kind), mode: 'apply' }), e => e.code === 'PROTOCOL_PREVIEW_STALE');
  await h.store.mutate(draft => { draft.nodes[0].name = 'Updated'; });
  await assert.rejects(() => create(applyBody(p)), e => e.code === 'STATE_CONFLICT');
  h.failures.set('one:bird.stage', 'native preflight rejected'); p = (await h.service.previewSystemProtocol(kind, resource(kind))).payload; assert.equal(p.valid, false);
  await assert.rejects(() => create(resource(kind)), /native preflight rejected/); assert.equal(h.calls.some(c => c.method === 'bird.apply'), false);
  h.failures.clear(); const before = await h.store.read(); p = (await h.service.previewSystemProtocol(kind, resource(kind))).payload;
  h.failures.set('one:bird.apply', 'reload failed'); await assert.rejects(() => create(applyBody(p)), /reload failed/);
  assert.deepEqual(await h.store.read(), before); assert.ok(h.calls.some(c => c.method === 'bird.rollback')); assert.equal((await h.deploymentService.readJournal()).active, null);
  h.failures.clear(); assert.equal((await create(applyBody(p))).status, 201);
 });
}
test('Kernel: multi-node preview/runtime isolate errors; dual-stack queries select actual split protocol; policy scope protection', async t => {
 const h = await setupResourceApi(t);
 h.failures.set('two:bird.stage', 'node offline');
 const p = (await h.service.previewSystemProtocol('kernels', resource('kernels', { nodeIds: null }))).payload;
 assert.equal(p.valid, false); assert.equal(p.configs[0].validation.ok, true); assert.equal(p.configs[1].validation.ok, false);
 h.failures.clear(); const saved = await h.service.createKernel(resource('kernels', { nodeIds: null })); const id = saved.payload.resource.id;
 h.outputs.set('one:bird.protocol', '1002-api_kernels4 Kernel master4 up 12:00\n1006-  Routes: 0 imported, 4 exported\n1002-api_kernels6 Kernel master6 up 12:00\n1006-  Routes: 1 imported, 6 exported');
 h.failures.set('two:bird.protocol', 'timeout'); const r = (await h.request('GET', `/api/kernels/${id}/runtime`)).json();
 assert.equal(r.nodes[0].protocols[0].state, 'up'); assert.equal(r.nodes[0].protocols[0].exported, 4); assert.equal(r.nodes[0].protocols[1].exported, 6); assert.equal(r.nodes[1].protocols[0].state, 'error');
 assert.equal((await h.request('GET', `/api/kernels/${id}/routes?nodeId=one&family=ipv6&direction=export`)).statusCode, 200);
 assert.equal(h.calls.filter(c => c.method === 'bird.routes').at(-1).params.protocolName, 'api_kernels6');
 const fn = (await h.service.createPolicy('functions', { label: 'only one', name: 'only_one', nodeIds: ['one'], source: 'function only_one() { return true; }' })).payload.resource;
 await assert.rejects(() => h.service.previewSystemProtocol('kernels', { id, importPolicy: { mode: 'combined', steps: [{ type: 'function', functionId: fn.id, action: 'accept' }], formAction: 'none' } }), /Function/);
});
test('Kernel inline Filters remain independent for both families and directions without shared resources', async t => {
 const h = await setupResourceApi(t);
 const inline = (source, formAction) => ({ mode: 'custom', steps: [], filterId: null, inlineFilterSource: source, formAction });
 const payload = resource('kernels', {
  importPolicies: {
   ipv4: inline('if net ~ [ 203.0.113.0/24 ] then accept;\nreject;', 'none'),
   ipv6: inline('if net ~ [ 2001:db8:1::/48 ] then accept;\nreject;', 'none'),
  },
  exportPolicies: {
   ipv4: { mode: 'visual', policy: inline('if net ~ [ 198.51.100.0/24 ] then accept;\nreject;', 'none') },
   ipv6: { mode: 'visual', policy: inline('if net ~ [ 2001:db8:2::/48 ] then accept;\nreject;', 'none') },
  },
 });
 const preview = (await h.service.previewSystemProtocol('kernels', payload)).payload;
 assert.equal(preview.valid, true);
 assert.match(preview.configs[0].config, /203\.0\.113\.0\/24/);
 assert.match(preview.configs[0].config, /2001:db8:1::\/48/);
 assert.match(preview.configs[0].config, /198\.51\.100\.0\/24/);
 assert.match(preview.configs[0].config, /2001:db8:2::\/48/);
 assert.deepEqual(preview.resource.importPolicies.ipv4, payload.importPolicies.ipv4);
 assert.deepEqual(preview.resource.importPolicies.ipv6, payload.importPolicies.ipv6);
 assert.deepEqual(preview.resource.exportPolicies.ipv4.policy, payload.exportPolicies.ipv4.policy);
 assert.deepEqual(preview.resource.exportPolicies.ipv6.policy, payload.exportPolicies.ipv6.policy);
 assert.equal((await h.service.createKernel({ ...preview.resource, mode: 'apply', previewId: preview.previewId, candidateHash: preview.candidateHash, inventoryRevision: preview.inventoryRevision })).status, 201);
 assert.throws(() => normalizeKernelProtocol(resource('kernels', { importPolicies: { ipv4: inline('', 'none') } })), /自定义模式必须且只能配置一个 Filter/);
 assert.throws(() => normalizeKernelProtocol(resource('kernels', { importPolicies: { ipv4: { ...inline('accept;', 'none'), filterId: 'shared_filter' } } })), /自定义模式必须且只能配置一个 Filter/);
});
test('Direct/Kernel field bounds and parser distinguish missing/unknown from up and channel sums', () => {
 const defaults = normalizeKernelProtocol(resource('kernels', { id: 'k' })); assert.equal(defaults.importPolicy.formAction, 'none'); assert.equal(defaults.exportPolicy.formAction, 'all');
 assert.throws(() => normalizeDirectProtocol(resource('directs', { id: 'd', ipv4: false, ipv6: false })), /地址族/);
 assert.throws(() => normalizeDirectProtocol(resource('directs', { id: 'd', interfaces: ['eth0; quit'] })), /接口/);
 for (const field of ['metric', 'mergePaths', 'scanTime', 'table']) assert.throws(() => normalizeKernelProtocol(resource('kernels', { id: 'k', [field]: -1 })), /不合法|必须|范围/);
 assert.equal(parseSystemProtocolRuntime('x Direct master4 up now', 'y', 'Direct').state, 'not_configured');
 assert.equal(parseSystemProtocolRuntime('x Direct master4 wait now', 'x', 'Direct').state, 'unknown');
 assert.deepEqual(parseSystemProtocolRuntime('1002-d Direct --- up now\n1006-  Channel ipv4\n Routes: 2 imported, 0 exported\n Channel ipv6\n Routes: 3 imported, 0 exported', 'd', 'Direct'), { state: 'up', imported: 5, exported: 0 });
});
test('Kernel custom BIRD tables integrate with Pipe/Static, keep declarations while disabled, reject table/AF collisions, and independent import policies survive legacy edits', async t => {
 const h = await setupResourceApi(t), policy = action => ({ mode: 'form', steps: [], filterId: null, formAction: action });
 const tables = { ipv4: { name: 'business4', source: 'managed' }, ipv6: { name: 'business6', source: 'managed' } };
 const p = (await h.service.previewSystemProtocol('kernels', resource('kernels', { tables, importPolicies: { ipv4: policy('all'), ipv6: policy('none') } }))).payload;
 assert.match(p.configs[0].config, /ipv4 table business4/); assert.match(p.configs[0].config, /ipv6 table business6/);
 assert.match(p.configs[0].config, /ipv4 \{\s+table business4;\s+import all;/); assert.match(p.configs[0].config, /ipv6 \{\s+table business6;\s+import none;/);
 const saved = await h.service.createKernel(applyBody(p)), id = saved.payload.resource.id;
 await h.service.createPipe({ label: 'business', name: 'business_pipe', nodeIds: ['one'], family: 'ipv4', table: { name: 'master4', source: 'existing' }, peerTable: tables.ipv4 });
 const latest = (await h.service.previewSystemProtocol('kernels', { id, enabled: false })).payload;
 assert.equal((latest.configs[0].config.match(/ipv4 table business4;/g) ?? []).length, 1); assert.doesNotMatch(latest.configs[0].config, /protocol kernel api_kernels/);
 await h.service.updateKernel(id, applyBody(latest));
 const known = (await h.request('GET', '/api/pipes/tables')).json(); assert.ok(known.tables.some(t => t.name === 'business6' && t.source === 'managed'));
 const other = await h.service.createKernel(resource('kernels', { name: 'other_kernel', table: 130 }));
 await assert.rejects(() => h.service.createKernel(resource('kernels', { name: 'duplicate_kernel', table: 140 })), /已有 Kernel/);
 await assert.rejects(() => h.service.updateKernel(id, { enabled: true, table: 130 }), /Linux.*已有 Kernel/);
 await assert.rejects(() => h.service.previewSystemProtocol('kernels', { id, tables: { ...tables, ipv4: { name: 'business6', source: 'existing' } } }), /地址族冲突/);
 await h.service.updateKernel(id, { importPolicy: policy('all') }); const restored = (await h.store.read()).kernelProtocols.find(k => k.id === id); assert.equal(restored.importPolicies.ipv6.formAction, 'all');
 await h.service.deleteKernel(id); const after = (await h.service.previewSystemProtocol('kernels', { id: other.payload.resource.id })).payload;
 assert.match(after.configs[0].config, /ipv4 table business4;/); assert.doesNotMatch(after.configs[0].config, /ipv6 table business6;/);
});
