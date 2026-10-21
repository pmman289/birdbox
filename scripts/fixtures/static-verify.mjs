import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const cookie = await fs.readFile('/verification/cookie', 'utf8');
const nodeId = 'node_installer_e2e';
async function api(path, method = 'GET', body, expected = 200) {
 const response = await fetch(`http://127.0.0.1:3000${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
 const value = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
}
const hop = (address, extra = {}) => ({ address, interface: 'lab0', weight: 1, bfd: false, onlink: false, ...extra });
const route = (id, prefix, extra = {}) => ({ id, prefix, type: 'blackhole', ...extra });
for (const family of ['ipv4', 'ipv6']) {
 const v4 = family === 'ipv4', n = v4 ? '4' : '6', table = `static_business${n}`;
 const prefixes = v4 ? ['198.18.1.0/24', '198.18.2.0/24', '198.18.3.0/24', '198.18.4.0/24', '198.18.5.0/24'] : ['2001:db8:1::/48', '2001:db8:2::/48', '2001:db8:3::/48', '2001:db8:4::/48', '2001:db8:5::/48'];
 const addr = i => v4 ? `192.0.2.${i}` : `2001:db8:ff::${i}`;
 const denied = v4 ? '198.18.6.0/24' : '2001:db8:6::/48';
 const linkedPrefixes = v4 ? ['198.19.1.0/24', '198.19.2.0/24', '198.19.3.0/24', '198.19.4.0/24'] : ['2001:db8:11::/48', '2001:db8:12::/48', '2001:db8:13::/48', '2001:db8:14::/48'];
 const define = await api('/api/defines', 'POST', { type: v4 ? 'cidr4' : 'cidr6', name: `static_linked${n}`, label: 'Linked prefixes', nodeIds: [nodeId], entries: linkedPrefixes.slice(0,3) }, 201);
 const policy = await api('/api/filters', 'POST', { name: `static_import${n}`, label: `Static Import ${n}`, nodeIds: [nodeId], source: `filter static_import${n} { if net = ${denied} then reject; bgp_local_pref = 177; bgp_community.add((64512,17)); accept; }` }, 201);
 const body = { defineId: define.resource.id, action: { type: 'via', nextHops: [hop(addr(2), { weight: 2 }), hop(addr(3), { weight: 3 })] }, routeActions: { [linkedPrefixes[1]]: { type: 'recursive', recursiveVia: addr(4) }, [linkedPrefixes[2]]: { type: 'blackhole', enabled: false } }, routeFilters: { [linkedPrefixes[0]]: { operations: [{ type: 'set', attribute: 'preference', value: 175 }], custom: 'ospf_metric1 = 30;' } }, importPolicy: { mode: 'custom', filterId: policy.resource.id }, nodeId, name: `lab_static${n}`, label: `Static lab IPv${n}`, family, table: { name: table, source: 'managed' }, igpTable: `master${n}`, checkLink: true, routes: [
  route('ecmp', prefixes[0], { type: 'via', nextHops: [hop(addr(2), { weight: 2 }), hop(addr(3), { weight: 3 })] }),
  route('backup', prefixes[0], { filter: { operations: [{ type: 'set', attribute: 'preference', value: 100 }], custom: '' } }),
  route('recursive', prefixes[1], { type: 'recursive', recursiveVia: addr(4) }),
  route('interface', prefixes[2], { type: 'via', nextHops: [hop(null)] }),
  route('onlink', prefixes[3], { type: 'via', nextHops: [hop(addr(6), { onlink: true })] }),
  route('denied', denied),
  route('bfd', prefixes[4], { type: 'via', nextHops: [hop(addr(5), { bfd: true })] })
 ] };
 const before = (await api('/api/dashboard')).inventory;
 const preview = await api('/api/statics/preview', 'POST', body); assert.equal(preview.valid, true); assert.deepEqual((await api('/api/dashboard')).inventory, before);
 const saved = await api('/api/statics', 'POST', { ...preview.resource, previewId: preview.previewId, inventoryRevision: preview.inventoryRevision }, 201); assert.equal(saved.deployment.applied, true);
 const id = saved.resource.id;
 const dashboard = await api(`/api/dashboard?nodeId=${nodeId}`); assert.equal(dashboard.config, preview.configs[0].config);
 const runtime = await api(`/api/statics/${id}/runtime`); assert.equal(runtime.state, 'up'); assert.equal(runtime.table, table); assert.ok(runtime.imported >= 4);
 let routes = await api(`/api/statics/${id}/routes`);
 for (const prefix of prefixes.slice(0,4)) assert.ok(routes.routes.some(r => r.prefix === prefix), `missing ${prefix}: ${JSON.stringify(routes)}`);
 assert.ok(!routes.routes.some(r => r.prefix === denied), 'Static Import Filter must reject the denied prefix');
 const ec = routes.routes.find(r => r.prefix === prefixes[0]); assert.match(ec.details + ec.summary, /weight [23]/); assert.match(ec.details, /BGP.local_pref: 177/); assert.match(ec.details, /\(64512,17\)/);
 assert.ok(!routes.routes.some(r => r.prefix === prefixes[4]), 'BFD next hop without a peer must remain withdrawn');
 assert.ok(routes.routes.some(r => r.prefix === linkedPrefixes[0] && /weight [23]/.test(r.details + r.summary)));
 assert.ok(routes.routes.some(r => r.prefix === linkedPrefixes[1])); assert.ok(!routes.routes.some(r => r.prefix === linkedPrefixes[2]));
 const linked = routes.routes.find(r => r.prefix === linkedPrefixes[0]); assert.match(linked.summary, /175/); assert.match(linked.details, /OSPF.metric1: 30/);
 await api(`/api/defines/${define.resource.id}`, 'PUT', { entries: linkedPrefixes });
 routes = await api(`/api/statics/${id}/routes`); assert.ok(routes.routes.some(r => r.prefix === linkedPrefixes[3] && /weight [23]/.test(r.details + r.summary)), 'new Define prefixes inherit structured forwarding');
 const lookup = await api(`/api/statics/${id}/routes?target=${encodeURIComponent(v4 ? '198.18.1.1' : '2001:db8:1::1')}`); assert.ok(lookup.routes.every(r => r.summary.includes(`lab_static${n}`))); assert.equal(lookup.routes[0].prefix, prefixes[0]);
 const pipe = await api('/api/pipes', 'POST', { name: `lab_static_pipe${n}`, label: `Static exchange ${n}`, nodeIds: [nodeId], family, table: { name: table, source: 'existing' }, peerTable: { name: `master${n}`, source: 'existing' } }, 201);
 const masterRoutes = await api(`/api/pipes/${pipe.resource.id}/routes?nodeId=${nodeId}&side=peer`); assert.ok(masterRoutes.routes.some(r => r.prefix === prefixes[1]));
 // No write on invalid candidate or stale preview. Existing routes continue working.
 const prior = (await api('/api/dashboard')).inventory;
 await api(`/api/statics/${id}`, 'PUT', { raw: 'route invalid;' }, 422); assert.deepEqual((await api('/api/dashboard')).inventory, prior);
 const stale = await api('/api/statics/preview', 'POST', { ...saved.resource, id });
 await api(`/api/statics/${id}`, 'PUT', { label: `Updated ${n}` });
 await api(`/api/statics/${id}`, 'PUT', { ...stale.resource, previewId: stale.previewId, inventoryRevision: stale.inventoryRevision }, 409);
 await api(`/api/statics/${id}`, 'PUT', { enabled: false }); assert.equal((await api(`/api/statics/${id}/runtime`)).state, 'disabled'); assert.deepEqual((await api(`/api/statics/${id}/routes`)).routes, []);
 // Pipe still references the managed table; deleting its last owner must fail atomically.
 const disabled = (await api('/api/dashboard')).inventory;
 await api(`/api/statics/${id}`, 'DELETE', undefined, 422); assert.deepEqual((await api('/api/dashboard')).inventory, disabled);
 await api(`/api/pipes/${pipe.resource.id}`, 'DELETE'); await api(`/api/statics/${id}`, 'DELETE');
 assert.ok(!(await api('/api/dashboard')).inventory.staticProtocols.some(s => s.id === id));
 await api(`/api/filters/${policy.resource.id}`, 'DELETE');
 await api(`/api/defines/${define.resource.id}`, 'DELETE');
 console.log(`PASS ${family}: preview/apply identical; ECMP weights, backup, recursive, interface, onlink, BFD withdrawal, Import Filter and attributes; protocol and target routes; Static → Pipe; preflight/CAS failures; disable/delete; table dependency protection`);
}
