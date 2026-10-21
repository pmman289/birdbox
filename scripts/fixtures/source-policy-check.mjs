import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const { resource, previous, tableName } = JSON.parse(await fs.readFile('/root/source.json', 'utf8'));
const enabled = process.argv[2] === 'enabled', group = resource.groups[0], table = group.kernelTable;
const state = JSON.parse(await fs.readFile('/etc/birdbox/source-policy-rules.json', 'utf8'));
assert.equal(state.version, 1); assert.equal(state.nodeId, 'node_installer_e2e');
assert.equal(state.cleanup?.length ?? 0, 0, 'Acknowledged operations must not leave pending cleanup');
if (process.argv[2] === 'clear-rules') {
 for (const rule of state.rules) {
  const command = spawnSync('ip', ['-4', 'rule', 'del', 'priority', String(rule.priority), 'from', rule.source ?? 'all', 'to', rule.destination ?? 'all', 'table', String(rule.table)], { encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
 }
 console.log('PASS: deliberately removed all persisted managed rules from native kernel');
 process.exit(0);
}
assert.equal(state.rules.length, enabled ? 2 : 0, 'Durable state must agree with configured enable/delete state');
function ip(args) { const r = spawnSync('ip', ['-j', '-4', ...args], { encoding: 'utf8' }); if (r.status !== 0 && /FIB table does not exist/.test(r.stderr)) return []; assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); }
async function until(check, label) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 100)); } assert.fail(label); }
const source = group.sources[0].split('/')[0], oldSource = previous?.groups[0].sources[0].split('/')[0];
await until(() => { const routes = ip(['route', 'show', 'table', String(table)]); return enabled ? routes.some(r => r.dst === 'default' && r.gateway === group.egressAddress) && routes.some(r => r.type === 'blackhole' && r.dst === '198.51.100.0/24') : routes.length === 0; }, 'Native kernel table must match enabled state and contain copied internal route');
const rules = ip(['rule', 'show']);
assert.equal(rules.some(r => Number(r.table) === table && r.src.split('/')[0] === source), enabled);
if (oldSource && oldSource !== source) assert.equal(rules.some(r => Number(r.table) === table && r.src.split('/')[0] === oldSource), false);
assert.equal(rules.some(r => r.dst?.split('/')[0] === group.egressAddress && (r.table === 'main' || Number(r.table) === 254)), enabled);
if (enabled) {
 const route = ip(['route', 'get', '1.1.1.1', 'from', source])[0]; assert.equal(Number(route.table), table); assert.equal(route.gateway, group.egressAddress);
 const bird = spawnSync('birdc', ['-s', '/run/bird/bird.ctl', 'show', 'route', 'table', tableName, 'all'], { encoding: 'utf8' }); assert.equal(bird.status, 0, bird.stderr); assert.match(bird.stdout, /0\.0\.0\.0\/0/); assert.match(bird.stdout, /198\.51\.100\.0\/24/);
}
console.log(`PASS: native BIRD table, Linux routes, source/gateway rules, ${enabled ? 'source route lookup via selected gateway and copied internal prefix' : 'complete disable/delete cleanup'}`);
