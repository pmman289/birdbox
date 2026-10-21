import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const cookie = await fs.readFile('/verification/cookie', 'utf8'), nodeId = 'node_installer_e2e';
async function api(path, method = 'GET', body, status = 200) {
 const result = await fetch(`http://127.0.0.1:3000${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
 const value = await result.json(); assert.equal(result.status, status, `${path}: ${JSON.stringify(value)}`); return value;
}
async function until(check, message) {
 for (let i = 0; i < 60; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
 assert.fail(message);
}
const policy = formAction => ({ mode: 'form', steps: [], filterId: null, formAction });
const accepted = p => ({ ...p.resource, mode: 'apply', previewId: p.previewId, candidateHash: p.candidateHash, inventoryRevision: p.inventoryRevision });
const getRoutes = (kind, id, family, direction = 'import') => api(`/api/${kind}/${id}/routes?nodeId=${nodeId}&family=${family}&direction=${direction}`);
const idsFile = '/verification/system-ids.json';
if (process.argv[2] === 'create') {
 const before = (await api('/api/dashboard')).inventory;
 const d = await api('/api/directs/preview', 'POST', { label: 'Direct native', name: 'sys_direct', nodeId, ipv4: true, ipv6: true, interfaces: ['lab1'], checkLink: true }); assert.equal(d.valid, true); assert.deepEqual((await api('/api/dashboard')).inventory, before);
 const direct = (await api('/api/directs', 'POST', accepted(d), 201)).resource;
 await until(async () => (await getRoutes('directs', direct.id, 'ipv4')).routes.some(r => r.prefix === '198.19.0.0/24'), 'Direct must learn IPv4 dummy interface');
 await until(async () => (await getRoutes('directs', direct.id, 'ipv6')).routes.some(r => r.prefix === '2001:db8:dd::/64'), 'Direct must learn IPv6 dummy interface');
 assert.equal((await api(`/api/directs/${direct.id}/runtime`)).nodes[0].protocols[0].state, 'up');
 const tables = { ipv4: { name: 'sys_business4', source: 'managed' }, ipv6: { name: 'sys_business6', source: 'managed' } };
 const k = await api('/api/kernels/preview', 'POST', { label: 'Kernel native', name: 'sys_kernel', nodeIds: [nodeId], ipv4: true, ipv6: true, tables, table: 121, scanTime: 1, learn: true, metric: 42, mergePaths: 8, gracefulRestart: true, importPolicies: { ipv4: policy('all'), ipv6: policy('none') } }); assert.equal(k.valid, true);
 const kernel = (await api('/api/kernels', 'POST', accepted(k), 201)).resource;
 assert.equal((await api(`/api/dashboard?nodeId=${nodeId}`)).config, k.configs[0].config);
 const statics = [];
 for (const family of ['ipv4', 'ipv6']) {
  const s = await api('/api/statics', 'POST', { nodeId, label: family, name: `sys_static_${family}`, family, table: { ...tables[family], source: 'existing' }, routes: [{ id: 'blackhole', prefix: family === 'ipv4' ? '198.18.20.0/24' : '2001:db8:20::/48', type: 'blackhole' }] }, 201); statics.push(s.resource.id);
  await until(async () => (await getRoutes('kernels', kernel.id, family, 'export')).routes.length > 0, 'Kernel must export static route');
 }
 const runtimes = (await api(`/api/kernels/${kernel.id}/runtime`)).nodes[0].protocols; assert.equal(runtimes.length, 2); assert.ok(runtimes.every(r => r.state === 'up' && r.exported >= 1));
 await fs.writeFile(idsFile, JSON.stringify({ direct: direct.id, kernel: kernel.id, statics }));
 console.log('PASS: actual Direct dual-stack learning and Kernel custom table export; preview/apply identity; protocol states/counters');
} else {
 const ids = JSON.parse(await fs.readFile(idsFile, 'utf8'));
 if (process.argv[2] === 'link-down') {
  for (const family of ['ipv4', 'ipv6']) await until(async () => !(await getRoutes('directs', ids.direct, family)).routes.length, `Direct ${family} must withdraw routes on link-down`);
  console.log('PASS: Direct check link withdraws both families when interface is down');
 } else if (process.argv[2] === 'policies') {
  await until(async () => (await getRoutes('directs', ids.direct, 'ipv4')).routes.length > 0, 'Direct must recover after link-up');
  await until(async () => (await getRoutes('kernels', ids.kernel, 'ipv4')).routes.some(r => r.prefix === '203.0.113.0/24'), 'learn + IPv4 import all must learn foreign Linux routes');
  assert.ok(!(await getRoutes('kernels', ids.kernel, 'ipv6')).routes.some(r => r.prefix === '2001:db8:99::/48'), 'IPv6 import none must independently reject foreign Linux route');
  const filter = (await api('/api/filters', 'POST', { label: 'Reject IPv4 only', name: 'sys_reject4', nodeIds: [nodeId], source: 'filter sys_reject4 { reject; }' }, 201)).resource;
  const p = await api('/api/kernels/preview', 'POST', { id: ids.kernel, importPolicies: { ipv4: policy('all'), ipv6: policy('all') }, exportPolicies: { ipv4: { mode: 'visual', policy: { mode: 'custom', filterId: filter.id } }, ipv6: { mode: 'visual', policy: policy('all') } } }); assert.equal(p.valid, true);
  await api(`/api/kernels/${ids.kernel}`, 'PUT', accepted(p)); ids.filter = filter.id; await fs.writeFile(idsFile, JSON.stringify(ids));
  await until(async () => (await getRoutes('kernels', ids.kernel, 'ipv6')).routes.some(r => r.prefix === '2001:db8:99::/48'), 'IPv6 import all must learn foreign route');
  assert.equal((await getRoutes('kernels', ids.kernel, 'ipv4', 'export')).routes.length, 0);
  await api(`/api/filters/${filter.id}`, 'DELETE', undefined, 409);
  const before = (await api('/api/dashboard')).inventory;
  const invalid = await api('/api/kernels/preview', 'POST', { id: ids.kernel, tables: { ipv4: { name: 'missing_inventory_table', source: 'existing' }, ipv6: { name: 'sys_business6', source: 'managed' } } }); assert.equal(invalid.valid, false); assert.deepEqual((await api('/api/dashboard')).inventory, before);
  await api(`/api/kernels/${ids.kernel}`, 'PUT', { ...accepted(p), inventoryRevision: p.inventoryRevision - 1 }, 409);
  console.log('PASS: actual learn/import all vs none, independent Filter export, policy delete protection, invalid preflight and CAS without writes');
 } else {
  for (const kind of ['directs', 'kernels']) {
   const id = kind === 'directs' ? ids.direct : ids.kernel;
   const p = await api(`/api/${kind}/preview`, 'POST', { id, enabled: false }); assert.equal(p.valid, true); await api(`/api/${kind}/${id}`, 'PUT', accepted(p)); assert.ok((await api(`/api/${kind}/${id}/runtime`)).nodes[0].protocols.every(r => r.state === 'disabled'));
   await api(`/api/${kind}/${id}`, 'DELETE', undefined, kind === 'kernels' ? 422 : 200);
  }
  for (const id of ids.statics) await api(`/api/statics/${id}`, 'DELETE');
  await api(`/api/kernels/${ids.kernel}`, 'DELETE'); await api(`/api/filters/${ids.filter}`, 'DELETE');
  const state = (await api('/api/dashboard')).inventory; assert.ok(!state.directProtocols.length && !state.kernelProtocols.length);
  console.log('PASS: stop/delete actual protocols; retained table dependencies reject deletion until all consumers removed; final cleanup');
 }
}
