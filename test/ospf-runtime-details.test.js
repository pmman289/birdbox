import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOspfProtocolRuntime } from '../src/ospf-runtime-details.js';
import { configureAgentBroker, inspectOspfRuntime } from '../src/bird.js';
test('OSPF protocol state is independent of neighbors and isolates Areas from other protocol blocks', () => {
 const raw = '1002-core_v2 OSPF master4 up 00:00 Running\n1006-  Number of areas: 1\n  Area 0.0.0.0 (0)\n    Interfaces: 2\n    Neighbors: 0\n    Adjacent neighbors: 0\ncore_v3 OSPF master6 down 00:00\n  Area 0.0.0.3 (3)\n    Interfaces: 1\n';
 const v2 = parseOspfProtocolRuntime(raw, 'core_v2'); assert.equal(v2.state, 'up'); assert.equal(v2.areas.length, 1); assert.equal(v2.areas[0].neighbors, 0); assert.equal(v2.areas[0].interfaces, 2); assert.equal(v2.areas[0].area, '0.0.0.0');
 const v3 = parseOspfProtocolRuntime(raw, 'core_v3'); assert.equal(v3.state, 'down'); assert.equal(v3.areas[0].area, '0.0.0.3'); assert.equal(v3.areas[0].adjacentNeighbors, null);
 assert.equal(parseOspfProtocolRuntime(raw, 'missing').state, 'not_configured');
 assert.equal(parseOspfProtocolRuntime('core_v2 OSPF master4 down 00:00 administratively disabled', 'core_v2').state, 'disabled');
});

test('Native show ospf output isolates named Area blocks, parses zeros/types and retains missing counters as unknown', () => {
 const raw = '1002-core_v2 OSPF master4 up 00:00 Alone\n';
 const output = 'other:\nNumber of areas: 1\n Area: 0.0.0.99 (99)\ncore_v2:\nNumber of areas: 2\n\tArea: 0.0.0.0 (0) [BACKBONE]\n\t\tStub: No\n\t\tNSSA: No\n\t\tNumber of interfaces: 2\n\t\tNumber of neighbors: 0\n\t\tNumber of adjacent neighbors: 0\n\tArea: 0.0.0.1 (1)\n\t\tStub: No\n\t\tNSSA: Yes\n\t\tNumber of interfaces: 1\nnext:\nNumber of areas: 1\n Area: 0.0.0.2 (2)';
 const parsed = parseOspfProtocolRuntime(raw, 'core_v2', { ok: true, output });
 assert.equal(parsed.state, 'up'); assert.equal(parsed.areasAvailable, true); assert.equal(parsed.areaError, null);
 assert.deepEqual(parsed.areas.map(a => [a.area, a.type, a.interfaces, a.neighbors, a.adjacentNeighbors]), [['0.0.0.0', 'normal', 2, 0, 0], ['0.0.0.1', 'nssa', 1, null, null]]);
 const empty = parseOspfProtocolRuntime(raw, 'core_v2', { ok: true, output: 'core_v2:\nNumber of areas: 0\n' });
 assert.equal(empty.areasAvailable, true); assert.deepEqual(empty.areas, []);
 const incomplete = parseOspfProtocolRuntime(raw, 'core_v2', { ok: true, output: 'core_v2:\nNumber of areas: 2\n Area: 0.0.0.0 (0)\n' });
 assert.equal(incomplete.areasAvailable, false); assert.match(incomplete.areaError, /不完整/);
 const old = parseOspfProtocolRuntime(raw, 'core_v2'); assert.equal(old.areasAvailable, false); assert.match(old.areaError, /升级 Agent/);
 const failed = parseOspfProtocolRuntime(raw, 'core_v2', { ok: false, output: 'query timed out' }); assert.equal(failed.state, 'up'); assert.equal(failed.areaError, 'query timed out');
});

test('OSPF Agent protocol/state extension keeps version errors isolated and supports old Agents', async t => {
 const node = { id: 'node', name: 'Node', transport: 'agent', routerId: '192.0.2.1', deploymentMode: 'include', mainConfigPath: '/etc/bird.conf', generatedConfigPath: '/var/lib/birdbox/generated.conf', socketPath: '/run/bird.ctl' };
 let mode = 'current'; const requests = [];
 configureAgentBroker({ async dispatch(_nodeId, method, params) {
  requests.push({ method, params });
  if (method === 'bird.ospf') return { ok: true, stdout: '', stderr: '' };
  const name = params.protocolName;
  const raw = `1002-${name} OSPF master4 up 00:00 Alone\n`;
  const state = mode === 'old' ? '' : mode === 'malformed' ? '\n---BIRDBOX-OSPF-STATE---\nbroken' : `\n---BIRDBOX-OSPF-STATE---\nstatus=${mode === 'failed' && name === 'v3' ? '1\nquery failed' : `0\n${name}:\nNumber of areas: 1\n Area: ${name === 'v2' ? '0.0.0.0' : '0.0.0.3'} (0)\n  Number of interfaces: 1\n  Number of neighbors: 0\n  Number of adjacent neighbors: 0`}\n`;
  return { ok: true, stdout: raw + state, stderr: '' };
 } });
 t.after(() => configureAgentBroker(null));
 let runtime = await inspectOspfRuntime(node, { v2: 'v2', v3: 'v3' });
 assert.equal(runtime.reachable, true); assert.equal(runtime.v2.protocol.state, 'up'); assert.equal(runtime.v2.protocol.areas[0].neighbors, 0);
 assert.equal(runtime.v3.protocol.areas[0].area, '0.0.0.3'); assert.ok(requests.filter(r => r.method === 'bird.protocol').every(r => r.params.ospfState === true));
 mode = 'failed'; runtime = await inspectOspfRuntime(node, { v2: 'v2', v3: 'v3' });
 assert.equal(runtime.v2.protocol.areasAvailable, true); assert.equal(runtime.v3.protocol.state, 'up'); assert.equal(runtime.v3.protocol.areaError, 'query failed');
 mode = 'old'; runtime = await inspectOspfRuntime(node, { v2: 'v2', v3: 'v3' }); assert.equal(runtime.v2.protocol.state, 'up'); assert.match(runtime.v2.protocol.areaError, /升级 Agent/);
 mode = 'malformed'; runtime = await inspectOspfRuntime(node, { v2: 'v2', v3: 'v3' }); assert.match(runtime.v2.protocol.areaError, /状态标记不完整/);
});
