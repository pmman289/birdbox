/** Isolated OSPF acceptance demo: real HTTP/services, in-memory simulated Agents. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentBroker } from '../src/agent-broker.js';
import { validateInventory } from '../src/bird.js';
import { ospfProtocolName } from '../src/ospf.js';

const fixturePath = fileURLToPath(new URL('./fixtures/ospf-demo.json', import.meta.url));
const inventory = validateInventory(JSON.parse(await fs.readFile(fixturePath, 'utf8')));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'birdbox-ospf-demo-'));
await fs.writeFile(path.join(dataDir, 'inventory.json'), JSON.stringify(inventory));
const nodeIds = new Set(inventory.nodes.map(node => node.id));
const active = new Map<string, string>();
const rollback = new Map<string, string>();
const interfaces: Record<string, string[]> = {
  core_a: ['lo', 'eth1', 'eth2', 'lab_eth1'],
  core_b: ['lo', 'eth1', 'eth2', 'eth3', 'lab_eth1', 'lab_eth2'],
  edge_c: ['lo', 'wan0', 'lab_wan0'],
};
const password = 'demo-admin-password';
const port = Number(process.env.BIRDBOX_DEMO_PORT ?? 31000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BIRDBOX_DEMO_PORT 无效');

// Force isolation even when a production environment was inherited.
process.env.NODE_ENV = 'test';
process.env.BIRDBOX_DATABASE_URL = 'memory:';
process.env.BIRDBOX_DATA_DIR = dataDir;
process.env.BIRDBOX_NODES_FILE = path.join(dataDir, 'no-production-nodes.json');
process.env.BIRDBOX_HOST = '127.0.0.1';
process.env.BIRDBOX_PORT = String(port);
process.env.BIRDBOX_PUBLIC_URL = `http://127.0.0.1:${port}`;
process.env.BIRDBOX_SECURE_COOKIE = 'false';
process.env.BIRDBOX_SETUP_TOKEN = '';
process.env.BIRDBOX_SSH_KEY_PATH = path.join(dataDir, 'ssh/id_ed25519');
process.env.BIRDBOX_KNOWN_HOSTS_PATH = path.join(dataDir, 'ssh/known_hosts');


function routes(nodeId: string, v3: boolean, protocol: string): string {
  const prefix = v3 ? '2001:db8:10::/48' : '198.51.100.0/24';
  const next = nodeId === 'core_a' ? '10.10.0.12' : '10.10.0.13';
  const iface = nodeId === 'core_a' ? 'eth1' : 'eth2';
  return `${prefix} unicast [${protocol} 12:00:00] * I 150\n\t${nodeId === 'edge_c' ? 'dev wan0' : `via ${v3 ? 'fe80::12' : next} on ${iface}`}`;
}
function ospfRuntime(nodeId: string, params: Record<string, unknown>): string {
  const domain = inventory.ospfDomains.find(d => ospfProtocolName(d, 'ospfv2') === params.v2);
  const config = domain?.nodeConfigs.find(c => c.nodeId === nodeId);
  const v3Enabled = config?.versions.includes('ospfv3') ?? false;
  const peer = nodeId === 'core_a' ? '192.0.2.12' : '192.0.2.11';
  const state = nodeId === 'edge_c' ? 'Init' : 'Full/PtP';
  const neighbor = `${params.v2}:\nRouter ID Pri State DTime Interface Router IP\n${peer} 1 ${state} 31.5 ${nodeId === 'edge_c' ? 'wan0' : 'eth1'} 10.10.0.12\n\n${v3Enabled ? `${params.v3}:\nRouter ID Pri State DTime Interface Router IP\n${peer} 1 Full/PtP 30 eth1 fe80::12` : ''}`;
  return [neighbor, '---BIRDBOX-OSPF-V2-COUNT---', '1 of 1 routes for 1 networks',
    '---BIRDBOX-OSPF-V2-ROUTES---', routes(nodeId, false, String(params.v2)),
    '---BIRDBOX-OSPF-V3-COUNT---', v3Enabled ? '1 of 1 routes for 1 networks' : 'CF_SYM_UNDEFINED',
    '---BIRDBOX-OSPF-V3-ROUTES---', v3Enabled ? routes(nodeId, true, String(params.v3)) : '',
    '---BIRDBOX-OSPF-INTERFACES---', interfaces[nodeId].join('\n'),
    '---BIRDBOX-OSPF-STATUS---', `neighbors=0\nv2count=0\nv2routes=0\nv3count=${v3Enabled ? 0 : 1}\nv3routes=${v3Enabled ? 0 : 1}\ninterfaces=0`].join('\n');
}
// Never dispatch to a real Agent or execute a shell command in this process.
AgentBroker.prototype.dispatch = async function (nodeId, method, params = {}) {
  const result = (stdout: string, ok = true, stderr = '') => ({taskId:'demo', nodeId, ok, stdout, stderr});
  if (!nodeIds.has(nodeId)) return result('', false, 'Demo 只支持预置的模拟节点');
  if (method === 'system.interfaces') return result(interfaces[nodeId].join('\n'));
  if (method === 'bird.inspect') return result('BIRD version 2.19.2\n---BIRDBOX---\n\n---BIRDBOX-STATUS---\nversion=0\nprotocols=0');
  if (method === 'bird.ospf') return result(ospfRuntime(nodeId, params));
  if (method === 'bird.routes') return result(routes(nodeId, params.table === 'master6', 'birdbox_ospf_ospf_demo_ospfv2'));
  if (method === 'bird.stage') return result('Demo: 配置结构预检通过（模拟 BIRD 语法检查）');
  if (method === 'bird.apply') {
    rollback.set(nodeId, active.get(nodeId) ?? '');
    await new Promise(resolve => setTimeout(resolve, 300));
    active.set(nodeId, String(params.config ?? ''));
    return result('Demo: 已应用到内存中的模拟节点');
  }
  if (method === 'bird.rollback') { active.set(nodeId, rollback.get(nodeId) ?? ''); return result('Demo: 模拟回滚成功'); }
  if (method === 'bird.access' || method === 'bird.protocol_state') return result('Demo: ready');
  return result('', false, `Demo 未模拟 ${method}`);
};

console.log(`\nOSPF Demo: http://127.0.0.1:${port}\n账号 admin / 密码 ${password}\n库存目录 ${dataDir}\n运行态、预检和应用均使用模拟 Agent，修改仅保存在内存。\n`);
await import('../src/server.js');
const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password, confirmation: password }),
});
if (!setup.ok && setup.status !== 409) throw new Error(`Demo 管理员初始化失败：${setup.status}`);
