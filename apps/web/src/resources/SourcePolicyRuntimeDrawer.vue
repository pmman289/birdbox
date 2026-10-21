<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SourcePolicyRuntimeResponse, StaticRoutesResponse } from "@birdbox/contracts/api";
import { useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
const { dashboard } = useDashboardStore();
const dialog = ref<HTMLDialogElement>(), id = ref("");
const nodeId = ref(""), groupId = ref(""), target = ref(""), view = ref<"kernel" | "bird">("kernel");
const runtime = ref<SourcePolicyRuntimeResponse | null>(null), routes = ref<StaticRoutesResponse | null>(null);
const loading = ref(false), routeLoading = ref(false), error = ref(""), routeError = ref("");
const resource = computed(() => dashboard.value?.inventory.sourcePolicies.find(item => item.id === id.value));
const nodes = computed(() => dashboard.value?.inventory.nodes.filter(node => resource.value && (resource.value.nodeIds === null || resource.value.nodeIds.includes(node.id))) ?? []);
const currentNode = computed(() => runtime.value?.nodes.find(node => node.nodeId === nodeId.value));
const group = computed(() => currentNode.value?.groups.find(item => item.groupId === groupId.value));
const ruleAlert = computed(() => currentNode.value && (currentNode.value.rules.error || currentNode.value.rules.missing.length || currentNode.value.rules.unexpected.length || ['pending', 'missing', 'error'].includes(currentNode.value.rules.persistence)));
const labels: Record<string, string> = { up: "运行中", down: "未运行", start: "启动中", disabled: "配置已停用", not_configured: "协议未加载", error: "检查失败", unknown: "未知" };
const persistenceLabels = { ready: "已保存，可在 Agent 启动时恢复", pending: "存在待恢复操作", missing: "尚无恢复快照，请应用配置或升级 Agent", manual: "此节点需手工维护持久化", error: "恢复快照异常", unknown: "未知" };
let generation = 0, routeGeneration = 0;
let controller: AbortController | null = null, routeController: AbortController | null = null;
function clearRoutes() { routeGeneration++; routeController?.abort(); routeController = null; routes.value = null; routeError.value = ""; routeLoading.value = false; }
watch([nodeId, groupId, target, view], clearRoutes, { flush: "sync" });
watch([nodeId, groupId, view], () => { if (dialog.value?.open && view.value === 'bird') void loadRoutes(); });
function close() { generation++; controller?.abort(); loading.value = false; clearRoutes(); dialog.value?.close(); }
async function loadRuntime() {
  const request = ++generation; controller?.abort(); controller = new AbortController(); const signal = controller.signal;
  loading.value = true; error.value = "";
  try { const result = await api<SourcePolicyRuntimeResponse>(`/api/source-policies/${encodeURIComponent(id.value)}/runtime`, { signal, timeoutMs: 40_000 }); if (request === generation && !signal.aborted) runtime.value = result; }
  catch (e) { if (request === generation && !signal.aborted) error.value = (e as Error).message; }
  finally { if (request === generation) loading.value = false; }
}
async function loadRoutes() {
  clearRoutes(); if (!nodeId.value || !groupId.value) return;
  const request = routeGeneration; routeController = new AbortController(); const signal = routeController.signal; routeLoading.value = true;
  const params = new URLSearchParams({ nodeId: nodeId.value, groupId: groupId.value, ...(target.value.trim() ? { target: target.value.trim() } : {}) });
  try { const result = await api<StaticRoutesResponse>(`/api/source-policies/${encodeURIComponent(id.value)}/routes?${params}`, { signal, timeoutMs: 35_000 }); if (request === routeGeneration && !signal.aborted) routes.value = result; }
  catch (e) { if (request === routeGeneration && !signal.aborted) routeError.value = (e as Error).message; }
  finally { if (request === routeGeneration) routeLoading.value = false; }
}
function open(e: CustomEvent<{ id: string }>) {
  close(); id.value = e.detail.id; runtime.value = null; target.value = ""; view.value = "kernel";
  nodeId.value = nodes.value[0]?.id ?? ""; groupId.value = resource.value?.groups[0]?.id ?? "";
  dialog.value?.showModal(); void loadRuntime();
}
function edit() { const detail = { kind: 'sourcePolicies' as const, id: id.value }; close(); window.dispatchEvent(new CustomEvent('birdbox:resource-edit', { detail })); }
onMounted(() => window.addEventListener('birdbox:source-policy-runtime-open', open));
onBeforeUnmount(() => { close(); window.removeEventListener('birdbox:source-policy-runtime-open', open); });
</script>
<template>
  <dialog id="sourcePolicyRuntimeDialog" ref="dialog" class="editor-dialog protocol-editor protocol-runtime source-runtime-dialog" aria-labelledby="sourceRuntimeTitle" @cancel.prevent="close">
    <header class="dialog-head protocol-dialog-head"><div><p class="eyebrow">源地址出口 · 运行态</p><h2 id="sourceRuntimeTitle">{{ resource?.label }}</h2><p class="protocol-description">检查已保存配置的实际协议、系统规则及路由，未保存草稿不参与检查。</p></div><button type="button" class="secondary-button compact-command" @click="close">关闭</button></header>
    <div class="source-runtime-toolbar"><label class="protocol-form-field">节点<select v-model="nodeId" aria-label="源地址出口运行态节点"><option v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label><label class="protocol-form-field">出口组<select v-model="groupId" aria-label="源地址出口运行态出口组"><option v-for="item in resource?.groups ?? []" :key="item.id" :value="item.id">{{ item.egressAddress }} · Linux {{ item.kernelTable }}</option></select></label><button class="secondary-button" type="button" :disabled="loading" @click="loadRuntime">{{ loading ? '检查中…' : '刷新运行态' }}</button><button class="secondary-button" type="button" @click="edit">编辑配置</button></div>
    <div class="source-runtime-content">
      <p v-if="error" role="alert" class="protocol-notice protocol-error">{{ error }}{{ runtime ? '，下方保留上次结果，请核对检查时间。' : '' }}</p><p v-if="loading" role="status">正在检查节点，配置草稿保持不变…</p>
      <section v-if="currentNode" class="protocol-runtime-card source-rule-summary" :class="{ 'source-runtime-warning': ruleAlert }"><h3>系统规则 · {{ currentNode.rules.installed ?? '未知' }} / {{ currentNode.rules.expected }} 条符合配置</h3><p>检查时间：{{ new Date(currentNode.lastCheckedAt).toLocaleString() }}</p><p>重启恢复：{{ persistenceLabels[currentNode.rules.persistence] }}</p><p v-if="currentNode.rules.error" role="alert">{{ currentNode.rules.error }}</p><details :open="!!ruleAlert"><summary>规则检查详情 · 缺失 {{ currentNode.rules.missing.length }} / 异常残留 {{ currentNode.rules.unexpected.length }}</summary><p v-for="(rule, index) in currentNode.rules.missing" :key="`missing${index}`" role="alert">缺失：{{ rule.source ? `源 ${rule.source}` : `目的 ${rule.destination}` }} → 表 {{ rule.table }} · 优先级 {{ rule.priority }}</p><p v-for="(rule, index) in currentNode.rules.unexpected" :key="`extra${index}`" role="alert">异常残留：{{ rule.source || rule.destination }} → 表 {{ rule.table }} · 优先级 {{ rule.priority }}</p><pre>{{ currentNode.rules.raw || '未获得系统规则详情' }}</pre></details></section>
      <section v-if="group" class="protocol-runtime-card source-group-runtime"><h3>出口 {{ group.egressAddress }}</h3><p><code>{{ group.table }}</code> → Linux 表 {{ group.kernelTable }}</p><p v-if="group.skipped" class="protocol-notice">本机就是此出口，不生成对应策略表与系统规则，继续使用正常底层路由。</p><div class="source-runtime-protocols"><details v-for="protocol in group.protocols" :key="protocol.name" :open="!!protocol.error"><summary>{{ protocol.kind }} · {{ labels[protocol.state] }}</summary><p v-if="protocol.error" role="alert">{{ protocol.error }}</p><pre>{{ protocol.raw || '无可用协议详情' }}</pre></details></div></section>
      <div class="source-runtime-views" role="group" aria-label="源地址出口路由视图"><button class="secondary-button" type="button" :aria-pressed="view === 'kernel'" @click="view = 'kernel'">Linux 已安装路由</button><button class="secondary-button" type="button" :aria-pressed="view === 'bird'" @click="view = 'bird'">BIRD 策略表路由</button></div>
      <section v-if="view === 'kernel'" aria-label="源地址出口内核路由"><p class="protocol-help">直接读取 Linux 策略表。默认路由缺失时，请检查出口在 master4 中能否递归到达；协议运行中不代表默认路由已安装。</p><p v-if="group?.routeError" role="alert">{{ group.routeError }}</p><p v-if="group">{{ group.kernelRoutes.length }} 条{{ group.routesTruncated ? '（最多展示 200 条，已截断）' : '' }}</p><details v-for="(route, index) in group?.kernelRoutes ?? []" :key="index" class="protocol-runtime-route"><summary><strong>{{ route.prefix }}</strong> · {{ route.gateway ? `经 ${route.gateway}` : route.type }} {{ route.interface ?? '' }}</summary><pre>{{ route.raw }}</pre></details><p v-if="group && !group.routeError && !group.kernelRoutes.length">此内核表暂无路由{{ resource?.enabled ? '，请结合协议状态与出口可达性排查' : '，配置已停用' }}。</p></section>
      <section v-else aria-label="源地址出口 BIRD 路由"><p class="protocol-help">显示 BIRD 策略表中的默认路由和复制的内部路由；请结合 Linux 安装结果判断转发是否生效。</p><form class="source-bird-query" @submit.prevent="loadRoutes"><label class="protocol-form-field">目标 IPv4（可选）<input v-model="target" aria-label="源地址出口目标 IP" placeholder="例如 198.51.100.1"></label><button class="primary-button" :disabled="routeLoading" type="submit">{{ routeLoading ? '查询中…' : '查询路由' }}</button></form><p v-if="routeError" role="alert">{{ routeError }}</p><p v-if="routes">{{ routes.routes.length }} 条{{ routes.truncated ? '（最多展示 200 条，已截断；请用目标 IP 缩小范围）' : '' }}</p><details v-for="(route, index) in routes?.routes ?? []" :key="index" class="protocol-runtime-route"><summary><strong>{{ route.prefix }}</strong> {{ route.summary }}</summary><pre>{{ route.details }}</pre></details><p v-if="routes && !routes.routes.length">暂无匹配路由。</p></section>
    </div>
  </dialog>
</template>
<style scoped>
.source-runtime-dialog { width: min(980px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; overflow: clip; }
.source-runtime-dialog[open] { display: flex; flex-direction: column; }
.source-runtime-dialog .dialog-head { flex-shrink: 0; }
.source-runtime-toolbar { display: flex; flex-shrink: 0; flex-wrap: wrap; align-items: end; gap: 10px; padding: 14px 24px; border-bottom: 1px solid var(--line); }
.source-runtime-toolbar label { flex: 1 1 170px; min-width: 0; }
.source-runtime-content { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px 24px; }
.source-runtime-content p { font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.source-runtime-content h3 { font-size: 14px; }
.source-runtime-warning { border-color: var(--red-border); }
.source-runtime-protocols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.source-runtime-protocols details { min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: 5px; }
.source-runtime-views { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0; }
.source-runtime-views [aria-pressed=true] { border-color: var(--green); color: var(--green-dark); background: var(--surface-soft); }
.source-bird-query { display: flex; align-items: end; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
.source-bird-query label { flex: 1 1 180px; min-width: 0; }
.source-runtime-content pre { max-width: 100%; max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; line-height: 1.6; }
@media (max-width: 600px) {
 .source-runtime-dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); }
 .source-runtime-toolbar { padding: 12px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
 .source-runtime-toolbar label { grid-column: 1 / -1; }
 .source-runtime-content { padding: 12px; }
 .source-runtime-protocols { grid-template-columns: minmax(0, 1fr); }
 .source-runtime-toolbar button { min-width: 0; padding: 8px; }
}
</style>
