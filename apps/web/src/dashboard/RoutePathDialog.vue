<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import type { RoutePathResponse } from "@birdbox/contracts/api";

import { api } from "../shared/api-client";
import { useDashboardStore } from "./dashboard-store";

const { dashboard } = useDashboardStore();
const dialog = ref<HTMLDialogElement | null>(null);
const target = ref("");
const result = ref<RoutePathResponse | null>(null);
const pending = ref(false);
const errorMessage = ref("");
let requestId = 0;
let controller: AbortController | null = null;

const node = computed(() => dashboard.value?.node ?? null);
const targetFamily = computed(() => {
  const value = target.value.trim();
  if (value.includes(":")) return "IPv6";
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return "IPv4";
  return "自动识别";
});

function close(): void {
  controller?.abort();
  controller = null;
  requestId += 1;
  pending.value = false;
  dialog.value?.close();
}

async function query(): Promise<void> {
  const selectedNode = node.value;
  const address = target.value.trim();
  if (!selectedNode || !address || pending.value) return;
  controller?.abort();
  controller = new AbortController();
  const currentRequest = ++requestId;
  pending.value = true;
  errorMessage.value = "";
  result.value = null;
  try {
    const response = await api<RoutePathResponse>(
      `/api/nodes/${encodeURIComponent(selectedNode.id)}/route-path?target=${encodeURIComponent(address)}`,
      { signal: controller.signal, timeoutMs: 30_000 },
    );
    if (currentRequest !== requestId) return;
    result.value = response;
    if (!response.reachable && response.error) errorMessage.value = response.error;
  } catch (error) {
    if (controller?.signal.aborted || currentRequest !== requestId) return;
    errorMessage.value = error instanceof Error ? error.message : "路径查询失败";
  } finally {
    if (currentRequest === requestId) {
      pending.value = false;
      controller = null;
    }
  }
}

function open(): void {
  if (!node.value) return;
  controller?.abort();
  requestId += 1;
  target.value = "";
  result.value = null;
  errorMessage.value = "";
  pending.value = false;
  dialog.value?.showModal();
}

function hopKey(address: string | null, interfaceName: string | null, index: number): string {
  return `${address ?? "device"}-${interfaceName ?? ""}-${index}`;
}

onMounted(() => window.addEventListener("birdbox:route-path-open", open));
onBeforeUnmount(() => {
  window.removeEventListener("birdbox:route-path-open", open);
  controller?.abort();
});
</script>

<template>
  <dialog ref="dialog" class="route-dialog route-path-dialog" aria-labelledby="routePathDialogTitle" @cancel.prevent="close">
    <div class="route-dialog-shell">
      <header class="route-dialog-head">
        <div><p class="eyebrow">ROUTE PATH</p><h2 id="routePathDialogTitle">查询到目标 IP 的路径</h2><span>{{ node?.name ?? "节点" }} · 从当前 BIRD 路由表查询</span></div>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭路径查询" @click="close">×</button>
      </header>
      <form class="route-path-form" @submit.prevent="query">
        <label class="field full-width"><span class="field-label">目标 IP</span><input v-model="target" type="text" inputmode="url" placeholder="例如 8.8.8.8 或 2001:4860:4860::8888" autocomplete="off" required /><span class="field-hint">地址族：{{ targetFamily }}</span></label>
        <button class="primary-button" type="submit" :disabled="pending || !target.trim()">{{ pending ? "正在查询" : "查询路径" }}</button>
      </form>
      <div class="route-dialog-meta"><span>{{ result ? `${result.routes.length}${result.truncated ? "+" : ""} 条候选路由` : "尚未查询" }}</span><span>{{ result?.table ? `Table ${result.table}` : "-" }}</span></div>
      <div class="route-dialog-body route-path-body" aria-live="polite">
        <div v-if="pending" class="route-dialog-state"><div class="route-loading-copy"><i aria-hidden="true"></i><span>正在读取节点路由表</span></div></div>
        <div v-else-if="errorMessage" class="route-dialog-state error"><p>{{ errorMessage }}</p></div>
        <div v-else-if="result && result.routes.length === 0" class="route-dialog-state">没有找到到达该目标 IP 的路由</div>
        <template v-else-if="result">
          <ol class="route-list"><li v-for="route in result.routes" :key="`${route.prefix}:${route.summary}`" class="route-entry route-path-entry"><details open><summary><code class="route-entry-prefix">{{ route.prefix }}</code><span class="route-entry-summary">{{ route.summary }}</span></summary><div class="route-path-hops"><span v-for="(hop, index) in route.nextHops" :key="hopKey(hop.address, hop.interface, index)" class="route-path-hop"><strong>{{ index + 1 }}</strong><code>{{ hop.address ?? "直连接口" }}</code><span v-if="hop.interface">on {{ hop.interface }}</span></span><span v-if="route.nextHops.length === 0" class="field-hint">未解析到下一跳，请展开查看原始路由信息。</span></div><pre>{{ route.details || route.summary }}</pre></details></li></ol>
          <p v-if="result.truncated" class="route-list-notice">候选路由较多，仅显示前 {{ result.limit }} 条。</p>
        </template>
      </div>
    </div>
  </dialog>
</template>
