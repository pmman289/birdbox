import type { NodeHealthSummary } from '@birdbox/contracts/api';
import type { AddressFamily, Inventory } from '@birdbox/contracts/inventory';
import type { ResourceWorkspaceTarget } from './events';

export interface ResourceListQuery {
  keyword: string;
  nodeId: string;
  status: string;
  family: string;
  type: string;
  sort: 'inventory' | 'name-asc' | 'name-desc';
  page: number;
  pageSize: number;
}

export interface ResourceListItem {
  id: string;
  label: string;
  nodeIds: string[] | null;
  families: AddressFamily[];
  status: string;
  type: string;
  search: string;
  position: number;
}

export const GLOBAL_SCOPE = '@global';
export const RESOURCE_PAGE_SIZES = [10, 20, 50, 100] as const;
export const scopedResourceKinds = new Set<ResourceWorkspaceTarget>(['defines', 'functions', 'filters', 'rpki', 'kernels', 'pipes', 'sourcePolicies']);
export const familyResourceKinds = new Set<ResourceWorkspaceTarget>(['peers', 'defines', 'statics', 'directs', 'kernels', 'pipes', 'rpki']);
export const resourceTypeOptions: Partial<Record<ResourceWorkspaceTarget, { label: string; options: Array<{ value: string; label: string }> }>> = {
  nodes: { label: '管理方式', options: [{ value: 'agent', label: 'Agent' }, { value: 'ssh', label: 'SSH' }, { value: 'local', label: '本机' }] },
  defines: { label: 'Define 类型', options: [{ value: 'cidr4', label: 'IPv4 CIDR' }, { value: 'cidr6', label: 'IPv6 CIDR' }, { value: 'expression', label: '表达式' }] },
  statics: { label: '路由来源', options: [{ value: 'manual', label: '直接添加' }, { value: 'define', label: 'CIDR Define' }, { value: 'mixed', label: 'Define + 直接添加' }, { value: 'custom', label: '仅自定义指令' }] },
  functions: { label: 'Function 类型', options: [{ value: 'callable', label: '可调用' }, { value: 'source', label: '仅源码引用' }] },
  rpki: { label: '来源类型', options: [{ value: 'file', label: '本地文件' }, { value: 'rtr', label: 'RPKI-RTR' }] },
};

export function defaultResourceQuery(): ResourceListQuery {
  return { keyword: '', nodeId: '', status: '', family: '', type: '', sort: 'inventory', page: 1, pageSize: 20 };
}

export function activeResourceFilters(query: ResourceListQuery): number {
  return [query.keyword.trim(), query.nodeId, query.status, query.family, query.type].filter(Boolean).length;
}

export function nodeConnectionStatus(health: Pick<NodeHealthSummary, 'reachable'> | undefined): string {
  return health?.reachable === true ? 'online' : health?.reachable === false ? 'offline' : 'unknown';
}

/** Build a searchable view of inventory; never sort or mutate declaration arrays. */
export function resourceListItems(inventory: Inventory | null, kind: ResourceWorkspaceTarget, health: NodeHealthSummary[] = []): ResourceListItem[] {
  if (!inventory) return [];
  const nodeNames = new Map(inventory.nodes.map(node => [node.id, node.name]));
  const nodeHealth = new Map(health.map(node => [node.nodeId, node]));
  const families = (ipv4: boolean, ipv6: boolean): AddressFamily[] => [...(ipv4 ? ['ipv4' as const] : []), ...(ipv6 ? ['ipv6' as const] : [])];
  function item(resource: { id: string; label?: string; name?: string; enabled?: boolean }, index: number, options: Partial<ResourceListItem> = {}, fields: unknown[] = []): ResourceListItem {
    const nodeIds = options.nodeIds ?? null;
    return {
      id: resource.id, label: resource.label ?? resource.name ?? resource.id,
      nodeIds, families: [], status: resource.enabled === false ? 'disabled' : 'enabled', type: '', position: index + 1,
      ...options,
      search: [resource.id, resource.name, resource.label, ...(nodeIds?.map(id => `${id} ${nodeNames.get(id) ?? ''}`) ?? ['全部节点']), ...fields].filter(value => value !== null && value !== undefined).join(' ').toLocaleLowerCase(),
    };
  }
  switch (kind) {
    case 'nodes': return inventory.nodes.map((node, i) => item(node, i, { nodeIds: [node.id], type: node.transport, status: nodeConnectionStatus(nodeHealth.get(node.id)) }, [node.sshHost, node.sshUser, node.routerId, node.igpAddress, node.listenPort, node.transport]));
    case 'peers': return inventory.peers.filter(peer => !peer.managedBy).map((peer, i) => item(peer, i, { nodeIds: [peer.nodeId], families: [peer.address.includes(':') ? 'ipv6' : 'ipv4'] }, [peer.address, peer.asn, `AS${peer.asn}`, peer.port]));
    case 'defines': return inventory.defines.map((resource, i) => item(resource, i, { nodeIds: resource.nodeIds, type: resource.type, families: resource.type === 'expression' ? [] : [resource.type === 'cidr4' ? 'ipv4' : 'ipv6'] }, resource.type === 'expression' ? [resource.value] : resource.entries));
    case 'statics': return inventory.staticProtocols.map((resource, i) => item(resource, i, { nodeIds: [resource.nodeId], families: [resource.family], type: resource.defineId ? resource.routes?.length ? 'mixed' : 'define' : resource.routes?.length ? 'manual' : 'custom' }, [resource.table?.name, resource.igpTable, inventory.defines.find(define => define.id === resource.defineId)?.label, ...Object.keys(resource.routeActions), ...(resource.routes ?? []).flatMap(route => [route.prefix, route.recursiveVia, ...route.nextHops.flatMap(hop => [hop.address, hop.interface])])]));
    case 'directs': return inventory.directProtocols.map((resource, i) => item(resource, i, { nodeIds: [resource.nodeId], families: families(resource.ipv4, resource.ipv6) }, resource.interfaces));
    case 'kernels': return inventory.kernelProtocols.map((resource, i) => item(resource, i, { nodeIds: resource.nodeIds, families: families(resource.ipv4, resource.ipv6) }, [resource.table, resource.tables?.ipv4.name, resource.tables?.ipv6.name]));
    case 'pipes': return (inventory.pipeProtocols ?? []).map((resource, i) => item(resource, i, { nodeIds: resource.nodeIds, families: [resource.family] }, [resource.table.name, resource.peerTable.name]));
    case 'functions': return inventory.functions.map((resource, i) => item(resource, i, { nodeIds: resource.nodeIds, type: resource.callable === false ? 'source' : 'callable' }));
    case 'filters': return inventory.filters.map((resource, i) => item(resource, i, { nodeIds: resource.nodeIds }));
    case 'rpki': return inventory.rpki.map((resource, i) => item(resource, i, { nodeIds: resource.nodeIds, type: resource.sourceType === 'file' ? 'file' : 'rtr', families: families(Boolean(resource.roa4Table), Boolean(resource.roa6Table)) }, [resource.roa4Table, resource.roa6Table, ...(resource.sourceType === 'file' ? [resource.file4, resource.file6] : [resource.remote])]));
    case 'sourcePolicies': return (inventory.sourcePolicies ?? []).map((resource, i) => item(resource, i, { nodeIds: resource.nodeIds }, resource.groups.flatMap(group => [group.egressAddress, ...group.sources])));
  }
}

const nameOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export function filterResourceItems(items: ResourceListItem[], query: ResourceListQuery): ResourceListItem[] {
  const words = query.keyword.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const result = items.filter(item => words.every(word => item.search.includes(word))
    && (!query.nodeId || (query.nodeId === GLOBAL_SCOPE ? item.nodeIds === null : item.nodeIds === null || item.nodeIds.includes(query.nodeId)))
    && (!query.status || item.status === query.status)
    && (!query.type || item.type === query.type)
    && (!query.family || (query.family === 'dual' ? item.families.length === 2 : item.families.includes(query.family as AddressFamily))));
  if (query.sort !== 'inventory') result.sort((a, b) => (nameOrder.compare(a.label, b.label) || a.position - b.position) * (query.sort === 'name-desc' ? -1 : 1));
  return result;
}

export function paginateResourceItems(items: ResourceListItem[], requestedPage: number, requestedSize: number) {
  const pageSize = RESOURCE_PAGE_SIZES.includes(requestedSize as typeof RESOURCE_PAGE_SIZES[number]) ? requestedSize : 20;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.trunc(requestedPage) || 1));
  const start = items.length ? (page - 1) * pageSize + 1 : 0;
  return { page, pageSize, pageCount, total: items.length, start, end: Math.min(page * pageSize, items.length), items: items.slice((page - 1) * pageSize, page * pageSize) };
}

export function resourcePageButtons(page: number, pageCount: number): Array<number | string> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const window = page <= 3 ? [1, 2, 3, 4, 5] : page >= pageCount - 2
    ? [pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1, pageCount]
    : [page - 1, page, page + 1];
  const pages = [...new Set([1, pageCount, ...window])].sort((a, b) => a - b);
  return pages.flatMap((value, i) => i && value - pages[i - 1]! > 1 ? [`gap-${value}`, value] : [value]);
}
