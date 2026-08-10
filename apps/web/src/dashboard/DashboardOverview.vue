<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

import type { DashboardPeer } from "@birdbox/contracts/api";

import type { ResourceWorkspaceTarget } from "../shared/events";
import { useDashboardStore } from "./dashboard-store";
import { protocolPresentation as presentProtocol } from "./presentation";

const { dashboard, loading, updatedAt } = useDashboardStore();

interface CanvasPosition {
  x: number;
  y: number;
}

interface CanvasDrag {
  key: string;
  dx: number;
  dy: number;
  startX: number;
  startY: number;
  moved: boolean;
}

const ROOT_KEY = "__local__";
const board = ref<HTMLElement | null>(null);
const canvasLayout = ref<Record<string, CanvasPosition>>({});
const dragging = ref<CanvasDrag | null>(null);
const canvasMedia = window.matchMedia("(max-width: 700px)");
const compactCanvas = ref(canvasMedia.matches);
let suppressPeerClick = false;

const nodes = computed(() => dashboard.value?.inventory.nodes ?? []);
const peers = computed(() => dashboard.value?.peers ?? []);
const node = computed(() => dashboard.value?.node ?? null);
const selectedNodeId = computed(() => dashboard.value?.selection.nodeId ?? "");
const selectedPeerId = computed(() => dashboard.value?.selection.peerId ?? "");
const selectedPeer = computed(() => dashboard.value?.selectedPeer ?? null);
const boardWidth = computed(() => compactCanvas.value
  ? 360
  : Math.max(760, 360 + Math.min(Math.max(peers.value.length, 1), 4) * 265));
const boardHeight = computed(() => compactCanvas.value
  ? Math.max(410, 175 + peers.value.length * 128)
  : Math.max(410, 70 + Math.ceil(Math.max(peers.value.length, 1) / 4) * 128));
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
  if (suppressPeerClick) return;
  requestSelection(node.value?.id ?? null, peerId);
}

function openResource(target: ResourceWorkspaceTarget): void {
  window.dispatchEvent(new CustomEvent("birdbox:workspace-resource-open", { detail: { target } }));
}

function storageKey(): string | null {
  return node.value ? `birdbox-ebgp-canvas:v2:${node.value.id}:${compactCanvas.value ? "compact" : "wide"}` : null;
}

function defaultPosition(key: string, index: number): CanvasPosition {
  if (compactCanvas.value) {
    return key === ROOT_KEY
      ? { x: Math.round((boardWidth.value - 248) / 2), y: 28 }
      : { x: Math.round((boardWidth.value - 240) / 2), y: 174 + index * 128 };
  }
  if (key === ROOT_KEY) return { x: 42, y: Math.max(42, Math.round(boardHeight.value / 2 - 58)) };
  return {
    x: 350 + (index % 4) * 265,
    y: 42 + Math.floor(index / 4) * 128,
  };
}

function clampPosition(key: string, value: CanvasPosition): CanvasPosition {
  const width = key === ROOT_KEY ? 248 : 240;
  const height = key === ROOT_KEY ? 116 : 104;
  return {
    x: Math.max(8, Math.min(Math.round(value.x), boardWidth.value - width - 8)),
    y: Math.max(8, Math.min(Math.round(value.y), boardHeight.value - height - 8)),
  };
}

function loadCanvasLayout(): void {
  let stored: Record<string, CanvasPosition> = {};
  const key = storageKey();
  if (key) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
    } catch {
      stored = {};
    }
  }
  const next: Record<string, CanvasPosition> = {};
  if (node.value) next[ROOT_KEY] = clampPosition(ROOT_KEY, stored[ROOT_KEY] ?? defaultPosition(ROOT_KEY, 0));
  peers.value.forEach((peer, index) => {
    next[peer.id] = clampPosition(peer.id, stored[peer.id] ?? defaultPosition(peer.id, index));
  });
  canvasLayout.value = next;
}

function saveCanvasLayout(): void {
  const key = storageKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(canvasLayout.value));
  } catch {
    // Layout persistence is optional in restricted browser contexts.
  }
}

function resetCanvasLayout(): void {
  canvasLayout.value = Object.fromEntries([
    ...(node.value ? [[ROOT_KEY, defaultPosition(ROOT_KEY, 0)] as const] : []),
    ...peers.value.map((peer, index) => [peer.id, defaultPosition(peer.id, index)] as const),
  ]);
  saveCanvasLayout();
}

function positionFor(key: string, index = 0): CanvasPosition {
  return canvasLayout.value[key] ?? defaultPosition(key, index);
}

function startCanvasDrag(event: PointerEvent, key: string): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dragging.value = {
    key,
    dx: event.clientX - rect.left,
    dy: event.clientY - rect.top,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function moveCanvasNode(event: PointerEvent): void {
  const drag = dragging.value;
  if (!drag || !board.value) return;
  const rect = board.value.getBoundingClientRect();
  if (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3) drag.moved = true;
  canvasLayout.value = {
    ...canvasLayout.value,
    [drag.key]: clampPosition(drag.key, {
      x: event.clientX - rect.left - drag.dx,
      y: event.clientY - rect.top - drag.dy,
    }),
  };
}

function stopCanvasDrag(): void {
  if (!dragging.value) return;
  suppressPeerClick = dragging.value.moved;
  dragging.value = null;
  saveCanvasLayout();
  window.setTimeout(() => {
    suppressPeerClick = false;
  }, 0);
}

watch(
  [() => node.value?.id, () => peers.value.map((peer) => peer.id).join("|"), compactCanvas],
  loadCanvasLayout,
  { immediate: true },
);

function handleCanvasMedia(event: MediaQueryListEvent): void {
  compactCanvas.value = event.matches;
}

canvasMedia.addEventListener("change", handleCanvasMedia);
onBeforeUnmount(() => canvasMedia.removeEventListener("change", handleCanvasMedia));

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
      <div class="topology-actions">
        <span class="updated-at">{{ updatedAtLabel }}</span>
        <button class="secondary-button compact-button" type="button" :disabled="!node" @click="resetCanvasLayout">重置位置</button>
      </div>
    </div>
    <div class="ebgp-canvas" aria-label="eBGP 会话画布">
      <div
        ref="board"
        class="ebgp-canvas-board"
        :style="{ width: `${boardWidth}px`, height: `${boardHeight}px` }"
        @pointermove="moveCanvasNode"
        @pointerup="stopCanvasDrag"
        @pointercancel="stopCanvasDrag"
      >
        <div v-if="!node" class="topology-empty">尚无受管节点</div>
        <template v-else>
          <svg class="ebgp-canvas-edges" aria-hidden="true">
            <line
              v-for="(peer, index) in peers"
              :key="peer.id"
              :class="{
                established: peer.protocol?.established,
                selected: peer.id === selectedPeerId,
              }"
              :x1="positionFor(ROOT_KEY).x + 124"
              :y1="positionFor(ROOT_KEY).y + 58"
              :x2="positionFor(peer.id, index).x + 120"
              :y2="positionFor(peer.id, index).y + 52"
            />
          </svg>

          <article
            class="ebgp-canvas-node ebgp-local-node"
            :class="{ online: nodeOnline }"
            :style="{
              left: `${positionFor(ROOT_KEY).x}px`,
              top: `${positionFor(ROOT_KEY).y}px`,
            }"
            @pointerdown="startCanvasDrag($event, ROOT_KEY)"
          >
            <div class="ebgp-canvas-node-head">
              <span class="node-icon">N</span>
              <span class="status-pill" :class="nodeOnline ? 'online' : 'offline'">
                {{ nodeOnline ? "可管理" : "不可达" }}
              </span>
            </div>
            <strong>{{ node.name }}</strong>
            <small>{{ node.routerId }} · AS 本端 · Port {{ node.listenPort }}</small>
          </article>

          <button
            v-for="(peer, index) in peers"
            :key="peer.id"
            class="ebgp-canvas-node ebgp-peer-node"
            :class="{
              selected: peer.id === selectedPeerId,
              established: peer.protocol?.established,
            }"
            type="button"
            :title="`${peer.name} · AS${peer.asn} · ${peer.address}:${peer.port}`"
            :style="{
              left: `${positionFor(peer.id, index).x}px`,
              top: `${positionFor(peer.id, index).y}px`,
            }"
            :aria-label="`选择 eBGP Peer ${peer.name}`"
            @pointerdown="startCanvasDrag($event, peer.id)"
            @click="selectTopologyPeer(peer.id)"
          >
            <div class="ebgp-canvas-node-head">
              <span class="node-icon">P</span>
              <span class="status-pill" :class="protocolPresentation(peer).className">{{ protocolPresentation(peer).label }}</span>
            </div>
            <strong>{{ peer.name }} · AS{{ peer.asn }}</strong>
            <small>{{ peer.address }}:{{ peer.port }}</small>
          </button>

          <div v-if="peers.length === 0" class="ebgp-canvas-empty">尚无远端 Peer</div>
        </template>
      </div>
    </div>
  </section>
</template>
