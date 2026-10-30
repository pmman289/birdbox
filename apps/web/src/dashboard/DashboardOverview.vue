<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

import type { AddressFamily } from "@birdbox/contracts/inventory";
import type { DashboardPeer } from "@birdbox/contracts/api";

import type { ResourceWorkspaceTarget } from "../shared/events";
import { useDashboardStore } from "./dashboard-store";
import { isEbgpDashboardPeer } from "./peer-kind";
import { protocolPresentation as presentProtocol } from "./presentation";

const { dashboard, loading, updatedAt } = useDashboardStore();

type StatusFilter = "all" | "established" | "waiting" | "unconfigured" | "disabled" | "error";
type ConfigFilter = "all" | "configured" | "unconfigured";

const searchTerm = ref("");
const statusFilter = ref<StatusFilter>("all");
const configFilter = ref<ConfigFilter>("all");
const mobileDetailVisible = ref(false);

const nodes = computed(() => dashboard.value?.inventory.nodes ?? []);
const peers = computed(() => (dashboard.value?.peers ?? []).filter(isEbgpDashboardPeer));
const node = computed(() => dashboard.value?.node ?? null);
const selectedNodeId = computed(() => dashboard.value?.selection.nodeId ?? "");
const selectedPeerId = computed(() => {
  const peerId = dashboard.value?.selection.peerId ?? "";
  return peers.value.some((peer) => peer.id === peerId) ? peerId : "";
});
const selectedPeerCandidate = computed(() => peers.value.find((peer) => peer.id === selectedPeerId.value) ?? null);
const nodeOnline = computed(() => Boolean(dashboard.value?.runtime.reachable && dashboard.value.runtime.bird2));
const updatedAtLabel = computed(() => updatedAt.value === null
  ? "尚未刷新"
  : `更新于 ${new Date(updatedAt.value).toLocaleTimeString("zh-CN", { hour12: false })}`);

function protocolPresentation(peer: DashboardPeer) {
  return presentProtocol(dashboard.value, peer);
}

function statusGroup(peer: DashboardPeer): Exclude<StatusFilter, "all"> {
  const presentation = protocolPresentation(peer);
  if (presentation.className === "established") return "established";
  if (presentation.className === "unconfigured") return "unconfigured";
  if (presentation.className === "disabled") return "disabled";
  if (presentation.label === "等待运行" || presentation.className === "unknown") return "waiting";
  return "error";
}

function statusRank(peer: DashboardPeer): number {
  const group = statusGroup(peer);
  return group === "error" ? 0 : group === "established" ? 1 : group === "waiting" ? 2 : 3;
}

function enabledFamilies(peer: DashboardPeer): AddressFamily[] {
  return (["ipv4", "ipv6"] as const).filter((family) => peer.session?.channels[family]?.enabled);
}

function familyLabel(family: AddressFamily): string {
  return family === "ipv4" ? "IPv4" : "IPv6";
}

function routeCount(peer: DashboardPeer, family: AddressFamily, direction: "imported" | "exported"): number | null {
  const families = enabledFamilies(peer);
  const channel = peer.protocol?.channels?.[family];
  const fallback = families.length === 1 ? peer.protocol : null;
  return channel?.[direction] ?? fallback?.[direction] ?? null;
}

function routesAvailable(peer: DashboardPeer): boolean {
  return Boolean(
    peer.session?.enabled !== false
      && enabledFamilies(peer).length
      && dashboard.value?.runtime.reachable
      && peer.protocol?.configured !== false,
  );
}

const filteredPeers = computed(() => {
  const term = searchTerm.value.trim().toLocaleLowerCase();
  return peers.value
    .filter((peer) => {
      const searchable = [peer.name, peer.address, String(peer.asn), peer.session?.protocolName ?? ""].join(" ").toLocaleLowerCase();
      if (term && !searchable.includes(term)) return false;
      if (statusFilter.value !== "all" && statusGroup(peer) !== statusFilter.value) return false;
      if (configFilter.value === "configured" && !peer.session) return false;
      if (configFilter.value === "unconfigured" && peer.session) return false;
      return true;
    })
    .sort((left, right) => statusRank(left) - statusRank(right) || left.name.localeCompare(right.name, "zh-CN"));
});

const selectedPeer = computed(() => {
  const candidate = selectedPeerCandidate.value;
  return candidate && filteredPeers.value.some((peer) => peer.id === candidate.id) ? candidate : null;
});
const selectionSummary = computed(() => {
  if (!node.value) return "尚未添加受管节点";
  return selectedPeer.value ? `${node.value.name} → ${selectedPeer.value.name}` : `${node.value.name} → 未选择`;
});
const controlLabel = computed(() => selectedPeer.value?.protocol?.disabled ? "启动当前会话" : "停止当前会话");

function requestSelection(nodeId: string | null, peerId: string | null): void {
  window.dispatchEvent(new CustomEvent("birdbox:dashboard-selection", { detail: { nodeId, peerId } }));
}

function selectNode(event: Event): void {
  const value = (event.currentTarget as HTMLSelectElement).value;
  mobileDetailVisible.value = false;
  requestSelection(value || null, null);
}

function selectPeer(event: Event): void {
  const value = (event.currentTarget as HTMLSelectElement).value;
  if (!value) {
    mobileDetailVisible.value = false;
    requestSelection(node.value?.id ?? null, null);
    return;
  }
  mobileDetailVisible.value = true;
  requestSelection(node.value?.id ?? null, value);
}

function selectPeerRow(peerId: string): void {
  mobileDetailVisible.value = true;
  requestSelection(node.value?.id ?? null, peerId);
}

function openResource(target: ResourceWorkspaceTarget): void {
  window.dispatchEvent(new CustomEvent("birdbox:workspace-resource-open", { detail: { target } }));
}

function openRoutes(peerId: string): void {
  window.dispatchEvent(new CustomEvent("birdbox:routes-open", { detail: { peerId } }));
}

function openProtocolDetails(peerId: string): void {
  window.dispatchEvent(new CustomEvent("birdbox:protocol-details-open", { detail: { peerId } }));
}

function scrollToEditor(): void {
  const editor = document.querySelector<HTMLElement>("#sessionEditorApp");
  editor?.scrollIntoView({ behavior: "smooth", block: "start" });
  void nextTick(() => editor?.querySelector<HTMLElement>("input, select, textarea, button")?.focus());
}

function triggerSessionControl(): void {
  document.querySelector<HTMLButtonElement>("#sessionControlApp button")?.click();
}

function clearFilters(): void {
  searchTerm.value = "";
  statusFilter.value = "all";
  configFilter.value = "all";
}
</script>

<template>
  <section class="selection-section" aria-label="节点与远端选择">
    <div class="selection-group">
      <div class="selection-label"><span>1</span><label for="nodeSelect">受管节点</label></div>
      <div class="select-actions">
        <select id="nodeSelect" :value="selectedNodeId" :disabled="loading || nodes.length === 0" @change="selectNode">
          <option v-if="nodes.length === 0" value="">尚未添加节点</option>
          <option v-for="item in nodes" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
        <button class="compact-icon manage-hint" type="button" title="前往资源管理 Tab 管理受管节点" aria-label="前往资源管理 Tab 管理受管节点" @click="openResource('nodes')">?</button>
      </div>
    </div>
    <span class="selection-arrow" aria-hidden="true">›</span>
    <div class="selection-group">
      <div class="selection-label"><span>2</span><label for="peerSelect">eBGP 远端</label></div>
      <div class="select-actions">
        <select id="peerSelect" :value="selectedPeerId" :disabled="loading || peers.length === 0" @change="selectPeer">
          <option v-if="peers.length === 0" value="">尚无远端 Peer</option>
          <option v-for="peer in peers" :key="peer.id" :value="peer.id">{{ peer.name }} · AS{{ peer.asn }}</option>
        </select>
        <button class="compact-icon manage-hint" type="button" title="前往资源管理 Tab 管理 eBGP 远端" aria-label="前往资源管理 Tab 管理 eBGP 远端" @click="openResource('peers')">?</button>
      </div>
    </div>
    <div class="selection-summary"><span>当前会话</span><strong>{{ selectionSummary }}</strong></div>
    <span class="selection-loading-status" role="status" aria-live="polite" :hidden="!loading">正在加载会话状态…</span>
  </section>

  <section class="ebgp-overview-section" aria-labelledby="ebgpOverviewTitle">
    <div class="section-heading">
      <div><p class="eyebrow">EBGP SESSION WORKSPACE</p><h2 id="ebgpOverviewTitle">Peer 会话总览</h2></div>
      <span class="updated-at">{{ updatedAtLabel }}</span>
    </div>

    <div class="ebgp-workbench" :class="{ 'mobile-detail-open': mobileDetailVisible }">
      <div class="ebgp-peer-list-panel" aria-label="eBGP Peer 列表">
        <div class="ebgp-list-toolbar">
          <label class="ebgp-search-field" for="ebgpPeerSearch"><span>搜索 Peer</span><input id="ebgpPeerSearch" v-model="searchTerm" type="search" placeholder="名称、地址、ASN 或协议名"></label>
          <div class="ebgp-filter-row">
            <label for="ebgpStatusFilter">状态</label>
            <select id="ebgpStatusFilter" v-model="statusFilter">
              <option value="all">全部状态</option><option value="established">Established</option><option value="waiting">等待运行</option><option value="unconfigured">未配置</option><option value="disabled">已停用</option><option value="error">异常</option>
            </select>
            <label for="ebgpConfigFilter">配置</label>
            <select id="ebgpConfigFilter" v-model="configFilter"><option value="all">全部</option><option value="configured">已配置</option><option value="unconfigured">未配置</option></select>
          </div>
        </div>
        <div v-if="!node" class="ebgp-list-empty">尚无受管节点</div>
        <div v-else-if="peers.length === 0" class="ebgp-list-empty">尚无远端 Peer</div>
        <div v-else-if="filteredPeers.length === 0" class="ebgp-list-empty"><span>没有匹配的 Peer</span><button class="secondary-button compact-button" type="button" @click="clearFilters">清除筛选</button></div>
        <div v-else class="ebgp-peer-list" role="listbox" aria-label="eBGP Peer">
          <article v-for="peer in filteredPeers" :key="peer.id" class="ebgp-peer-row" :class="{ selected: peer.id === selectedPeerId }" role="option" :aria-selected="peer.id === selectedPeerId" tabindex="0" @click="selectPeerRow(peer.id)" @keydown.enter="selectPeerRow(peer.id)" @keydown.space.prevent="selectPeerRow(peer.id)">
            <span class="ebgp-peer-row-main"><strong>{{ peer.name }}</strong><span>{{ peer.address }}:{{ peer.port }}</span></span>
            <span class="ebgp-peer-row-meta"><span>AS{{ peer.asn }}</span><span>{{ peer.session?.protocolName ?? "未配置协议" }}</span><span class="status-pill" :class="protocolPresentation(peer).className">{{ protocolPresentation(peer).label }}</span></span>
            <span class="ebgp-peer-row-routes"><span v-for="family in enabledFamilies(peer)" :key="family">{{ familyLabel(family) }} {{ routeCount(peer, family, "imported") ?? "-" }} 入 / {{ routeCount(peer, family, "exported") ?? "-" }} 出</span><span v-if="!enabledFamilies(peer).length">未启用 Channel</span></span>
            <span class="ebgp-peer-row-actions"><button class="secondary-button compact-command" type="button" :disabled="!peer.session || !routesAvailable(peer)" @click.stop="openRoutes(peer.id)">路由</button><button class="secondary-button compact-command" type="button" :disabled="!peer.session" @click.stop="openProtocolDetails(peer.id)">协议详情</button><button class="secondary-button compact-command" type="button" @click.stop="selectPeerRow(peer.id); scrollToEditor()">编辑配置</button></span>
          </article>
        </div>
      </div>

      <aside class="ebgp-peer-detail-panel" aria-label="Peer 会话详情">
        <button class="ebgp-mobile-back secondary-button compact-button" type="button" @click="mobileDetailVisible = false">‹ 返回 Peer 列表</button>
        <template v-if="selectedPeer && node">
          <div class="ebgp-detail-head"><div><p class="eyebrow">SELECTED PEER</p><h3>{{ selectedPeer.name }}</h3><span>{{ selectedPeer.address }}:{{ selectedPeer.port }} · AS{{ selectedPeer.asn }}</span></div><span class="status-pill" :class="protocolPresentation(selectedPeer).className">{{ protocolPresentation(selectedPeer).label }}</span></div>
          <div class="ebgp-relationship-strip" aria-label="当前节点与 Peer 的会话关系">
            <div><small>本地节点</small><strong>{{ node.name }}</strong><span>{{ selectedPeer.session?.localAddress ?? node.igpAddress ?? "自动选择" }} · Router ID {{ node.routerId }}</span></div>
            <i aria-hidden="true">→<small>BGP 会话</small></i>
            <div><small>远端 Peer</small><strong>{{ selectedPeer.name }}</strong><span>{{ selectedPeer.address }} · AS{{ selectedPeer.asn }}</span></div>
          </div>
          <div class="ebgp-detail-grid">
            <div><span>协议</span><strong>{{ selectedPeer.session?.protocolName ?? "未配置" }}</strong></div>
            <div><span>运行状态</span><strong>{{ nodeOnline ? "节点可管理" : "节点不可达" }}</strong></div>
            <div v-for="family in (['ipv4', 'ipv6'] as const)" :key="family"><span>{{ familyLabel(family) }} Channel</span><strong>{{ selectedPeer.session?.channels[family].enabled ? `${selectedPeer.protocol?.channels?.[family]?.state ?? "等待运行"}` : "未启用" }}</strong></div>
            <div><span>最近刷新</span><strong>{{ updatedAtLabel }}</strong></div>
          </div>
          <div class="ebgp-detail-actions">
            <button class="primary-button" type="button" :disabled="!selectedPeer.session || !routesAvailable(selectedPeer)" @click="openRoutes(selectedPeer.id)">查看路由</button>
            <button class="secondary-button" type="button" :disabled="!selectedPeer.session" @click="openProtocolDetails(selectedPeer.id)">协议详情</button>
            <button class="secondary-button" type="button" @click="scrollToEditor">编辑配置</button>
            <button class="secondary-button" type="button" :disabled="!selectedPeer.session || !selectedPeer.protocol || selectedPeer.session.enabled === false || selectedPeer.protocol.configured === false" @click="triggerSessionControl">{{ controlLabel }}</button>
          </div>
        </template>
        <div v-else class="ebgp-detail-empty"><strong>{{ !node ? "尚无受管节点" : selectedPeerCandidate ? "当前 Peer 被筛选隐藏" : "请选择一个 Peer" }}</strong><span>{{ !node ? "请先添加并选择受管节点。" : selectedPeerCandidate ? "清除左侧筛选后可继续查看该会话。" : "从左侧列表选择一个 Peer 查看会话详情。" }}</span></div>
      </aside>
    </div>
  </section>
</template>
