<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { StaticRoutesResponse, StaticRuntimeResponse } from "@birdbox/contracts/api";
import { useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
const { dashboard } = useDashboardStore();
const dialog = ref<HTMLDialogElement>(), id = ref(""), target = ref("");
const runtime = ref<StaticRuntimeResponse | null>(null), routes = ref<StaticRoutesResponse | null>(null);
const runtimeError = ref(""), routeError = ref(""), loading = ref(false), routeLoading = ref(false);
const resource = computed(() => dashboard.value?.inventory.staticProtocols.find(item => item.id === id.value));
const node = computed(() => dashboard.value?.inventory.nodes.find(item => item.id === resource.value?.nodeId));
let generation = 0, routeGeneration = 0, runtimeController: AbortController | null = null, routeController: AbortController | null = null;
function clearRoutes() { routeGeneration++; routeController?.abort(); routes.value = null; routeError.value = ""; routeLoading.value = false; }
watch(target, clearRoutes, { flush: "sync" });
function close() { generation++; runtimeController?.abort(); clearRoutes(); dialog.value?.close(); }
async function loadRuntime() {
  const request = ++generation; runtimeController?.abort(); runtimeController = new AbortController(); const signal = runtimeController.signal;
  runtime.value = null; runtimeError.value = ""; loading.value = true;
  try { const result = await api<StaticRuntimeResponse>(`/api/statics/${encodeURIComponent(id.value)}/runtime`, { signal, timeoutMs: 35_000 }); if (request === generation) runtime.value = result; }
  catch (e) { if (!signal.aborted && request === generation) runtimeError.value = (e as Error).message; }
  finally { if (request === generation) loading.value = false; }
}
async function loadRoutes() {
  clearRoutes(); const request = routeGeneration; routeController = new AbortController(); const signal = routeController.signal; routeLoading.value = true;
  try {
    const params = new URLSearchParams(target.value.trim() ? { target: target.value.trim() } : {});
    const result = await api<StaticRoutesResponse>(`/api/statics/${encodeURIComponent(id.value)}/routes?${params}`, { signal, timeoutMs: 35_000 });
    if (request === routeGeneration) routes.value = result;
  } catch (e) { if (!signal.aborted && request === routeGeneration) routeError.value = (e as Error).message; }
  finally { if (request === routeGeneration) routeLoading.value = false; }
}
function open(e: CustomEvent<{ id: string }>) { close(); id.value = e.detail.id; target.value = ""; dialog.value?.showModal(); void loadRuntime(); void loadRoutes(); }
function edit() { const resourceId = id.value; close(); window.dispatchEvent(new CustomEvent("birdbox:resource-edit", { detail: { kind: "statics", id: resourceId } })); }
const labels: Record<string, string> = { up: "运行中", down: "未运行", start: "启动中", disabled: "配置已停用", not_configured: "协议未加载", error: "节点检查失败", unknown: "未知" };
onMounted(() => window.addEventListener("birdbox:static-runtime-open", open));
onBeforeUnmount(() => { close(); window.removeEventListener("birdbox:static-runtime-open", open); });
</script>
<template>
  <dialog ref="dialog" id="staticRuntimeDialog" class="editor-dialog static-runtime protocol-runtime protocol-editor" aria-labelledby="staticRuntimeTitle" @cancel.prevent="close">
    <header class="dialog-head protocol-dialog-head"><span class="dialog-icon">S</span><div><p class="eyebrow">Static 运行态</p><h2 id="staticRuntimeTitle">{{ resource?.label }}</h2><p class="protocol-description">{{ node?.name }} · {{ runtime?.table ?? resource?.table?.name }}</p></div><button type="button" class="secondary-button compact-command protocol-close" @click="close">关闭</button></header>
    <div class="protocol-runtime-toolbar"><button type="button" class="secondary-button compact-command" :disabled="loading" @click="loadRuntime">{{ loading ? '检查中…' : '刷新协议状态' }}</button><button type="button" class="secondary-button compact-command" @click="edit">编辑配置</button></div>
    <div class="protocol-runtime-content">
    <p v-if="runtimeError" role="alert">{{ runtimeError }}</p>
    <section v-if="runtime" class="static-runtime-status protocol-runtime-card"><h3>{{ labels[runtime.state] }}</h3><p>检查时间：{{ new Date(runtime.lastCheckedAt).toLocaleString() }}</p><p v-if="runtime.error" role="alert">{{ runtime.error }}</p><p>导入 BIRD 表：{{ runtime.imported ?? '未知' }} 条</p><details><summary>原始协议详情</summary><pre>{{ runtime.raw || '无可用详情' }}</pre></details></section>
    <div class="protocol-runtime-section-title"><h3>该 Static 产生的路由</h3><p>显示当前 BIRD 表中的该协议路由。未选中路由也可能存在；是否写入系统内核需要检查 Kernel 协议。</p></div>
    <form class="protocol-route-query static-runtime-actions" @submit.prevent="loadRoutes"><label>目标 IP（可选）<input v-model="target" placeholder="查询匹配目标 IP 的路由" aria-label="Static 路由目标 IP"></label><button class="primary-button" :disabled="routeLoading" type="submit">{{ routeLoading ? '查询中…' : '查询路由' }}</button></form>
    <p v-if="routeError" role="alert">{{ routeError }}</p><p v-if="routes">{{ routes.table }} · {{ routes.routes.length }} 条{{ routes.truncated ? '（已截断，最多显示 200 条，请使用目标 IP 缩小范围）' : '' }}</p>
    <details v-for="(route, index) in routes?.routes ?? []" :key="index" class="static-runtime-route protocol-runtime-route"><summary><strong>{{ route.prefix }}</strong> {{ route.summary }}</summary><pre>{{ route.details }}</pre></details><p v-if="routes && !routes.routes.length">暂无匹配路由。若协议已启用，请检查下一跳可达性、BFD、链路状态及 Import 策略。</p>
    </div>
  </dialog>
</template>
<style scoped>
.protocol-runtime-content { min-height: 0; overflow: auto; padding: 20px 24px; overscroll-behavior: contain; }
.protocol-runtime-content h3 { margin: 0 0 8px; font-size: 14px; }
.protocol-runtime-content p { font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.static-runtime-actions, .pipe-route-controls { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
.static-runtime-actions label, .pipe-route-controls label { display: grid; gap: 6px; flex: 1; min-width: 0; color: var(--ink-soft); font-size: 12px; font-weight: 650; }
pre { max-width: 100%; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
@media (max-width: 600px) {
  .protocol-runtime-content { padding: 16px; }
  .static-runtime-actions, .pipe-route-controls { display: grid; grid-template-columns: minmax(0, 1fr); }
}
</style>
