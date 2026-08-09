<script setup lang="ts">
import { computed } from "vue";

import type { DashboardPeer } from "@birdbox/contracts/api";

import type { ResourceWorkspaceTarget } from "../shared/events";
import { useDashboardStore } from "./dashboard-store";
import { protocolPresentation as presentProtocol } from "./presentation";

const { dashboard, loading, updatedAt } = useDashboardStore();

const nodes = computed(() => dashboard.value?.inventory.nodes ?? []);
const peers = computed(() => dashboard.value?.peers ?? []);
const node = computed(() => dashboard.value?.node ?? null);
const selectedNodeId = computed(() => dashboard.value?.selection.nodeId ?? "");
const selectedPeerId = computed(() => dashboard.value?.selection.peerId ?? "");
const selectedPeer = computed(() => dashboard.value?.selectedPeer ?? null);
const nodeOnline = computed(() => Boolean(dashboard.value?.runtime?.reachable && dashboard.value.runtime.bird2));
const updatedAtLabel = computed(() => updatedAt.value === null
  ? "尚未刷新"
  : `更新于 ${new Date(updatedAt.value).toLocaleTimeString("zh-CN", { hour12: false })}`);
const selectionSummary = computed(() => {
  if (!node.value) return "尚未添加受管节点";
  return selectedPeer.value
    ? `${node.value.name} → ${selectedPeer.value.name}`
    : `${node.value.name} → 未选择`;
});

function protocolPresentation(peer: DashboardPeer) {
  return presentProtocol(dashboard.value, peer);
}

function requestSelection(nodeId: string | null, peerId: string | null): void {
  window.dispatchEvent(new CustomEvent("birdbox:dashboard-selection", { detail: { nodeId, peerId } }));
}

function selectNode(event: Event): void {
  const select = event.currentTarget as HTMLSelectElement;
  const value = select.value;
  select.value = selectedNodeId.value;
  requestSelection(value || null, null);
}

function selectPeer(event: Event): void {
  const select = event.currentTarget as HTMLSelectElement;
  const value = select.value;
  select.value = selectedPeerId.value;
  requestSelection(node.value?.id ?? null, value || null);
}

function selectTopologyPeer(peerId: string): void {
  requestSelection(node.value?.id ?? null, peerId);
}

function openResource(target: ResourceWorkspaceTarget): void {
  window.dispatchEvent(new CustomEvent("birdbox:workspace-resource-open", { detail: { target } }));
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
    <div class="selection-summary">
      <span>当前会话</span>
      <strong>{{ selectionSummary }}</strong>
    </div>
    <span class="selection-loading-status" role="status" aria-live="polite" :hidden="!loading">正在加载会话状态…</span>
  </section>

  <section class="topology-section" aria-labelledby="topologyTitle">
    <div class="section-heading">
      <div><p class="eyebrow">当前节点 · 根节点</p><h2 id="topologyTitle">BGP 会话拓扑</h2></div>
      <span class="updated-at">{{ updatedAtLabel }}</span>
    </div>
    <div class="topology-network" :class="{ 'has-peers': peers.length > 0 }">
      <article class="managed-node-card" :class="{ online: nodeOnline }">
        <div class="card-head">
          <span class="node-icon">N</span>
          <span class="status-pill" :class="node ? (nodeOnline ? 'online' : 'offline') : 'unknown'">
            {{ node ? (nodeOnline ? "可管理" : "不可达") : "未配置" }}
          </span>
        </div>
        <h3>{{ node?.name ?? "尚未添加受管节点" }}</h3>
        <p>{{ node ? `默认会话端口 ${node.listenPort}` : "请在资源管理中添加节点" }}</p>
        <dl>
          <div><dt>Router ID</dt><dd>{{ node?.routerId ?? "-" }}</dd></div>
          <div><dt>BIRD</dt><dd>{{ dashboard?.runtime.version?.replace("BIRD version ", "") ?? "-" }}</dd></div>
          <div><dt>管理</dt><dd>{{ node ? (node.transport === "ssh" ? "SSH" : "本机") : "-" }}</dd></div>
        </dl>
      </article>
      <div class="peer-connections" role="tree" aria-label="BGP 会话叶节点">
        <div v-if="!node" class="topology-empty">尚无受管节点</div>
        <div v-else-if="peers.length === 0" class="topology-empty">尚无远端 Peer</div>
        <template v-else>
          <div
            v-for="peer in peers"
            :key="peer.id"
            class="peer-connection"
            :class="{ established: peer.protocol?.established }"
            role="treeitem"
          >
            <span class="peer-wire"></span>
            <button class="peer-card" :class="{ selected: peer.id === selectedPeerId }" type="button" @click="selectTopologyPeer(peer.id)">
              <div class="peer-card-head"><span class="node-icon">P</span><span class="status-pill" :class="protocolPresentation(peer).className">{{ protocolPresentation(peer).label }}</span></div>
              <h3>{{ peer.name }} · AS{{ peer.asn }}</h3>
              <p>{{ peer.address }}:{{ peer.port }}</p>
            </button>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
