import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const cookie = await fs.readFile('/verification/cookie', 'utf8');
const one = 'node_installer_e2e', two = 'ospf_peer';
const [, , action, primaryAddress, peerAddress] = process.argv;
async function api(path, method = 'GET', body, status = 200) {
 const r = await fetch(`http://127.0.0.1:3000${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
 const value = await r.json(); assert.equal(r.status, status, `${method} ${path}: ${JSON.stringify(value)}`); return value;
}
const peerNode = { id: two, name: 'OSPF peer', transport: 'agent', routerId: '192.0.2.2', igpAddress: peerAddress, mainConfigPath: '/etc/bird/bird.conf', generatedConfigPath: '/var/lib/birdbox/generated.conf', socketPath: '/run/bird/bird.ctl' };
const pause = () => new Promise(r => setTimeout(r, 250));
async function until(fn, message) { for (let i = 0; i < 120; i++) { if (await fn()) return; await pause(); } assert.fail(message); }
if (action === 'setup') {
 const script = await api('/api/nodes/setup-script', 'POST', peerNode);
 await fs.writeFile('/verification/second.sh', script.script, { mode: 0o600 });
} else {
 await until(async () => (await api('/api/agent/status')).agents.some(a => a.nodeId === two && a.connected), 'second Agent connects');
 await api('/api/nodes', 'POST', peerNode, 201);
 const statics = [];
 for (const family of ['ipv4', 'ipv6']) statics.push((await api('/api/statics', 'POST', { nodeId: two, name: `ospf_origin_${family}`, label: family, family, routes: [{ id: `route_${family}`, prefix: family === 'ipv4' ? '203.0.113.0/24' : '2001:db8:100::/48', type: 'blackhole' }] }, 201)).resource);
 const policy = action => ({ mode: 'form', formAction: action, steps: [{ type: 'form' }], filterId: null });
 const domain = { id: 'native_ospf', name: 'Native OSPF', nodeConfigs: [one, two].map((nodeId, i) => ({ nodeId, enabled: true, routerId: `192.0.2.${i + 1}`, versions: ['ospfv2', 'ospfv3'], importPolicies: { ospfv2: policy('all'), ospfv3: policy('all') }, exportPolicies: { ospfv2: policy('all'), ospfv3: policy('all') } })), links: [{ id: 'native_pair', fromNodeId: one, toNodeId: two, localInterface: 'eth0', remoteInterface: 'eth0', area: '0.0.0.0', cost: 10, hello: 1, dead: 4, localOptions: { type: 'ptp', deadMode: 'seconds', priority: 11 }, remoteOptions: { type: 'ptp', deadMode: 'seconds', priority: 22 } }], layout: {} };
 const accepted = p => ({ ...p.domain, mode: 'apply', inventoryRevision: p.inventoryRevision, previewId: p.previewId, candidateHash: p.candidateHash });
 async function review(body) { const p = await api('/api/ospf/preview', 'POST', body); assert.ok(p.valid, JSON.stringify(p)); return p; }
 const before = (await api('/api/dashboard')).inventory;
 await api('/api/ospf', 'POST', { ...domain, mode: 'draft', inventoryRevision: (await api('/api/ospf')).inventoryRevision });
 assert.deepEqual((await api('/api/dashboard')).inventory, before);
 let p = await review(domain); assert.deepEqual((await api('/api/dashboard')).inventory, before);
 await api('/api/ospf/layout', 'PATCH', { layout: { [one]: { x: 110, y: 220 } } });
 await api('/api/ospf', 'POST', accepted(p), 201);
 const saved = (await api('/api/dashboard')).inventory.ospfDomains[0];
 assert.equal(saved.links[0].localOptions.priority, 11); assert.equal(saved.links[0].remoteOptions.priority, 22); assert.deepEqual((await api('/api/ospf')).drafts, {});
 const runtime = () => api('/api/ospf/native_ospf/runtime');
 async function full(versions = ['ospfv2', 'ospfv3']) { await until(async () => (await runtime()).nodes.every(n => versions.every(v => n.runtime.neighbors.some(peer => peer.version === v && /^Full/.test(peer.state)))), 'actual OSPF neighbors must reach Full'); }
 await full();
 const realRuntime = await runtime();
 assert.ok(realRuntime.nodes.every(n => n.runtime.v2.protocol.state === 'up' && n.runtime.v3.protocol.state === 'up'), JSON.stringify(realRuntime));
 assert.ok(realRuntime.nodes.every(n => ['v2', 'v3'].every(v => n.runtime[v].protocol.areasAvailable && n.runtime[v].protocol.areas.some(a => a.area === '0.0.0.0' && a.type === 'normal' && a.interfaces >= 1 && a.neighbors === 1 && a.adjacentNeighbors === 1))), JSON.stringify(realRuntime));
 await until(async () => { const n = (await runtime()).nodes.find(n => n.nodeId === one); return n.runtime.routes.some(r => r.version === 'ospfv2' && r.prefix === '203.0.113.0/24') && n.runtime.routes.some(r => r.version === 'ospfv3' && r.prefix === '2001:db8:100::/48'); }, 'actual OSPF IPv4/IPv6 external routes');
 console.log('PASS: readonly draft/preflight, layout independent of candidate, actual Full neighbors and dual-stack routes, independent endpoints');
 const filter = (await api('/api/filters', 'POST', { name: 'ospf_deny4', label: 'OSPF deny4', nodeIds: [one], source: 'filter ospf_deny4 { reject; }' }, 201)).resource;
 await api('/api/ospf/native_ospf', 'PUT', accepted(p), 409);
 const changed = structuredClone(p.domain); delete changed.members; delete changed.areas;
 changed.nodeConfigs[0].importPolicies.ospfv2 = { mode: 'custom', filterId: filter.id, formAction: 'none', steps: [] };
 p = await review(changed); await api('/api/ospf/native_ospf', 'PUT', accepted(p));
 await full();
 await until(async () => { const n = (await runtime()).nodes.find(n => n.nodeId === one); return !n.runtime.routes.some(r => r.version === 'ospfv2' && r.prefix === '203.0.113.0/24') && n.runtime.routes.some(r => r.version === 'ospfv3' && r.prefix === '2001:db8:100::/48'); }, 'v2 Filter rejects while v3 remains imported');
 await api(`/api/filters/${filter.id}`, 'DELETE', undefined, 409);
 console.log('PASS: stale revision rejected, actual independent v2 Filter rejection with v3 route retained, dependency protection');
 for (const enabled of [false, true]) {
  p = await review({ ...p.domain, members: p.domain.members.map(m => ({ ...m, enabled })) });
  await api('/api/ospf/native_ospf', 'PUT', accepted(p));
  if (enabled) await full(); else assert.ok((await runtime()).nodes.every(n => !n.runtime.neighbors.some(peer => /^Full/.test(peer.state))));
 }
 const auth = structuredClone(p.domain); delete auth.members; delete auth.areas;
 auth.nodeConfigs.forEach(n => { n.versions = ['ospfv2']; });
 auth.links.forEach(l => { delete l.endpoints; l.authentication = 'md5'; l.localOptions.password = 'isolated-ospf-key'; l.remoteOptions.password = 'isolated-ospf-key'; });
 p = await review(auth); assert.doesNotMatch(JSON.stringify(p), /isolated-ospf-key/);
 await api('/api/ospf/native_ospf', 'PUT', accepted(p)); await full(['ospfv2']);
 assert.ok((await runtime()).nodes.every(n => !n.runtime.neighbors.some(peer => peer.version === 'ospfv3')));
 console.log('PASS: actual disable/re-enable, v2-only MD5 authentication, masked candidate apply and v3 isolation');
 const empty = await review({ id: 'native_ospf', name: 'Empty native', nodeConfigs: [], links: [] }); assert.equal(empty.configs.length, 2);
 await api('/api/ospf/native_ospf', 'PUT', accepted(empty));
 assert.ok((await runtime()).nodes.length === 0);
 await api('/api/ospf/native_ospf', 'DELETE'); await api(`/api/filters/${filter.id}`, 'DELETE'); for (const s of statics) await api(`/api/statics/${s.id}`, 'DELETE');
 assert.equal((await api('/api/dashboard')).inventory.ospfDomains.length, 0);
 console.log('PASS: former member protocol cleanup, empty domain, domain deletion and dependency cleanup');
}
