import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { normalizeDefine, renderBirdConfigBundle } from '../src/bird.js';
const binary = process.env.BIRDBOX_TEST_BIRD ?? 'bird';
const available = spawnSync(binary, ['--version'], { encoding: 'utf8' }).status === 0;
test('Generated Define prefix patterns, expression templates and IRR includes pass native BIRD parsing', { skip: available ? false : 'BIRD binary unavailable' }, async t => {
 const root = process.env.BIRDBOX_DEFINE_NATIVE_DIR ?? await fs.mkdtemp(path.join(os.tmpdir(), 'birdbox-define-native-'));
 await fs.mkdir(root, { recursive: true }); if (!process.env.BIRDBOX_DEFINE_NATIVE_DIR) t.after(() => fs.rm(root, { recursive: true, force: true }));
 const node = { id: 'native', name: 'Native', transport: 'agent', routerId: '192.0.2.1', deploymentMode: 'include', mainConfigPath: path.join(root, 'bird.conf'), generatedConfigPath: path.join(root, 'generated.conf'), socketPath: path.join(root, 'bird.ctl') };
 const base = { nodeIds: null, enabled: true };
 const resources = [
  { id: 'v4', label: 'IPv4', name: 'CUSTOMERS4', type: 'cidr4', entries: ['192.0.2.0/24', '198.51.100.0/24+', '203.0.113.0/24{24,28}'] },
  { id: 'v6', label: 'IPv6', name: 'CUSTOMERS6', type: 'cidr6', entries: ['2001:db8::/32+', '2001:db8:100::/48{48,64}'] },
  { id: 'pref', label: 'Integer', name: 'PREF', type: 'expression', value: '150' },
  { id: 'comment', label: 'Commented integer', name: 'COMMENTED_PREF', type: 'expression', value: '150 # Local preference' },
  { id: 'quoted', label: 'Quoted symbol', name: 'QUOTED_PREF', type: 'expression', value: "'PREF' + 1" },
  { id: 'flag', label: 'Boolean', name: 'FLAG', type: 'expression', value: 'true' },
  { id: 'asn', label: 'ASNs', name: 'ASNS', type: 'expression', value: '[64512, 64513]' },
  { id: 'communities', label: 'Communities', name: 'COMMUNITIES', type: 'expression', value: '[(64512, 100), (64512, 200)]' },
  { id: 'irr', label: 'Dynamic', name: 'IRR4', type: 'cidr4', entries: ['198.18.0.0/15'], entrySource: { kind: 'irr-as-set', asSet: 'AS-EXAMPLE', server: 'rr.example', databases: [], refreshIntervalSeconds: 900, prefixLimit: 100, allowMoreSpecific: false } },
 ].map(r => normalizeDefine({ ...base, ...r }));
 const bundle = renderBirdConfigBundle(node, [], [], [], [], resources);
 await fs.mkdir(path.join(root, 'resources'), { recursive: true });
 for (const resource of bundle.resources) await fs.writeFile(path.join(root, 'resources', resource.relativePath), resource.content);
 await fs.writeFile(node.mainConfigPath, `router id 192.0.2.1;\nprotocol device native_device {}\n${bundle.main}\nfunction match_customer() { return net ~ 'CUSTOMERS4'; }\nfilter quoted_customer { if 'match_customer'() then accept; reject; }\n`);
 const parsed = spawnSync(binary, ['-p', '-c', node.mainConfigPath], { encoding: 'utf8', timeout: 10000 });
 assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout); assert.equal(bundle.resources.length, 1);
});
