<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import type { AddressFamily } from "@birdbox/contracts/inventory";
import type { DashboardPeer, RouteDetailsResponse } from "@birdbox/contracts/api";

import { api } from "../shared/api-client";
import { useDashboardStore } from "./dashboard-store";

type Direction = "import" | "export";

const { dashboard } = useDashboardStore();
const dialog = ref<HTMLDialogElement | null>(null);
const peerId = ref<string | null>(null);
const family = ref<AddressFamily>("ipv4");
const direction = ref<Direction>("import");
const result = ref<RouteDetailsResponse | null>(null);
const pending = ref(false);
const errorMessage = ref("");
const cache = new Map<string, RouteDetailsResponse>();
let requestId = 0;
let controller: AbortController | null = null;

const peer = computed<DashboardPeer | null>(() => dashboard.value?.peers.find((item) => item.id === peerId.value) ?? null);
const enabledFamilies = computed<AddressFamily[]>(() => (["ipv4", "ipv6"] as const)
  .filter((item) => peer.value?.session?.channels[item].enabled));
const subtitle = computed(() => peer.value?.session
  ? `${dashboard.value?.node?.name ?? "节点"} · ${peer.value.session.protocolName} · ${peer.value.address}`
  : "");
const runtimeCount = computed(() => {
  const selectedPeer = peer.value;
  if (!selectedPeer) return null;
  const channel = selectedPeer.protocol?.channels?.[family.value];
  const fallback = enabledFamilies.value.length === 1 ? selectedPeer.protocol : null;
  return channel?.[direction.value === "import" ? "imported" : "exported"]
    ?? fallback?.[direction.value === "import" ? "imported" : "exported"]
    ?? null;
});
const countLabel = computed(() => {
  if (pending.value) return "正在读取";
  if (errorMessage.value) return "读取失败";
  if (!result.value) return "0 条路由";
  if (runtimeCount.value === null) return `${result.value.routes.length}${result.value.truncated ? "+" : ""} 条路由`;
  return result.value.truncated
    ? `${runtimeCount.value} 条路由 · 当前显示 ${result.value.routes.length} 条`
    : `${runtimeCount.value} 条路由`;
});

function cacheKey(): string {
  return `${family.value}:${direction.value}`;
}

async function load(force = false): Promise<void> {
  const selectedPeer = peer.value;
  if (!selectedPeer?.session) return;
  const key = cacheKey();
  if (!force && cache.has(key)) {
    result.value = cache.get(key) ?? null;
    errorMessage.value = "";
    return;
  }
  controller?.abort();
  controller = new AbortController();
  const currentRequest = ++requestId;
  pending.value = true;
  errorMessage.value = "";
  result.value = null;
  try {
    const response = await api<RouteDetailsResponse>(
      `/api/sessions/${encodeURIComponent(selectedPeer.session.id)}/routes?family=${family.value}&direction=${direction.value}`,
      { signal: controller.signal, timeoutMs: 30_000 },
    );
    if (currentRequest !== requestId) return;
    cache.set(key, response);
    result.value = response;
  } catch (error) {
    if (controller?.signal.aborted || currentRequest !== requestId) return;
    errorMessage.value = error instanceof Error ? error.message : "读取 BIRD 路由失败";
  } finally {
    if (currentRequest === requestId) {
      pending.value = false;
      controller = null;
    }
  }
}

function selectFamily(next: AddressFamily): void {
  if (!enabledFamilies.value.includes(next) || family.value === next) return;
  family.value = next;
  void load();
}

function selectDirection(next: Direction): void {
  if (direction.value === next) return;
  direction.value = next;
  void load();
}

function open(event: CustomEvent<{ peerId: string }>): void {
  const selectedPeer = dashboard.value?.peers.find((item) => item.id === event.detail.peerId);
  const families = (["ipv4", "ipv6"] as const).filter((item) => selectedPeer?.session?.channels[item].enabled);
  if (!selectedPeer?.session || !families.length) return;
  controller?.abort();
  requestId += 1;
  cache.clear();
  peerId.value = selectedPeer.id;
  family.value = families[0] ?? "ipv4";
  direction.value = "import";
  result.value = null;
  errorMessage.value = "";
  dialog.value?.showModal();
  void load();
}

function close(): void {
  controller?.abort();
  controller = null;
  requestId += 1;
  pending.value = false;
  dialog.value?.close();
}

onMounted(() => window.addEventListener("birdbox:routes-open", open));
onBeforeUnmount(() => {
  window.removeEventListener("birdbox:routes-open", open);
  controller?.abort();
});
</script>

<template>
  <dialog ref="dialog" class="route-dialog" aria-labelledby="routeDialogTitle" @cancel.prevent="close">
    <div class="route-dialog-shell">
      <header class="route-dialog-head"><div><p class="eyebrow">BIRD ROUTES</p><h2 id="routeDialogTitle">{{ peer?.name ?? "会话" }} 路由</h2><span>{{ subtitle }}</span></div><button class="icon-button" type="button" title="关闭" aria-label="关闭路由详情" @click="close">×</button></header>
      <div class="route-dialog-toolbar">
        <div class="route-segmented" role="group" aria-label="路由地址族"><button v-for="item in (['ipv4', 'ipv6'] as const)" :key="item" type="button" :class="{ active: family === item }" :disabled="!enabledFamilies.includes(item)" :aria-pressed="family === item" @click="selectFamily(item)">{{ item === "ipv4" ? "IPv4" : "IPv6" }}</button></div>
        <div class="route-segmented" role="group" aria-label="路由方向"><button type="button" :class="{ active: direction === 'import' }" :aria-pressed="direction === 'import'" @click="selectDirection('import')">导入</button><button type="button" :class="{ active: direction === 'export' }" :aria-pressed="direction === 'export'" @click="selectDirection('export')">导出</button></div>
      </div>
      <div class="route-dialog-meta"><span>{{ countLabel }}</span><span>{{ result?.table ? `Table ${result.table}` : "-" }}</span></div>
      <div class="route-dialog-body" aria-live="polite">
        <div v-if="pending" class="route-dialog-state"><div class="route-loading-copy"><i aria-hidden="true"></i><span>正在读取 BIRD 路由</span></div></div>
        <div v-else-if="errorMessage" class="route-dialog-state error"><div><p>{{ errorMessage }}</p><button class="secondary-button" type="button" @click="load(true)">重试</button></div></div>
        <div v-else-if="result && result.routes.length === 0" class="route-dialog-state">{{ direction === "import" ? "没有已接受的导入路由" : "没有当前导出路由" }}</div>
        <template v-else-if="result">
          <div v-if="result.truncated" class="route-list-notice">路由数量较多，仅显示前 {{ result.limit }} 个前缀</div>
          <ol class="route-list"><li v-for="route in result.routes" :key="route.prefix" class="route-entry"><details><summary><code class="route-entry-prefix">{{ route.prefix }}</code><span class="route-entry-summary">{{ route.summary }}</span></summary><pre>{{ route.details || route.summary }}</pre></details></li></ol>
        </template>
      </div>
    </div>
  </dialog>
</template>
