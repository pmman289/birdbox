/** Isolated Static / Pipe acceptance demo: real HTTP/services, in-memory simulated Agents. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { BlockList } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentBroker } from '../src/agent-broker.js';
import { validateInventory, normalizeIbgpDomain, expandIbgpDomain } from '../src/bird.js';
import { InventoryStore } from '../src/store.js';
import { ospfProtocolName } from '../src/ospf.js';
import { restoreSecretPlaceholders } from '../src/inventory-redaction.js';
import { sourcePolicyManagedRulesForNode, sourcePolicyNames, sourcePolicyForNode } from '../src/bird-source-policy.js';

const fixturePath = fileURLToPath(new URL('./fixtures/ospf-demo.json', import.meta.url));
const seed = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
seed.version = 31;
const policy = (formAction: string) => ({ mode: 'form', formAction, steps: [], filterId: null });
const hop = (address: string | null, iface = 'eth1', extra = {}) => ({ address, interface: iface, weight: 1, bfd: false, onlink: false, ...extra });
const route = (id: string, prefix: string, extra = {}) => ({ id, prefix, type: 'blackhole', enabled: true, ...extra });
seed.filters = [{ id: 'demo_static_filter', name: 'demo_static_import', label: 'Static · 接收并设置 Local Pref', nodeIds: ['core_a'], source: 'filter demo_static_import { bgp_local_pref = 177; bgp_community.add((64512,17)); accept; }', enabled: true }];
seed.defines.push({ id: 'demo_static_prefixes', name: 'demo_static_prefixes', label: 'Static · 批量业务网段', nodeIds: ['core_a'], type: 'cidr4', enabled: true, entries: ['198.19.1.0/24', '198.19.2.0/24', '198.19.3.0/24', '198.19.4.0/24'] });
seed.staticProtocols = [
  { id: 'demo_static4', nodeId: 'core_a', name: 'demo_static4', label: 'IPv4 业务路由 · ECMP / 递归 / 黑洞', family: 'ipv4', table: { name: 'business4', source: 'managed' }, igpTable: 'master4', checkLink: true,
    importPolicy: { mode: 'custom', filterId: 'demo_static_filter' }, routes: [
      route('ecmp', '198.51.100.0/24', { type: 'via', nextHops: [hop('10.10.0.12', 'eth1', { weight: 2 }), hop('10.10.0.13', 'eth2', { weight: 3 })] }),
      route('backup', '198.51.100.0/24', { filter: { operations: [{ type: 'set', attribute: 'preference', value: 100 }], custom: '' } }),
      route('recursive', '203.0.113.0/24', { type: 'recursive', recursiveVia: '10.10.0.12' }),
      route('interface', '192.0.2.0/24', { type: 'via', nextHops: [hop(null)] }),
      route('blackhole', '198.18.0.0/24'),
      route('onlink', '198.18.1.0/24', { type: 'via', nextHops: [hop('10.10.0.99', 'eth2', { onlink: true })] }),
      route('bfd', '198.18.2.0/24', { type: 'via', nextHops: [hop('10.10.0.100', 'eth2', { bfd: true })] }),
    ], enabled: true },
  { id: 'demo_static6', nodeId: 'core_a', name: 'demo_static6', label: 'IPv6 业务路由 · Link-local / ECMP', family: 'ipv6', table: { name: 'business6', source: 'managed' }, igpTable: 'master6', routes: [
    route('v6_ecmp', '2001:db8:100::/48', { type: 'via', nextHops: [hop('fe80::12'), hop('fe80::13', 'eth2', { weight: 2 })] }),
    route('v6_blackhole', '2001:db8:200::/48'),
    route('v6_prohibit', '2001:db8:300::/48', { type: 'prohibit' }),
  ], enabled: true },
  { id: 'demo_static_define', nodeId: 'core_a', name: 'demo_static_define', label: '统一路由编辑 · Define + 直接添加', family: 'ipv4', defineId: 'demo_static_prefixes', action: { type: 'via', nextHops: [hop('10.10.0.12')] }, routeActions: {
    '198.19.1.0/24': { type: 'via', nextHops: [hop('10.10.0.12', 'eth1', { weight: 2 }), hop('10.10.0.13', 'eth2', { weight: 3 })] },
    '198.19.2.0/24': { type: 'recursive', recursiveVia: '10.10.0.12' },
    '198.19.3.0/24': { type: 'via', nextHops: [hop(null)] },
    '198.19.4.0/24': { type: 'blackhole', enabled: false },
  }, routeFilters: { '198.19.1.0/24': { operations: [{ type: 'set', attribute: 'preference', value: 175 }], custom: 'ospf_metric1 = 30;' } }, routes: [route('manual', '198.19.100.0/24')], enabled: true },
  { id: 'demo_static_disabled', nodeId: 'edge_c', name: 'demo_static_disabled', label: '维护示例 · 已停用', family: 'ipv4', routes: [route('maintenance', '198.18.99.0/24', { type: 'unreachable' })], enabled: false },
];
// Enough varied resources to accept filtering and pagination without production nodes.
seed.staticProtocols.push(...Array.from({ length: 28 }, (_, offset) => {
  const i = offset + 1, ipv6 = i % 4 === 0;
  return { id: `demo_list_static_${i}`, name: `demo_list_static_${i}`, label: `${['香港', '东京', '新加坡'][offset % 3]}业务网段 ${String(i).padStart(2, '0')}`, nodeId: ['core_a', 'core_b', 'edge_c'][offset % 3], family: ipv6 ? 'ipv6' : 'ipv4', enabled: i % 5 !== 0, routes: [route(`list_route_${i}`, ipv6 ? `2001:db8:${400 + i}::/48` : `198.20.${i}.0/24`)] };
}));
seed.pipeProtocols = ['4', '6'].map(n => ({ id: `demo_pipe${n}`, name: `demo_pipe${n}`, label: `IPv${n} 业务表 → 主表（单向）`, nodeIds: ['core_a'], family: n === '4' ? 'ipv4' : 'ipv6', table: { name: `business${n}`, source: 'existing' }, peerTable: { name: `master${n}`, source: 'existing' }, importPolicy: policy('none'), exportPolicy: policy('all'), enabled: true }));
// Optional local snapshot preserves acceptance edits when restarting the demo.
let inventory = validateInventory(process.env.BIRDBOX_DEMO_INVENTORY ? restoreSecretPlaceholders(JSON.parse(await fs.readFile(process.env.BIRDBOX_DEMO_INVENTORY, 'utf8')), seed) : seed);
const defineSamples = [
  { id: 'demo_define_preference', name: 'DEMO_LOCAL_PREF', label: '策略常量 · Local Preference', nodeIds: null, type: 'expression', value: '150', enabled: true },
  { id: 'demo_define_irr_snapshot', name: 'DEMO_IRR_SNAPSHOT', label: 'IRR 快照 · 同步异常示例（已停用）', nodeIds: ['core_a'], type: 'cidr4', enabled: false, entries: ['198.18.200.0/24', '198.18.201.0/24'],
    entrySource: { kind: 'irr-as-set', asSet: 'AS-EXAMPLE', server: 'rr.example', databases: [], refreshIntervalSeconds: 86400, prefixLimit: 10000, allowMoreSpecific: false },
    sync: { status: 'error', lastSuccessAt: '2026-10-18T00:00:00.000Z', error: '示例数据：同步异常时保留旧快照；此资源已停用，不进行自动刷新。' } },
];
inventory = validateInventory({ ...inventory, defines: [...inventory.defines, ...defineSamples.filter(sample => !inventory.defines.some(existing => existing.id === sample.id))] });
const sourceSamples = [{ id: 'demo_source_business', label: '源地址出口 · 多组 / 内部路由', nodeIds: ['core_a'], groups: [
  { id: 'demo_source_primary', egressAddress: '10.10.0.12', sources: ['198.18.210.0/24'], kernelTable: 51000, ruleSlot: 0 },
  { id: 'demo_source_backup', egressAddress: '10.10.0.13', sources: ['198.18.211.0/24'], kernelTable: 51001, ruleSlot: 1 },
], rulePriorityBase: 10000, copyInternalRoutes: true, internalDefineIds: ['demo_static_prefixes'], enabled: true }];
inventory = validateInventory({ ...inventory, sourcePolicies: [...inventory.sourcePolicies, ...sourceSamples.filter(sample => !inventory.sourcePolicies.some(existing => existing.id === sample.id))] });
const ebgpPeers = [
  { id: 'demo_ebgp_peer_a', nodeId: 'core_a', name: '上联示例 · 双栈正常', address: '10.10.0.99', asn: 64513, port: 179 },
  { id: 'demo_ebgp_peer_b', nodeId: 'core_b', name: '备用上联 · 未建立', address: '10.10.0.98', asn: 64514, port: 179 },
];
inventory = validateInventory({ ...inventory,
  peers: [...inventory.peers, ...ebgpPeers.filter(p => !inventory.peers.some(existing => existing.id === p.id))],
  sessions: [...inventory.sessions, ...ebgpPeers.map((p, i) => ({ id: `demo_ebgp_session_${i}`, peerId: p.id, nodeId: p.nodeId, protocolName: `demo_ebgp_${i}`, localAddress: i === 0 ? '10.10.0.11' : '10.10.0.12', localAsn: 64512, localPort: 179, enabled: true })).filter(s => !inventory.sessions.some(existing => existing.id === s.id))],
});
if (!inventory.ibgpDomains.some(domain => domain.id === 'demo_ibgp_core')) {
  const domain = normalizeIbgpDomain({ id: 'demo_ibgp_core', name: '核心互联 · 双端独立配置', asn: 64512,
    members: [{ nodeId: 'core_a', address: '10.10.0.11' }, { nodeId: 'core_b', address: '10.10.0.12' }],
    adjacencies: [{ id: 'demo_ibgp_pair', leftNodeId: 'core_a', rightNodeId: 'core_b', leftSessionId: 'demo_ibgp_left', rightSessionId: 'demo_ibgp_right' }],
    layout: { core_a: { x: 36, y: 40 }, core_b: { x: 226, y: 40 } } });
  const expanded = expandIbgpDomain(domain, inventory.nodes);
  expanded.sessions[0]!.bgp.rrClient = true;
  expanded.sessions[0]!.bgp.rrClusterId = '192.0.2.11';
  inventory = validateInventory({ ...inventory, ibgpDomains: [...inventory.ibgpDomains, domain], peers: [...inventory.peers, ...expanded.peers], sessions: [...inventory.sessions, ...expanded.sessions] });
}
const directSamples = [
  { id: 'demo_direct_lan', label: '直连网段 · 双栈接口学习', name: 'demo_direct_lan', nodeId: 'core_a', interfaces: ['eth1', 'eth2'], ipv4: true, ipv6: true, checkLink: true, enabled: true },
];
const kernelSamples = [
  { id: 'demo_kernel_business', label: 'Linux 同步 · 双栈独立导出', name: 'demo_kernel_business', nodeIds: ['core_a', 'core_b'], ipv4: true, ipv6: true, table: 120, scanTime: 30, learn: false, metric: 100, mergePaths: 8, gracefulRestart: true, persist: true, importPolicy: policy('none'), exportPolicies: { ipv4: { mode: 'krt_prefsrc', prefSrc: '10.10.0.11', policy: policy('all') }, ipv6: { mode: 'visual', prefSrc: null, policy: policy('all') } }, enabled: true },
];
inventory = validateInventory({ ...inventory, directProtocols: [...inventory.directProtocols, ...directSamples.filter(sample => !inventory.directProtocols.some(existing => existing.id === sample.id))], kernelProtocols: [...inventory.kernelProtocols, ...kernelSamples.filter(sample => !inventory.kernelProtocols.some(existing => existing.id === sample.id))] });
const rpkiSamples = [
  { id: 'demo_rpki_rtr', name: 'demo_rpki_rtr', label: 'RPKI-RTR · 双栈缓存与异常连接', nodeIds: ['core_a', 'core_b'], sourceType: 'server', roa4Table: 'DEMO_RTR4', roa6Table: 'DEMO_RTR6', remote: '192.0.2.100', port: 323, minVersion: 1, maxVersion: 1, enabled: true },
  { id: 'demo_rpki_file', name: 'demo_rpki_file', label: '本地 ROA · 文件与双栈表', nodeIds: ['core_a'], sourceType: 'file', roa4Table: 'DEMO_FILE4', roa6Table: 'DEMO_FILE6', file4: '/etc/bird/demo-roa4.conf', file6: '/etc/bird/demo-roa6.conf', enabled: true },
  { id: 'demo_rpki_disabled', name: 'demo_rpki_disabled', label: 'RPKI · 维护停用示例', nodeIds: ['edge_c'], sourceType: 'server', roa4Table: 'DEMO_MAINT4', remote: '192.0.2.101', enabled: false },
];
inventory = validateInventory({ ...inventory, rpki: [...inventory.rpki, ...rpkiSamples.filter(sample => !inventory.rpki.some(existing => existing.id === sample.id))] });
// Runtime reads follow committed demo inventory, including edits made in the browser.
const readInventory = InventoryStore.prototype.read;
InventoryStore.prototype.read = async function () { inventory = await readInventory.call(this); return inventory; };
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'birdbox-static-demo-'));
await fs.writeFile(path.join(dataDir, 'inventory.json'), JSON.stringify(inventory));
const nodeIds = new Set(inventory.nodes.map(node => node.id));
const active = new Map<string, string>();
const systemRules = new Map<string, unknown[]>();
const rollback = new Map<string, string>();
const interfaces: Record<string, string[]> = {
  core_a: ['lo', 'eth1', 'eth2', 'lab_eth1'],
  core_b: ['lo', 'eth1', 'eth2', 'eth3', 'lab_eth1', 'lab_eth2'],
  edge_c: ['lo', 'wan0', 'lab_wan0'],
};
const password = process.env.BIRDBOX_DEMO_PASSWORD ?? 'demo-admin-password';
const port = Number(process.env.BIRDBOX_DEMO_PORT ?? 31000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BIRDBOX_DEMO_PORT 无效');
const host = process.env.BIRDBOX_DEMO_HOST ?? '127.0.0.1';
const publicUrl = process.env.BIRDBOX_DEMO_PUBLIC_URL ?? `http://127.0.0.1:${port}`;

// Force isolation even when a production environment was inherited.
process.env.NODE_ENV = 'test';
process.env.BIRDBOX_DATABASE_URL = 'memory:';
process.env.BIRDBOX_DATA_DIR = dataDir;
process.env.BIRDBOX_NODES_FILE = path.join(dataDir, 'no-production-nodes.json');
process.env.BIRDBOX_HOST = host;
process.env.BIRDBOX_PORT = String(port);
process.env.BIRDBOX_PUBLIC_URL = publicUrl;
process.env.BIRDBOX_SECURE_COOKIE = String(new URL(publicUrl).protocol === 'https:');
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
  const v2Enabled = Boolean(config?.enabled && config.versions.includes('ospfv2'));
  const v3Enabled = Boolean(config?.enabled && config.versions.includes('ospfv3'));
  const peer = nodeId === 'core_a' ? '192.0.2.12' : '192.0.2.11';
  const state = nodeId === 'edge_c' ? 'Init' : 'Full/PtP';
  const neighbor = [v2Enabled ? `${params.v2}:\nRouter ID Pri State DTime Interface Router IP\n${peer} 1 ${state} 31.5 ${nodeId === 'edge_c' ? 'wan0' : 'eth1'} 10.10.0.12` : '', v3Enabled ? `${params.v3}:\nRouter ID Pri State DTime Interface Router IP\n${peer} 1 Full/PtP 30 eth1 fe80::12` : ''].filter(Boolean).join('\n\n');
  return [neighbor, '---BIRDBOX-OSPF-V2-COUNT---', v2Enabled ? '1 of 1 routes for 1 networks' : 'CF_SYM_UNDEFINED',
    '---BIRDBOX-OSPF-V2-ROUTES---', v2Enabled ? routes(nodeId, false, String(params.v2)) : '',
    '---BIRDBOX-OSPF-V3-COUNT---', v3Enabled ? '1 of 1 routes for 1 networks' : 'CF_SYM_UNDEFINED',
    '---BIRDBOX-OSPF-V3-ROUTES---', v3Enabled ? routes(nodeId, true, String(params.v3)) : '',
    '---BIRDBOX-OSPF-INTERFACES---', interfaces[nodeId].join('\n'),
    '---BIRDBOX-OSPF-STATUS---', `neighbors=0\nv2count=${v2Enabled ? 0 : 1}\nv2routes=${v2Enabled ? 0 : 1}\nv3count=${v3Enabled ? 0 : 1}\nv3routes=${v3Enabled ? 0 : 1}\ninterfaces=0`].join('\n');
}
function sourceGroups(nodeId: string) {
  const node = inventory.nodes.find(n => n.id === nodeId)!;
  return inventory.sourcePolicies.filter(r => r.enabled && (!r.nodeIds || r.nodeIds.includes(nodeId))).flatMap(resource => (sourcePolicyForNode(resource, node)?.groups ?? []).map(group => ({ resource, group, names: sourcePolicyNames(resource, group) })));
}
function sourceKernelRoutes(item: ReturnType<typeof sourceGroups>[number]) {
  return [{ dst: 'default', gateway: item.group.egressAddress, dev: 'eth1' }, ...(item.resource.copyInternalRoutes ? item.resource.internalDefineIds.flatMap(id => {
    const define = inventory.defines.find(d => d.id === id);
    return define && define.type !== 'expression' ? define.entries.filter(prefix => /^[0-9.]+\/\d+$/.test(prefix)).map(dst => ({ dst, type: 'blackhole' })) : [];
  }) : [])];
}
function protocolDetails(nodeId: string, name: string, includeOspfState = false): string {
  for (const domain of inventory.ospfDomains) {
    const config = domain.nodeConfigs.find(c => c.nodeId === nodeId);
    if (!config?.enabled) continue;
    const version = config.versions.find(v => ospfProtocolName(domain, v) === name);
    if (!version) continue;
    const links = domain.links.filter(l => l.fromNodeId === nodeId || l.toNodeId === nodeId);
    const areaIds = [...new Set([...links.map(l => l.area), ...Object.keys(config.areaOptions)])];
    const areas = areaIds.map(area => {
      const options = config.areaOptions[area], count = links.filter(l => l.area === area).length;
      const neighbors = nodeId === 'edge_c' ? 0 : count;
      return ` Area: ${area}\n  Stub: ${options?.stub ? 'Yes' : 'No'}\n  NSSA: ${options?.nssa ? 'Yes' : 'No'}\n  Number of interfaces: ${count}\n  Number of neighbors: ${neighbors}\n  Number of adjacent neighbors: ${neighbors}`;
    }).join('\n');
    return `1002-${name} OSPF ${version === 'ospfv2' ? 'master4' : 'master6'} up 12:00 Running\n  Router ID: ${config.routerId}${includeOspfState ? `\n---BIRDBOX-OSPF-STATE---\nstatus=0\n${name}:\nNumber of areas: ${areaIds.length}\n${areas}` : ''}`;
  }
  const bgp = inventory.sessions.find(s => s.enabled && s.nodeId === nodeId && s.protocolName === name);
  if (bgp) {
    const peer = inventory.peers.find(p => p.id === bgp.peerId)!;
    const established = bgp.managedBy?.kind === 'ibgp-domain' || nodeId !== 'core_b';
    return `1002-${name} BGP --- ${established ? 'up' : 'start'} 12:00 ${established ? 'Established' : 'Active'}\n1006-  BGP state: ${established ? 'Established' : 'Active'}\n    Neighbor address: ${peer.address}\n    Neighbor AS: ${peer.asn}\n    Local AS: ${bgp.localAsn}\n${(['ipv4', 'ipv6'] as const).filter(f => bgp.channels[f].enabled).map(f => `  Channel ${f}\n    State: ${established ? 'UP' : 'DOWN'}\n    Table: ${f === 'ipv4' ? 'master4' : 'master6'}\n    Routes: ${established ? 1 : 0} imported, 0 exported`).join('\n')}`;
  }
  const rpki = inventory.rpki.find(p => p.enabled && (!p.nodeIds || p.nodeIds.includes(nodeId)) && (p.sourceType === 'server' ? p.name === name : [p.roa4Table ? p.name + '_v4' : '', p.roa6Table ? p.name + '_v6' : ''].includes(name)));
  if (rpki) {
    const failed = rpki.sourceType === 'server' && nodeId === 'core_b';
    const channels = [rpki.roa4Table && (rpki.sourceType === 'server' || name.endsWith('_v4')) ? ['roa4', rpki.roa4Table] : null, rpki.roa6Table && (rpki.sourceType === 'server' || name.endsWith('_v6')) ? ['roa6', rpki.roa6Table] : null].filter((entry): entry is string[] => entry !== null);
    return `1002-${name} ${rpki.sourceType === 'server' ? 'RPKI' : 'Static'} --- ${failed ? 'start' : 'up'} 12:00\n${rpki.sourceType === 'server' ? `1006-  Status: ${failed ? 'Transport-Error' : 'Established'}\n` : ''}${channels.map(([channel, table]) => `  Channel ${channel}\n    State: ${failed ? 'DOWN' : 'UP'}\n    Table: ${table}\n    Routes: 1 imported, 0 exported`).join('\n')}`;
  }
  const item = inventory.staticProtocols.find(s => s.nodeId === nodeId && s.name === name);
  if (item?.enabled) return `1002-${name} Static ${item.table.name} up 12:00\n1006-  Channel ${item.family}\n    Table: ${item.table.name}\n    Routes: ${routeCount(staticRoutes(nodeId, { table: item.table.name, protocolName: name }))} imported, 0 exported`;
  const pipe = inventory.pipeProtocols.find(p => p.name === name && (!p.nodeIds || p.nodeIds.includes(nodeId)));
  if (pipe?.enabled) return `1002-${name} Pipe --- up 12:00\n1006-  Channel main\n    Table: ${pipe.table.name}\n    Peer table: ${pipe.peerTable.name}\n    Routes: 0 imported, ${routeCount(staticRoutes(nodeId, { table: pipe.table.name }))} exported`;
  const direct = inventory.directProtocols.find(p => p.enabled && p.nodeId === nodeId && p.name === name);
  if (direct) return `1002-${name} Direct --- up 12:00\n1006-  Channel ipv4\n    Table: master4\n    Routes: 2 imported, 0 exported\n1006-  Channel ipv6\n    Table: master6\n    Routes: 1 imported, 0 exported`;
  const kernel = inventory.kernelProtocols.find(p => p.enabled && (!p.nodeIds || p.nodeIds.includes(nodeId)) && (p.ipv4 && p.ipv6 ? [p.name + '4', p.name + '6'].includes(name) : p.name === name));
  if (kernel) { const family = kernel.ipv4 && kernel.ipv6 ? name === kernel.name + '6' ? 'ipv6' : 'ipv4' : kernel.ipv6 ? 'ipv6' : 'ipv4'; const table = kernel.tables?.[family]?.name ?? (family === 'ipv6' ? 'master6' : 'master4'); return `1002-${name} Kernel ${table} up 12:00\n1006-  Channel ${family}\n    Table: ${table}\n    Routes: 0 imported, 3 exported`; }
  const source = sourceGroups(nodeId).find(item => [item.names.staticProtocol, item.names.kernelProtocol, item.names.pipe].includes(name));
  if (source) { const kind = name === source.names.staticProtocol ? 'Static' : name === source.names.kernelProtocol ? 'Kernel' : 'Pipe'; return `1002-${name} ${kind} ${source.names.table} up 12:00\n1006-  Channel ipv4\n    Table: ${source.names.table}\n    Routes: 1 imported, 1 exported`; }
  return '8003 No such protocol';
}
function routeCount(output: string): number { return (output.match(/^\S+\/\d+ /gm) ?? []).length; }
function matchesTarget(prefix: string, target: unknown): boolean {
  if (!target || prefix === target) return true;
  const [network, bits] = prefix.split('/');
  const family = network!.includes(':') ? 'ipv6' : 'ipv4';
  try { const list = new BlockList(); list.addSubnet(network!, Number(bits), family); return list.check(String(target), family); } catch { return false; }
}
function systemRoutes(nodeId: string, params: Record<string, unknown>): string | null {
  const name = String(params.protocolName ?? '');
  const direct = inventory.directProtocols.find(p => p.enabled && p.nodeId === nodeId && p.name === name);
  const kernel = inventory.kernelProtocols.find(p => p.enabled && (!p.nodeIds || p.nodeIds.includes(nodeId)) && (p.ipv4 && p.ipv6 ? [p.name + '4', p.name + '6'].includes(name) : p.name === name));
  if (!direct && !kernel) return null;
  const family6 = kernel ? kernel.tables?.ipv6?.name === params.table : params.table === 'master6', prefixes = family6 ? ['2001:db8:10::/64'] : ['10.10.0.0/24', '192.0.2.0/24'];
  if (kernel && params.direction === 'import') return '';
  return prefixes.filter(prefix => matchesTarget(prefix, params.target)).map(prefix => `${prefix} dev eth1 [${direct ? name : 'demo_static4'} 12:00:00] * (240)\n    Type: device univ`).join('\n');
}
function staticRoutes(nodeId: string, params: Record<string, unknown>): string {
  const table = String(params.table ?? 'master4');
  const protocol = params.protocolName;
  const sources = inventory.staticProtocols.filter(s => s.nodeId === nodeId && s.enabled && (!protocol || s.name === protocol) && (s.table.name === table || inventory.pipeProtocols.some(p => p.enabled && (!p.nodeIds || p.nodeIds.includes(nodeId)) && p.table.name === s.table.name && p.peerTable.name === table && p.exportPolicy.formAction !== 'none')));
  const blocks = sources.flatMap(s => {
    const entries = [...(inventory.defines.find(d => d.id === s.defineId)?.entries ?? []).filter(prefix => /^[0-9a-f:.]+\/\d+$/i.test(prefix)).map((prefix, i) => {
      const action = s.routeActions[prefix] ?? s.action ?? 'blackhole';
      const forwarding = typeof action !== 'string' ? action : { type: action.startsWith('via ') ? 'via' : action === 'reject' ? 'unreachable' : action, nextHops: action.startsWith('via ') ? [hop(action.slice(4))] : [], recursiveVia: null, enabled: true };
      return { ...route(`define_${i}`, prefix), nextHops: [], recursiveVia: null, ...forwarding, filter: s.routeFilters[prefix] ?? { operations: [], custom: '' } };
    }), ...s.routes];
    return entries.filter(r => r.enabled && !r.nextHops.some(h => h.bfd)).filter(r => matchesTarget(r.prefix, params.target)).map(r => {
      const kind = r.type === 'via' || r.type === 'recursive' ? 'unicast' : r.type;
      const hops = r.nextHops.map(h => h.address ? `    via ${h.address} on ${h.interface ?? 'eth1'} weight ${h.weight}` : `    dev ${h.interface}`).join('\n');
      const recursive = r.recursiveVia ? `    via ${r.recursiveVia} on eth1` : '';
      const preference = r.filter.operations.find(op => op.type === 'set' && op.attribute === 'preference');
      return `${r.prefix} ${kind} [${s.name} 12:00:00] * (${preference?.type === 'set' ? preference.value : 200})\n${hops || recursive}\n    Type: static univ${s.id === 'demo_static4' ? '\n    BGP.local_pref: 177\n    BGP.community: (64512,17)' : ''}`;
    });
  });
  return `Table ${table}:\n${blocks.join('\n')}`;
}
// Never dispatch to a real Agent or execute a shell command in this process.
AgentBroker.prototype.dispatch = async function (nodeId, method, params = {}) {
  const result = (stdout: string, ok = true, stderr = '') => ({taskId:'demo', nodeId, ok, stdout, stderr});
  if (!nodeIds.has(nodeId)) return result('', false, 'Demo 只支持预置的模拟节点');
  if (method === 'system.interfaces') return result(interfaces[nodeId].join('\n'));
  if (method === 'bird.inspect') return result(`BIRD version 2.19.2\n---BIRDBOX---\n${inventory.sessions.filter(s => s.nodeId === nodeId && s.enabled).map(s => protocolDetails(nodeId, s.protocolName)).join('\n')}\n---BIRDBOX-STATUS---\nversion=0\nprotocols=0`);
  if (method === 'bird.ospf') return result(ospfRuntime(nodeId, params));
  if (method === 'bird.protocol') return result(protocolDetails(nodeId, String(params.protocolName ?? ''), params.ospfState === true));
  if (method === 'network.ip_rules.inspect') {
    const node = inventory.nodes.find(n => n.id === nodeId)!;
    const rules = (systemRules.get(nodeId) ?? sourcePolicyManagedRulesForNode(inventory.sourcePolicies.filter(r => r.enabled && (!r.nodeIds || r.nodeIds.includes(nodeId))), node)) as Array<{ priority: number }>;
    const groups = sourceGroups(nodeId), priorities = params.priorities as number[];
    return result(JSON.stringify({ rules: rules.filter(r => priorities.includes(r.priority)), rawRules: rules.filter(r => priorities.includes(r.priority)), persistence: { state: 'ready', error: null }, tables: (params.tables as number[]).map(table => ({ table, routes: groups.filter(item => item.group.kernelTable === table).flatMap(sourceKernelRoutes), truncated: false, error: null })) }));
  }
  if (method === 'bird.routes') {
    const source = sourceGroups(nodeId).find(item => item.names.table === params.table);
    if (source) return result(`Table ${params.table}:\n${sourceKernelRoutes(source).filter(r => matchesTarget(r.dst === 'default' ? '0.0.0.0/0' : r.dst, params.target)).map(r => `${r.dst === 'default' ? '0.0.0.0/0' : r.dst} ${'gateway' in r ? `via ${r.gateway} on eth1` : 'blackhole'} [${source.names.staticProtocol} 12:00] * (200)\n    Type: static univ`).join('\n')}`);
    const bgp = inventory.sessions.find(s => s.enabled && s.nodeId === nodeId && s.protocolName === params.protocolName);
    if (bgp) {
      const peer = inventory.peers.find(p => p.id === bgp.peerId)!;
      const v6 = params.table === 'master6';
      return result(nodeId === 'core_b' || params.direction === 'export' ? '' : `${v6 ? '2001:db8:10::/48' : '198.51.100.0/24'} unicast [${bgp.protocolName} 12:00] * (100) [AS${peer.asn}i]\n    via ${v6 ? 'fe80::99' : peer.address} on eth1\n    Type: BGP univ\n    BGP.origin: IGP\n    BGP.as_path: ${peer.asn}`);
    }
    const rpki = inventory.rpki.find(p => p.enabled && (!p.nodeIds || p.nodeIds.includes(nodeId)) && [p.roa4Table, p.roa6Table].includes(String(params.table)));
    if (rpki) { const v6 = params.table === rpki.roa6Table; return result(`Table ${params.table}:\n${v6 ? '2001:db8::/32-48 AS64513' : '203.0.113.0/24-28 AS64512'} [${rpki.sourceType === 'server' ? rpki.name : `${rpki.name}_v${v6 ? 6 : 4}`} 12:00] * (100)`); }

    if (String(params.protocolName ?? '').includes('ospf')) return result(routes(nodeId, params.table === 'master6', String(params.protocolName)));
    return result(systemRoutes(nodeId, params) ?? staticRoutes(nodeId, params));
  }
  if (method === 'bird.stage') return result('Demo: 配置结构预检通过（模拟 BIRD 语法检查）');
  if (method === 'network.ip_rules') {
    if (!Array.isArray(params.rules) || !Array.isArray(params.removeRules)) return result('', false, 'Demo: 系统规则参数必须是数组');
    systemRules.set(nodeId, structuredClone(params.rules));
    return result('Demo: 已模拟同步系统规则，未执行系统命令');
  }
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

console.log(`\nBirdbox 验收 Demo: ${publicUrl}\n账号 admin / 密码 ${process.env.BIRDBOX_DEMO_PASSWORD ? '使用 BIRDBOX_DEMO_PASSWORD 设置值' : password}\n库存目录 ${dataDir}\n运行态、预检和应用均使用模拟 Agent，修改仅保存在内存。\n`);
await import('../src/server.js');
const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password, confirmation: password }),
});
if (!setup.ok && setup.status !== 409) throw new Error(`Demo 管理员初始化失败：${setup.status}`);
