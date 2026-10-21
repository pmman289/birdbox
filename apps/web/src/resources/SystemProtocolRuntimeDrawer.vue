<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { StaticRoutesResponse, SystemProtocolKind, SystemProtocolRuntimeResponse } from "@birdbox/contracts/api";
import type { AddressFamily } from "@birdbox/contracts/inventory";
import { api } from "../shared/api-client";
import { useDashboardStore } from "../dashboard/dashboard-store";
const { dashboard } = useDashboardStore();
const dialog = ref<HTMLDialogElement>(), id = ref(""), kind = ref<SystemProtocolKind>("directs");
const nodeId = ref(""), family = ref<AddressFamily>("ipv4"), direction = ref<"import" | "export">("import"), target = ref("");
const runtime = ref<SystemProtocolRuntimeResponse | null>(null), routes = ref<StaticRoutesResponse | null>(null);
const loading = ref(false), routeLoading = ref(false), runtimeError = ref(""), routeError = ref("");
const title = computed(() => kind.value === "directs" ? "Direct" : "Kernel");
const resource = computed(() => (kind.value === "directs" ? dashboard.value?.inventory.directProtocols : dashboard.value?.inventory.kernelProtocols)?.find(item => item.id === id.value));
const nodes = computed(() => dashboard.value?.inventory.nodes.filter(node => resource.value && ("nodeId" in resource.value ? resource.value.nodeId === node.id : resource.value.nodeIds === null || resource.value.nodeIds.includes(node.id))) ?? []);
const labels: Record<string, string> = { up: "运行中", down: "未运行", start: "启动中", disabled: "配置已停用", not_configured: "协议未加载", error: "节点检查失败", unknown: "未知" };
let generation = 0, routeGeneration = 0;
let runtimeController: AbortController | null = null, routeController: AbortController | null = null;
function clearRoutes() { routeGeneration++; routeController?.abort(); routeController = null; routes.value = null; routeError.value = ""; routeLoading.value = false; }
watch([nodeId, family, direction, target], clearRoutes, { flush: "sync" });
watch([nodeId, family, direction], () => { if (dialog.value?.open) void loadRoutes(); });
function close() { generation++; runtimeController?.abort(); loading.value = false; clearRoutes(); dialog.value?.close(); }
async function loadRuntime() {
  const request = ++generation; runtimeController?.abort(); runtimeController = new AbortController(); const signal = runtimeController.signal;
  runtime.value = null; runtimeError.value = ""; loading.value = true;
  try { const result = await api<SystemProtocolRuntimeResponse>(`/api/${kind.value}/${encodeURIComponent(id.value)}/runtime`, { signal, timeoutMs: 35_000 }); if (request === generation && !signal.aborted) runtime.value = result; }
  catch (e) { if (request === generation && !signal.aborted) runtimeError.value = (e as Error).message; }
  finally { if (request === generation) loading.value = false; }
}
async function loadRoutes() {
  clearRoutes(); if (!nodeId.value) return;
  const request = routeGeneration; routeController = new AbortController(); const signal = routeController.signal; routeLoading.value = true;
  const params = new URLSearchParams({ nodeId: nodeId.value, family: family.value, direction: direction.value, ...(target.value.trim() ? { target: target.value.trim() } : {}) });
  try { const result = await api<StaticRoutesResponse>(`/api/${kind.value}/${encodeURIComponent(id.value)}/routes?${params}`, { signal, timeoutMs: 35_000 }); if (request === routeGeneration && !signal.aborted) routes.value = result; }
  catch (e) { if (request === routeGeneration && !signal.aborted) routeError.value = (e as Error).message; }
  finally { if (request === routeGeneration) routeLoading.value = false; }
}
async function open(e: CustomEvent<{ kind: SystemProtocolKind; id: string }>) {
  close(); kind.value = e.detail.kind; id.value = e.detail.id; runtime.value = null; target.value = ""; direction.value = kind.value === "kernels" ? "export" : "import";
  nodeId.value = nodes.value[0]?.id ?? ""; family.value = resource.value?.ipv4 ? "ipv4" : "ipv6";
  dialog.value?.showModal(); void loadRuntime(); void loadRoutes();
}
function edit() { const detail = { kind: kind.value, id: id.value }; close(); window.dispatchEvent(new CustomEvent("birdbox:resource-edit", { detail })); }
onMounted(() => window.addEventListener("birdbox:system-runtime-open", open));
onBeforeUnmount(() => { close(); window.removeEventListener("birdbox:system-runtime-open", open); });
</script>
<template>
  <dialog id="systemProtocolRuntimeDialog" ref="dialog" class="editor-dialog protocol-editor protocol-runtime system-runtime-dialog" aria-labelledby="systemRuntimeTitle" @cancel.prevent="close">
    <header class="dialog-head protocol-dialog-head"><div><p class="eyebrow">{{ title }} 运行态</p><h2 id="systemRuntimeTitle">{{ resource?.label }}</h2><p class="protocol-description">{{ resource?.name }} · 检查实际协议状态及路由</p></div><button class="secondary-button compact-command" type="button" @click="close">关闭</button></header>
    <div class="protocol-runtime-toolbar"><button class="secondary-button compact-command" type="button" :disabled="loading" @click="loadRuntime">{{ loading ? '检查中…' : '刷新协议状态' }}</button><button class="secondary-button compact-command" type="button" @click="edit">编辑配置</button></div>
    <div class="system-runtime-content"><p v-if="runtimeError" role="alert">{{ runtimeError }}</p>
      <section v-for="node in runtime?.nodes ?? []" :key="node.nodeId" class="protocol-runtime-card"><h3>{{ nodes.find(n => n.id === node.nodeId)?.name ?? node.nodeId }}</h3><p>检查时间：{{ new Date(node.lastCheckedAt).toLocaleString() }}</p><article v-for="instance in node.protocols" :key="instance.name"><h4>{{ instance.name }} · {{ labels[instance.state] }}</h4><p v-if="instance.error" role="alert">{{ instance.error }}</p><p>导入 {{ instance.imported ?? '未知' }} 条 · 导出 {{ instance.exported ?? '未知' }} 条</p><details><summary>原始协议详情</summary><pre>{{ instance.raw || '无可用详情' }}</pre></details></article></section>
      <h3>{{ kind === 'directs' ? '该协议学习的直连路由' : 'Kernel 导入 / 导出路由' }}</h3><p class="protocol-help">{{ kind === 'directs' ? '这里只显示该 Direct 产生的 BIRD 路由；向 Linux 或其它协议发布由相应的导出策略控制。' : '导出查询显示 BIRD 当前可导出给 Kernel 的路由；确认内核实际安装结果还需检查节点 Linux 路由表。' }}</p>
      <form class="system-route-controls" @submit.prevent="loadRoutes"><label class="protocol-form-field">节点<select v-model="nodeId" aria-label="协议路由节点"><option v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label><label class="protocol-form-field">地址族<select v-model="family" aria-label="协议路由地址族"><option v-if="resource?.ipv4" value="ipv4">IPv4</option><option v-if="resource?.ipv6" value="ipv6">IPv6</option></select></label><label v-if="kind === 'kernels'" class="protocol-form-field">方向<select v-model="direction" aria-label="Kernel 路由方向"><option value="import">Linux → BIRD</option><option value="export">BIRD → Linux</option></select></label><label class="protocol-form-field">目标 IP（可选）<input v-model="target" aria-label="协议路由目标 IP" placeholder="例如 192.0.2.1"></label><button class="primary-button" type="submit" :disabled="routeLoading">{{ routeLoading ? '查询中…' : '查询路由' }}</button></form>
      <p v-if="routeError" role="alert">{{ routeError }}</p><p v-if="routes">{{ routes.table }} · {{ routes.routes.length }} 条{{ routes.truncated ? '（已截断，最多 200 条，请用目标 IP 缩小范围）' : '' }}</p><details v-for="(route, index) in routes?.routes ?? []" :key="index" class="protocol-runtime-route"><summary><strong>{{ route.prefix }}</strong> {{ route.summary }}</summary><pre>{{ route.details }}</pre></details><p v-if="routes && !routes.routes.length">暂无匹配路由，请检查协议状态、接口、地址族及同步方向策略。</p>
    </div>
  </dialog>
</template>
<style scoped>
.system-runtime-dialog { width: min(980px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; overflow: clip; }
.system-runtime-dialog[open] { display: flex; flex-direction: column; }
.system-runtime-content { min-height: 0; overflow: auto; padding: 20px 24px; overscroll-behavior: contain; }
.system-runtime-content p { font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.system-runtime-content h3, .system-runtime-content h4 { font-size: 14px; }
.system-route-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 18px 0; }
.system-route-controls label { flex: 1 1 120px; min-width: 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; max-height: 360px; overflow: auto; font-size: 11px; }
@media (max-width: 600px) { .system-runtime-dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); } .system-runtime-content { padding: 12px; } .system-route-controls { display: grid; grid-template-columns: minmax(0, 1fr); } }
</style>
