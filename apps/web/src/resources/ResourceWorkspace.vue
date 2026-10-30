<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import type { PolicyCollection } from "@birdbox/contracts/inventory";

import type { ResourceEditKind, ResourceWorkspaceTarget } from "../shared/events";
import { loadDashboard, useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
import { dispatchToast } from "../shared/events";
import ResourceTable from "./ResourceTable.vue";
import NodeEditorDialog from "./NodeEditorDialog.vue";
import PeerEditorDialog from "./PeerEditorDialog.vue";
import PolicyResourceDialog from "./PolicyResourceDialog.vue";
import SystemProtocolRuntimeDrawer from "./SystemProtocolRuntimeDrawer.vue";
import StaticRuntimeDrawer from "./StaticRuntimeDrawer.vue";
import StaticEditorDialog from "./StaticEditorDialog.vue";
import RpkiEditorDialog from "./RpkiEditorDialog.vue";
import RpkiRuntimeDrawer from "./RpkiRuntimeDrawer.vue";
import SourcePolicyEditorDialog from "./SourcePolicyEditorDialog.vue";
import SourcePolicyRuntimeDrawer from "./SourcePolicyRuntimeDrawer.vue";
import PipeEditorDialog from "./PipeEditorDialog.vue";
import PipeRuntimeDrawer from "./PipeRuntimeDrawer.vue";
import SystemProtocolEditorDialog from "./SystemProtocolEditorDialog.vue";
import BatchAgentUpgradeDialog from "./BatchAgentUpgradeDialog.vue";
import ResourceListFilters from "./ResourceListFilters.vue";
import ResourceListPagination from "./ResourceListPagination.vue";
import { activeResourceFilters, defaultResourceQuery, filterResourceItems, paginateResourceItems, resourceListItems, type ResourceListQuery } from "../shared/resource-list";

interface ResourceTab {
  id: ResourceWorkspaceTarget;
  label: string;
  eyebrow: string;
  title: string;
  addLabel: string;
  columns: string[];
  tableClass?: string;
}

const tabs: ResourceTab[] = [
  { id: "nodes", label: "受管节点", eyebrow: "Managed nodes", title: "受管节点", addLabel: "添加节点", columns: ["节点", "管理方式", "Router ID", "监听端口", "连接状态", "操作"] },
  { id: "peers", label: "eBGP 远端", eyebrow: "External definitions", title: "eBGP 远端", addLabel: "添加 Peer", columns: ["Peer", "所属节点", "邻居地址", "远端 ASN", "操作"] },
  { id: "defines", label: "Defines", eyebrow: "BIRD declarations", title: "Defines", addLabel: "添加 Define", columns: ["Define", "类型", "可用范围", "顺序", "值", "状态", "引用", "操作"], tableClass: "ordered-resource-table" },
  { id: "statics", label: "Static", eyebrow: "Node routes", title: "Static Protocols", addLabel: "添加 Static", columns: ["Static", "所属节点", "地址族", "标准路由", "Import / Export", "状态", "操作"], tableClass: "protocol-resource-table" },
  { id: "directs", label: "Direct", eyebrow: "Connected routes", title: "Direct Protocols", addLabel: "添加 Direct", columns: ["Direct", "所属节点", "接口", "地址族", "状态", "操作"], tableClass: "protocol-resource-table" },
  { id: "pipes", label: "Pipe", eyebrow: "Routing table exchange", title: "Pipe Protocols", addLabel: "添加 Pipe", columns: ["Pipe", "下发节点", "地址族", "路由表", "传递方向", "状态", "操作"], tableClass: "protocol-resource-table" },
  { id: "kernels", label: "Kernel", eyebrow: "FIB export", title: "Kernel Protocols", addLabel: "添加 Kernel", columns: ["Kernel", "下发节点", "地址族", "策略", "状态", "操作"], tableClass: "protocol-resource-table" },
  { id: "functions", label: "Functions", eyebrow: "BIRD functions", title: "Functions", addLabel: "添加 Function", columns: ["显示名称 / Function", "可用范围", "顺序", "状态", "引用", "操作"], tableClass: "ordered-resource-table" },
  { id: "filters", label: "Filters", eyebrow: "BIRD filters", title: "Filters", addLabel: "添加 Filter", columns: ["显示名称 / Filter", "可用范围", "状态", "引用", "操作"] },
  { id: "rpki", label: "RPKI", eyebrow: "ROA sources", title: "RPKI", addLabel: "添加 RPKI", columns: ["资源", "来源", "可用范围", "ROA Table", "状态", "操作"], tableClass: "protocol-resource-table" },
  { id: "sourcePolicies", label: "源地址出口", eyebrow: "Source policy egress", title: "源地址出口映射", addLabel: "新增映射集", columns: ["映射集", "下发节点", "出口组", "源 CIDR", "状态", "操作"] },
];

const { dashboard, loading } = useDashboardStore();
const activeTab = ref<ResourceWorkspaceTarget>("nodes");
const active = computed(() => tabs.find((tab) => tab.id === activeTab.value) ?? tabs[0]!);
const nodesAvailable = computed(() => Boolean(dashboard.value?.inventory.nodes.length));
const movePending = ref(false);
const tableWrap = ref<HTMLElement | null>(null);
const selectedNodeIds = ref<string[]>([]);
const agentNodeIds = computed(() => (dashboard.value?.inventory.nodes ?? []).filter((node) => node.transport === "agent").map((node) => node.id));
const queries = reactive(Object.fromEntries(tabs.map(tab => [tab.id, defaultResourceQuery()])) as Record<ResourceWorkspaceTarget, ResourceListQuery>);
const query = computed(() => queries[activeTab.value]);
const listItems = computed(() => resourceListItems(dashboard.value?.inventory ?? null, activeTab.value, dashboard.value?.health.nodeStatuses));
const filteredItems = computed(() => filterResourceItems(listItems.value, query.value));
const page = computed(() => paginateResourceItems(filteredItems.value, query.value.page, query.value.pageSize));
const visibleIds = computed(() => page.value.items.map(item => item.id));
const filterCount = computed(() => activeResourceFilters(query.value));
const ordered = computed(() => ['defines', 'functions'].includes(activeTab.value));
const reorderDisabled = computed(() => Boolean(filterCount.value || query.value.sort !== 'inventory' || movePending.value));
const matchingAgentIds = computed(() => {
  const agents = new Set(agentNodeIds.value);
  return filteredItems.value.filter(item => agents.has(item.id)).map(item => item.id);
});
const pageAgentIds = computed(() => visibleIds.value.filter(id => agentNodeIds.value.includes(id)));
const offPageSelectionCount = computed(() => selectedNodeIds.value.filter(id => !visibleIds.value.includes(id)).length);
const resourceCounts = computed(() => {
  const inventory = dashboard.value?.inventory;
  return {
    nodes: inventory?.nodes.length ?? 0, peers: inventory?.peers.filter(peer => !peer.managedBy).length ?? 0,
    defines: inventory?.defines.length ?? 0, statics: inventory?.staticProtocols.length ?? 0,
    directs: inventory?.directProtocols.length ?? 0, kernels: inventory?.kernelProtocols.length ?? 0,
    pipes: inventory?.pipeProtocols?.length ?? 0, functions: inventory?.functions.length ?? 0,
    filters: inventory?.filters.length ?? 0, rpki: inventory?.rpki.length ?? 0, sourcePolicies: inventory?.sourcePolicies?.length ?? 0,
  };
});
const emptyTitle = computed(() => ({ nodes: '尚无受管节点', peers: '尚无 eBGP 远端', defines: '尚无 Define', statics: '尚无 Static 资源', directs: '尚无 Direct 资源', kernels: '尚无 Kernel 资源', pipes: '尚无 Pipe 资源', functions: '尚无 Function', filters: '尚无 Filter', rpki: '尚无 RPKI 来源', sourcePolicies: '尚无源地址出口映射' })[activeTab.value]);
const allPageAgentsSelected = computed(() => pageAgentIds.value.length > 0 && pageAgentIds.value.every(id => selectedNodeIds.value.includes(id)));
const somePageAgentsSelected = computed(() => !allPageAgentsSelected.value && pageAgentIds.value.some(id => selectedNodeIds.value.includes(id)));

// Each tab owns its query and page; changing filters only resets that tab.
for (const tab of tabs) watch(() => {
  const q = queries[tab.id]; return [q.keyword, q.nodeId, q.status, q.family, q.type, q.sort, q.pageSize];
}, () => { queries[tab.id].page = 1; }, { flush: 'sync' });
watch(() => page.value.page, value => { query.value.page = value; }, { flush: 'sync' });
watch(agentNodeIds, ids => { selectedNodeIds.value = selectedNodeIds.value.filter(id => ids.includes(id)); });
watch(() => visibleIds.value.join(','), () => tableWrap.value?.scrollTo({ top: 0 }), { flush: 'post' });
watch(() => [activeTab.value, listItems.value, Boolean(dashboard.value)] as const, ([kind, items], [previousKind, previous, previouslyLoaded]) => {
  if (kind !== previousKind || !previouslyLoaded) return;
  const previousIds = new Set(previous.map(item => item.id));
  const added = items.filter(item => !previousIds.has(item.id));
  if (added.length !== 1) return;
  const index = filteredItems.value.findIndex(item => item.id === added[0]!.id);
  if (index >= 0) query.value.page = Math.floor(index / page.value.pageSize) + 1;
  else dispatchToast('新资源已保存，当前筛选条件下不可见；可重置筛选查看。');
}, { flush: 'post' });

function resetFilters(): void {
  Object.assign(query.value, defaultResourceQuery(), { pageSize: query.value.pageSize });
}
function changePage(value: number): void {
  query.value.page = Math.min(page.value.pageCount, Math.max(1, value));
}
function togglePageAgents(): void {
  if (allPageAgentsSelected.value) selectedNodeIds.value = selectedNodeIds.value.filter(id => !pageAgentIds.value.includes(id));
  else selectedNodeIds.value = [...new Set([...selectedNodeIds.value, ...pageAgentIds.value])];
}
async function refresh(): Promise<void> {
  try { await loadDashboard(dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null); }
  catch (error) { dispatchToast(error instanceof Error ? error.message : '资源列表刷新失败', 'error'); }
}

function toggleNode(nodeId: string): void {
  selectedNodeIds.value = selectedNodeIds.value.includes(nodeId)
    ? selectedNodeIds.value.filter((id) => id !== nodeId)
    : [...selectedNodeIds.value, nodeId];
}

function openBatchUpgrade(): void {
  const validIds = new Set(agentNodeIds.value);
  selectedNodeIds.value = selectedNodeIds.value.filter((id) => validIds.has(id));
  if (!selectedNodeIds.value.length) return;
  window.dispatchEvent(new CustomEvent("birdbox:agent-batch-upgrade", { detail: { nodeIds: [...selectedNodeIds.value] } }));
}

function selectAllAgents(): void {
  selectedNodeIds.value = [...new Set([...selectedNodeIds.value, ...matchingAgentIds.value])];
}

function clearSelectedNodes(): void {
  selectedNodeIds.value = [];
}

function selectTab(target: ResourceWorkspaceTarget, focus = false): void {
  activeTab.value = target;
  void nextTick(() => {
    const tab = document.querySelector<HTMLButtonElement>(`#resourceWorkspaceApp [data-resource-tab="${target}"]`);
    tab?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    if (focus) tab?.focus();
  });
}

function handleOpen(event: CustomEvent<{ target: ResourceWorkspaceTarget }>): void {
  selectTab(event.detail.target);
}

function handleTabSelect(event: CustomEvent<{ target: ResourceWorkspaceTarget }>): void {
  selectTab(event.detail.target);
}

function create(kind: ResourceEditKind): void {
  window.dispatchEvent(new CustomEvent("birdbox:resource-create", { detail: { kind } }));
}

async function handleMove(event: CustomEvent<{
  collection: PolicyCollection;
  id: string;
  direction: "up" | "down";
  button: HTMLButtonElement;
}>): Promise<void> {
  if (event.detail.collection === "filters") return;
  if (movePending.value) return;
  movePending.value = true;
  const button = event.detail.button;
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = "…";
  try {
    await api(`/api/${event.detail.collection}/${encodeURIComponent(event.detail.id)}/move`, {
      method: "POST",
      body: JSON.stringify({ direction: event.detail.direction }),
    });
    await loadDashboard(dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null);
    selectTab(event.detail.collection);
  } catch (error) {
    dispatchToast(error instanceof Error ? error.message : "资源顺序调整失败", "error");
  } finally {
    movePending.value = false;
    if (button.isConnected) {
      button.textContent = previousText;
      button.disabled = false;
    }
  }
}

function tabDomId(target: ResourceWorkspaceTarget): string {
  return `resource${target[0]?.toUpperCase() ?? ""}${target.slice(1)}Tab`;
}

function rowsDomId(target: ResourceWorkspaceTarget): string {
  const names: Record<ResourceWorkspaceTarget, string> = {
    nodes: "managementNodeRows",
    peers: "managementPeerRows",
    defines: "managementDefineRows",
    statics: "managementStaticRows",
    directs: "managementDirectRows",
    kernels: "managementKernelRows",
    pipes: "managementPipeRows",
    functions: "managementFunctionRows",
    filters: "managementFilterRows",
    rpki: "managementRPKIRows",
    sourcePolicies: "managementSourcePolicyRows",
  };
  return names[target];
}

function moveTab(event: KeyboardEvent, index: number): void {
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0
    : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + tabs.length) % tabs.length;
  const target = tabs[next];
  if (target) selectTab(target.id, true);
}

onMounted(() => {
  window.addEventListener("birdbox:workspace-resource-open", handleOpen);
  window.addEventListener("birdbox:resource-tab-select", handleTabSelect);
  window.addEventListener("birdbox:resource-move", handleMove);
});
onBeforeUnmount(() => {
  window.removeEventListener("birdbox:workspace-resource-open", handleOpen);
  window.removeEventListener("birdbox:resource-tab-select", handleTabSelect);
  window.removeEventListener("birdbox:resource-move", handleMove);
});
</script>

<template>
  <div class="resource-header"><div><p class="eyebrow">Inventory</p><h2>资源管理</h2><p class="resource-description">按节点、类型和状态查找资源，集中维护协议与策略配置。</p></div></div>
  <nav class="resource-tabs" role="tablist" aria-label="资源类型">
    <button v-for="(tab, index) in tabs" :id="tabDomId(tab.id)" :key="tab.id" class="resource-tab" :class="{ active: activeTab === tab.id }" type="button" role="tab" :aria-label="tab.label" :aria-selected="activeTab === tab.id" :aria-controls="`resource-${tab.id}`" :data-resource-tab="tab.id" :tabindex="activeTab === tab.id ? 0 : -1" @click="selectTab(tab.id)" @keydown="moveTab($event, index)">{{ tab.label }}<span class="resource-tab-count" aria-hidden="true">{{ resourceCounts[tab.id] }}</span></button>
  </nav>
  <section :id="`resource-${active.id}`" class="resource-section resource-panel" role="tabpanel" :aria-labelledby="tabDomId(active.id)">
    <div class="section-heading compact"><div><p class="eyebrow">{{ active.eyebrow }}</p><h3>{{ active.title }} <span class="protocol-count">{{ listItems.length }}</span></h3></div><div class="resource-heading-actions"><button class="secondary-button compact-command" type="button" :disabled="loading" @click="refresh">{{ loading ? '刷新中…' : '刷新列表' }}</button><button class="primary-button compact-command" type="button" :disabled="(loading && !dashboard) || ((active.id === 'peers' || active.id === 'statics' || active.id === 'directs' || active.id === 'kernels' || active.id === 'pipes' || active.id === 'rpki' || active.id === 'sourcePolicies') && !nodesAvailable)" @click="create(active.id)">+ {{ active.addLabel }}</button></div></div>
    <div class="resource-list-card">
      <ResourceListFilters v-model="queries[active.id]" :kind="active.id" :nodes="dashboard?.inventory.nodes ?? []" @reset="resetFilters" />
      <div class="resource-results-toolbar"><p role="status" aria-live="polite">{{ filterCount ? `筛选结果 ${filteredItems.length} 项 / 全部 ${listItems.length} 项` : `全部 ${listItems.length} 项` }}<span v-if="filterCount" class="resource-filter-count">{{ filterCount }} 个筛选条件</span></p><label for="resourceSort">排序<select id="resourceSort" v-model="query.sort"><option value="inventory">{{ ordered ? '声明顺序' : '默认顺序' }}</option><option value="name-asc">名称升序</option><option value="name-desc">名称降序</option></select></label></div>
      <p v-if="ordered" class="resource-order-hint">序号为真实声明顺序。{{ reorderDisabled && !movePending ? '清除筛选并选择“声明顺序”后，可使用上移、下移调整。' : '上移、下移会调整全局声明顺序，支持跨页移动。' }}</p>
      <div v-if="active.id === 'nodes'" class="resource-selection-toolbar"><label class="resource-page-selection"><input type="checkbox" :checked="allPageAgentsSelected" :indeterminate="somePageAgentsSelected" :disabled="!pageAgentIds.length" @change="togglePageAgents">选择本页 Agent</label><button class="secondary-button compact-command" type="button" :disabled="!matchingAgentIds.length" @click="selectAllAgents">选择全部筛选结果（{{ matchingAgentIds.length }} 个 Agent）</button><span class="selection-count">已选 {{ selectedNodeIds.length }} 个<span v-if="selectedNodeIds.length"> · 跨页保留<span v-if="offPageSelectionCount">（{{ offPageSelectionCount }} 个不在本页）</span></span></span><button v-if="selectedNodeIds.length" class="secondary-button compact-command" type="button" @click="clearSelectedNodes">清除选择</button><button class="secondary-button compact-command" type="button" :disabled="!selectedNodeIds.length" @click="openBatchUpgrade">批量升级 Agent</button></div>
      <p v-if="page.total" class="resource-table-hint">左右滑动查看更多字段，右侧可直接操作。</p>
      <div ref="tableWrap" class="resource-table-wrap" :class="{ 'is-empty': !page.total }" :aria-busy="loading" tabindex="0" aria-label="可滚动的资源列表"><table :class="active.tableClass" :aria-label="`${active.label}资源列表`"><thead><tr><th v-for="column in active.columns" :key="column" scope="col">{{ column }}</th></tr></thead><tbody :id="rowsDomId(active.id)"><tr v-if="!page.total"><td :colspan="active.columns.length" class="resource-empty-cell"><div data-testid="resource-list-empty"><strong>{{ loading && !dashboard ? '正在加载资源…' : listItems.length ? '未找到匹配的资源' : emptyTitle }}</strong><p>{{ loading && !dashboard ? '请稍候，正在获取资源列表。' : listItems.length ? '尝试调整关键词或筛选条件。' : `点击“${active.addLabel}”开始配置。` }}</p><button v-if="listItems.length" class="secondary-button compact-command" type="button" @click="resetFilters">清除全部筛选</button></div></td></tr><ResourceTable v-else :kind="active.id" :resource-ids="visibleIds" :reorder-disabled="reorderDisabled" :selected-node-ids="selectedNodeIds" @toggle-node="toggleNode" /></tbody></table></div>
      <ResourceListPagination :key="active.id" :page="page.page" :page-size="page.pageSize" :page-count="page.pageCount" :total="page.total" :start="page.start" :end="page.end" @page="changePage" @size="query.pageSize = $event" />
    </div>
  </section>
  <NodeEditorDialog />
  <PeerEditorDialog />
  <PolicyResourceDialog />
  <StaticEditorDialog />
  <StaticRuntimeDrawer />
  <SystemProtocolRuntimeDrawer />
  <RpkiEditorDialog />
  <RpkiRuntimeDrawer />
  <SourcePolicyEditorDialog />
  <SourcePolicyRuntimeDrawer />
  <SystemProtocolEditorDialog />
  <PipeEditorDialog />
  <PipeRuntimeDrawer />
  <BatchAgentUpgradeDialog />
</template>

<style scoped>
.resource-heading-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.selection-count { color: var(--muted); font-size: .9rem; white-space: nowrap; }
</style>
