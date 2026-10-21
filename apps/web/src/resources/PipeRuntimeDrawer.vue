<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PipeRoutesResponse, PipeRuntimeResponse } from "@birdbox/contracts/api";
import { resourceAppliesToNode } from "@birdbox/contracts/resource-scope";
import { useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
const { dashboard } = useDashboardStore();
const dialog = ref<HTMLDialogElement>(), id = ref(""), nodeId = ref(""), side = ref<"primary" | "peer">("primary"), target = ref("");
const runtime = ref<PipeRuntimeResponse | null>(null), routes = ref<PipeRoutesResponse | null>(null);
const runtimeError = ref(""), routeError = ref(""), loading = ref(false), routeLoading = ref(false);
const resource = computed(() => dashboard.value?.inventory.pipeProtocols?.find(p => p.id === id.value));
const nodes = computed(() => dashboard.value?.inventory.nodes.filter(n => resource.value && resourceAppliesToNode(resource.value, n.id)) ?? []);
let runtimeGeneration = 0, routeGeneration = 0, runtimeController: AbortController | null = null, routeController: AbortController | null = null;
function clearRoutes() { routeGeneration++; routeController?.abort(); routes.value = null; routeError.value = ""; routeLoading.value = false; }
watch([nodeId, side, target], clearRoutes, { flush: "sync" });
watch([nodeId, side], () => { if (dialog.value?.open) void loadRoutes(); }, { flush: "sync" });
function close() { runtimeGeneration++; runtimeController?.abort(); clearRoutes(); dialog.value?.close(); }
async function loadRuntime() {
  const request = ++runtimeGeneration; runtimeController?.abort(); runtimeController = new AbortController(); const signal = runtimeController.signal;
  runtime.value = null; runtimeError.value = ""; loading.value = true;
  try { const result = await api<PipeRuntimeResponse>(`/api/pipes/${encodeURIComponent(id.value)}/runtime`, { signal, timeoutMs: 35_000 }); if (request === runtimeGeneration) runtime.value = result; }
  catch (e) { if (!signal.aborted && request === runtimeGeneration) runtimeError.value = (e as Error).message; }
  finally { if (request === runtimeGeneration) loading.value = false; }
}
async function loadRoutes() {
  clearRoutes(); if (!nodeId.value) return;
  const request = routeGeneration; routeController = new AbortController(); const signal = routeController.signal; routeLoading.value = true;
  try {
    const params = new URLSearchParams({ nodeId: nodeId.value, side: side.value, ...(target.value.trim() ? { target: target.value.trim() } : {}) });
    const result = await api<PipeRoutesResponse>(`/api/pipes/${encodeURIComponent(id.value)}/routes?${params}`, { signal, timeoutMs: 35_000 });
    if (request === routeGeneration) routes.value = result;
  } catch (e) { if (!signal.aborted && request === routeGeneration) routeError.value = (e as Error).message; }
  finally { if (request === routeGeneration) routeLoading.value = false; }
}
function open(e: CustomEvent<{ id: string }>) { close(); id.value = e.detail.id; nodeId.value = nodes.value[0]?.id ?? ""; side.value = "primary"; target.value = ""; dialog.value?.showModal(); void loadRuntime(); void loadRoutes(); }
const labels: Record<string, string> = { up: "运行中", down: "未运行", start: "启动中", disabled: "配置已停用", not_configured: "协议未加载", error: "节点检查失败", unknown: "未知" };
onMounted(() => window.addEventListener("birdbox:pipe-runtime-open", open));
onBeforeUnmount(() => { close(); window.removeEventListener("birdbox:pipe-runtime-open", open); });
</script>
<template>
  <dialog ref="dialog" id="pipeRuntimeDialog" class="editor-dialog pipe-runtime protocol-runtime protocol-editor" aria-labelledby="pipeRuntimeTitle" @cancel.prevent="close">
    <header class="dialog-head protocol-dialog-head"><span class="dialog-icon">⇄</span><div><p class="eyebrow">Pipe 运行态</p><h2 id="pipeRuntimeTitle">{{ resource?.label }}</h2><p class="protocol-description">{{ resource?.table.name }} ⇄ {{ resource?.peerTable.name }}</p></div><button type="button" class="secondary-button compact-command protocol-close" @click="close">关闭</button></header>
    <div class="protocol-runtime-toolbar"><button type="button" class="secondary-button compact-command" :disabled="loading" @click="loadRuntime">{{ loading ? '检查中…' : '刷新协议状态' }}</button></div>
    <div class="protocol-runtime-content">
    <p v-if="runtimeError" role="alert">{{ runtimeError }}</p>
    <p v-if="runtime">检查时间：{{ new Date(runtime.lastCheckedAt).toLocaleString() }}</p>
    <section v-for="item in runtime?.nodes ?? []" :key="item.nodeId" class="pipe-runtime-node protocol-runtime-card"><h3>{{ nodes.find(n => n.id === item.nodeId)?.name ?? item.nodeId }} · {{ labels[item.state] }}</h3><p v-if="item.error" role="alert">{{ item.error }}</p><p>主表 → 对端表：{{ item.primary.exported ?? '未知' }} 条 · 对端表 → 主表：{{ item.primary.imported ?? '未知' }} 条</p><details><summary>原始协议详情</summary><pre>{{ item.raw || '无可用详情' }}</pre></details></section>
    <div class="protocol-runtime-section-title"><h3>两侧路由表</h3><p>表中路由保留原协议来源；结合协议统计判断传递结果。</p></div>
    <div class="pipe-route-controls"><label>节点<select v-model="nodeId" aria-label="路由节点"><option v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label><label>路由表<select v-model="side" aria-label="路由表侧"><option value="primary">主表 · {{ resource?.table.name }}</option><option value="peer">对端表 · {{ resource?.peerTable.name }}</option></select></label></div>
    <form class="protocol-route-query pipe-route-controls" @submit.prevent="loadRoutes"><label>目标 IP（可选）<input v-model="target" placeholder="查询匹配目标 IP 的路由" aria-label="路由目标 IP"></label><button class="primary-button" :disabled="routeLoading" type="submit">{{ routeLoading ? '查询中…' : '查询路由' }}</button></form>
    <p v-if="routeError" role="alert">{{ routeError }}</p><p v-if="routes">{{ routes.table }} · {{ routes.routes.length }} 条{{ routes.truncated ? '（已截断，最多显示 200 条，请使用目标 IP 缩小范围）' : '' }}</p>
    <details v-for="(route, index) in routes?.routes ?? []" :key="index" class="pipe-route protocol-runtime-route"><summary><strong>{{ route.prefix }}</strong> {{ route.summary }}</summary><pre>{{ route.details }}</pre></details><p v-if="routes && !routes.routes.length">该表暂无匹配路由。</p>
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
