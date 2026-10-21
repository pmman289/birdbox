import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const cookie = await fs.readFile('/verification/cookie', 'utf8');
const one = 'node_installer_e2e', two = 'ibgp_peer';
const [, , action, primaryAddress, peerAddress] = process.argv;
async function api(path, method = 'GET', body, status = 200) {
 const r = await fetch(`http://127.0.0.1:3000${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) }); const v = await r.json(); assert.equal(r.status, status, `${path}: ${JSON.stringify(v)}`); return v;
}
const peerNode = { id: two, name: 'iBGP peer', transport: 'agent', routerId: '192.0.2.2', igpAddress: peerAddress, mainConfigPath: '/etc/bird/bird.conf', generatedConfigPath: '/var/lib/birdbox/generated.conf', socketPath: '/run/bird/bird.ctl' };
const pause = () => new Promise(r => setTimeout(r, 200));
async function until(fn, message) { for (let i = 0; i < 150; i++) { if (await fn()) return; await pause(); } assert.fail(message); }
if (action === 'setup') {
 const script = await api('/api/nodes/setup-script', 'POST', peerNode);
 await fs.writeFile('/verification/second.sh', script.script, { mode: 0o600 });
} else {
 await until(async () => (await api('/api/agent/status')).agents.some(a => a.nodeId === two && a.connected), 'second Agent connects');
 await api('/api/nodes', 'POST', peerNode, 201);
 const statics = [];
 for (const family of ['ipv4', 'ipv6']) statics.push((await api('/api/statics', 'POST', { nodeId: two, name: `ibgp_origin_${family}`, label: family, family, routes: [{ id: `route_${family}`, prefix: family === 'ipv4' ? '203.0.113.0/24' : '2001:db8:100::/48', type: 'blackhole' }] }, 201)).resource);
 const domain = { id: 'native_core', name: 'Native Core', asn: 64512, members: [{ nodeId: one, address: primaryAddress }, { nodeId: two, address: peerAddress }], adjacencies: [{ id: 'native_pair', leftNodeId: one, rightNodeId: two, leftSessionId: 'native_left', rightSessionId: 'native_right' }], layout: {} };
 const accepted = p => ({ ...p.domain, sessionUpdates: p.sessions, mode: 'apply', inventoryRevision: p.inventoryRevision, previewId: p.previewId, candidateHash: p.candidateHash });
 const before = (await api('/api/dashboard')).inventory;
 const initial = await api('/api/ibgp-domains/preview', 'POST', domain); assert.ok(initial.valid); assert.deepEqual((await api('/api/dashboard')).inventory, before);
 initial.sessions.forEach((s, i) => { s.localPort = i ? 2179 : 1179; s.bgp.strictBind = true; s.bgp.bfd = 'on'; for (const ch of Object.values(s.channels)) ch.exportPolicy.formAction = 'all'; });
 const p = await api('/api/ibgp-domains/preview', 'POST', { ...initial.domain, sessionUpdates: initial.sessions }); assert.ok(p.valid);
 await api('/api/ibgp-domains', 'POST', accepted(p), 201);
 const protocol = id => api(`/api/sessions/${id}/protocol`);
 await until(async () => /BGP state:\s+Established/.test((await protocol('native_left')).output) && /BGP state:\s+Established/.test((await protocol('native_right')).output), 'both managed iBGP endpoints establish');
 const routes = family => api(`/api/sessions/native_left/routes?family=${family}&direction=import`);
 await until(async () => (await routes('ipv4')).routes.some(r => r.prefix === '203.0.113.0/24'), 'iBGP IPv4 actual import');
 await until(async () => (await routes('ipv6')).routes.some(r => r.prefix === '2001:db8:100::/48'), 'iBGP IPv6 actual import');
 await fs.writeFile('/verification/bfd-ready', 'ready');
 await until(async () => fs.access('/verification/bfd-verified').then(() => true, () => false), 'native CLI must verify BFD Up on both nodes');
 console.log('PASS: two installed Agents, equal-ASN sessions, independent 1179/2179 ports, actual BFD Up, real dual-stack Established and routes');
 const filter = (await api('/api/filters', 'POST', { name: 'ibgp_deny4', label: 'Deny4', nodeIds: [one], source: 'filter ibgp_deny4 { reject; }' }, 201)).resource;
 await api('/api/ibgp-domains/native_core', 'PUT', accepted(p), 409);
 p.sessions[0].channels.ipv4.importPolicy = { mode: 'custom', filterId: filter.id, steps: [], formAction: 'none' };
 p.sessions[0].bgp.rrClient = true; p.sessions[0].bgp.rrClusterId = '192.0.2.254';
 let changed = await api('/api/ibgp-domains/preview', 'POST', { ...p.domain, sessionUpdates: p.sessions }); assert.ok(changed.valid);
 await api('/api/ibgp-domains/native_core', 'PUT', accepted(changed));
 await until(async () => /BGP state:\s+Established/.test((await protocol('native_left')).output), 'iBGP re-establishes after RR change');
 await until(async () => (await routes('ipv6')).routes.some(r => r.prefix === '2001:db8:100::/48'), 'IPv6 returns after BGP reconfiguration');
 await until(async () => (await routes('ipv4')).routes.length === 0, 'IPv4 Filter withdraws import');
 await api(`/api/filters/${filter.id}`, 'DELETE', undefined, 409);
 const inventory = (await api('/api/dashboard')).inventory;
 const bad = structuredClone(changed.sessions); bad[0].bgp.raw = 'invalid_bird_syntax;';
 const invalid = await api('/api/ibgp-domains/preview', 'POST', { ...changed.domain, sessionUpdates: bad }); assert.equal(invalid.valid, false); assert.equal(invalid.configs.find(c => c.nodeId === two).validation.ok, true); assert.deepEqual((await api('/api/dashboard')).inventory, inventory);
 console.log('PASS: RR options, Filter rejection/IPv6 retained, reference protection, node preflight isolation and readonly invalid preview');
 for (const enabled of [false, true]) { changed = await api('/api/ibgp-domains/preview', 'POST', { ...changed.domain, adjacencies: changed.domain.adjacencies.map(a => ({ ...a, enabled })), sessionUpdates: changed.sessions }); assert.ok(changed.valid); await api('/api/ibgp-domains/native_core', 'PUT', accepted(changed)); if (enabled) await until(async () => /BGP state:\s+Established/.test((await protocol('native_left')).output), 're-enabled iBGP establishes'); else assert.match((await protocol('native_left')).output, /配置已停用/); }
 const removed = await api('/api/ibgp-domains/preview', 'POST', { ...changed.domain, members: [changed.domain.members[0]], adjacencies: [] }); assert.ok(removed.valid); assert.equal(removed.configs.length, 2);
 await api('/api/ibgp-domains/native_core', 'PUT', accepted(removed));
 assert.equal((await api('/api/dashboard')).inventory.sessions.filter(s => s.managedBy?.domainId === domain.id).length, 0);
 await api('/api/ibgp-domains/native_core', 'DELETE'); await api(`/api/filters/${filter.id}`, 'DELETE'); for (const s of statics) await api(`/api/statics/${s.id}`, 'DELETE');
 console.log('PASS: actual disable/re-enable, old-node config cleanup, domain/session/peer deletion and policy cleanup');
}
