import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { validateInventory } from '../src/bird.js';
import { configBundleForNode } from '../src/inventory-domain.js';
const binary = process.env.BIRDBOX_TEST_BIRD ?? 'bird';
const available = spawnSync(binary, ['--version'], { encoding: 'utf8' }).status === 0;
test('Native BIRD accepts Direct check-link and Kernel learn/metric/merge/persist/restart, IPv4/IPv6 and split policy configs', { skip: available ? false : 'BIRD binary unavailable' }, async t => {
 const root = process.env.BIRDBOX_SYSTEM_NATIVE_DIR ?? await fs.mkdtemp(path.join(os.tmpdir(), 'birdbox-system-native-'));
 await fs.mkdir(root, { recursive: true }); if (!process.env.BIRDBOX_SYSTEM_NATIVE_DIR) t.after(() => fs.rm(root, { recursive: true, force: true }));
 for (const family of ['dual', 'ipv4', 'ipv6']) {
  const node = { id: 'native', name: 'Native', transport: 'agent', routerId: '192.0.2.1', deploymentMode: 'include', mainConfigPath: `${root}/bird.conf`, generatedConfigPath: `${root}/generated.conf`, socketPath: `${root}/bird.ctl` };
  const resource = { label: 'Native', nodeId: 'native', nodeIds: ['native'], ipv4: family !== 'ipv6', ipv6: family !== 'ipv4', enabled: true };
  const state = validateInventory({ nodes: [node], directProtocols: [{ ...resource, id: 'd', name: 'native_direct', interfaces: ['lo', 'eth*', '-veth*'], checkLink: true }], kernelProtocols: [{ ...resource, id: 'k', name: 'native_kernel', learn: true, persist: true, gracefulRestart: true, metric: 42, mergePaths: 8, scanTime: 30, table: 120, tables: { ipv4: { name: 'native4', source: 'managed' }, ipv6: { name: 'native6', source: 'managed' } }, importPolicies: { ipv4: { mode: 'form', formAction: 'all' }, ipv6: { mode: 'form', formAction: 'none' } }, exportPolicies: { ipv4: { mode: 'krt_prefsrc', prefSrc: '192.0.2.1' }, ipv6: { mode: 'krt_prefsrc', prefSrc: '2001:db8::1' } } }] });
  const bundle = configBundleForNode(state, state.nodes[0]);
  const file = `${root}/${family}.conf`; await fs.writeFile(file, `router id 192.0.2.1;\nprotocol device native_device {}\n${bundle.main}`);
  const result = spawnSync(binary, ['-p', '-c', file], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, `${family}: ${result.stderr || result.stdout}`);
 }
});
