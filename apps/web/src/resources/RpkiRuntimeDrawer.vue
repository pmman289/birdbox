<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { RpkiRoaResponse, RpkiRuntimeResponse } from "@birdbox/contracts/api";
import type { AddressFamily } from "@birdbox/contracts/inventory";
import { api } from "../shared/api-client";
import { useDashboardStore } from "../dashboard/dashboard-store";
const { dashboard } = useDashboardStore();
const dialog = ref<HTMLDialogElement>(), id = ref("");
const nodeId = ref(""), family = ref<AddressFamily>("ipv4"), search = ref("");
const runtime = ref<RpkiRuntimeResponse | null>(null), roas = ref<RpkiRoaResponse | null>(null);
const loading = ref(false), roaLoading = ref(false), runtimeError = ref(""), roaError = ref("");
const resource = computed(() => dashboard.value?.inventory.rpki.find(item => item.id === id.value));
const nodes = computed(() => dashboard.value?.inventory.nodes.filter(node => resource.value && (resource.value.nodeIds === null || resource.value.nodeIds.includes(node.id))) ?? []);
const filtered = computed(() => roas.value?.entries.filter(entry => `${entry.prefix} ${entry.asn} AS${entry.asn}`.toLowerCase().includes(search.value.trim().toLowerCase())) ?? []);
const labels: Record<string, string> = { up: "运行中", down: "未运行", start: "连接中", disabled: "配置已停用", not_configured: "协议未加载", error: "节点检查失败", unknown: "未知" };
let generation = 0, roaGeneration = 0;
let runtimeController: AbortController | null = null, roaController: AbortController | null = null;
function clearRoas() { roaGeneration++; roaController?.abort(); roaController = null; roas.value = null; roaError.value = ""; roaLoading.value = false; }
watch([nodeId, family], clearRoas, { flush: "sync" });
watch([nodeId, family], () => { if (dialog.value?.open) void loadRoas(); });
function close() { generation++; runtimeController?.abort(); loading.value = false; clearRoas(); dialog.value?.close(); }
async function loadRuntime() {
  const request = ++generation; runtimeController?.abort(); runtimeController = new AbortController(); const signal = runtimeController.signal;
  runtime.value = null; runtimeError.value = ""; loading.value = true;
  try { const result = await api<RpkiRuntimeResponse>(`/api/rpki/${encodeURIComponent(id.value)}/runtime`, { signal, timeoutMs: 35_000 }); if (request === generation && !signal.aborted) runtime.value = result; }
  catch (error) { if (request === generation && !signal.aborted) runtimeError.value = (error as Error).message; }
  finally { if (request === generation) loading.value = false; }
}
async function loadRoas() {
  clearRoas(); if (!nodeId.value) return;
  const request = roaGeneration; roaController = new AbortController(); const signal = roaController.signal; roaLoading.value = true;
  const params = new URLSearchParams({ nodeId: nodeId.value, family: family.value });
  try { const result = await api<RpkiRoaResponse>(`/api/rpki/${encodeURIComponent(id.value)}/roas?${params}`, { signal, timeoutMs: 35_000 }); if (request === roaGeneration && !signal.aborted) roas.value = result; }
  catch (error) { if (request === roaGeneration && !signal.aborted) roaError.value = (error as Error).message; }
  finally { if (request === roaGeneration) roaLoading.value = false; }
}
function open(event: CustomEvent<{ id: string }>) {
  close(); id.value = event.detail.id; runtime.value = null; search.value = "";
  nodeId.value = nodes.value[0]?.id ?? ""; family.value = resource.value?.roa4Table ? "ipv4" : "ipv6";
  dialog.value?.showModal(); void loadRuntime(); void loadRoas();
}
function edit() { const detail = { kind: "rpki" as const, id: id.value }; close(); window.dispatchEvent(new CustomEvent("birdbox:resource-edit", { detail })); }
onMounted(() => window.addEventListener("birdbox:rpki-runtime-open", open));
onBeforeUnmount(() => { close(); window.removeEventListener("birdbox:rpki-runtime-open", open); });
</script>
<template>
  <dialog id="rpkiRuntimeDialog" ref="dialog" class="editor-dialog protocol-editor protocol-runtime rpki-runtime-dialog" aria-labelledby="rpkiRuntimeTitle" @cancel.prevent="close">
    <header class="dialog-head protocol-dialog-head"><div><p class="eyebrow">RPKI 运行态</p><h2 id="rpkiRuntimeTitle">{{ resource?.label }}</h2><p class="protocol-description">{{ resource?.sourceType === 'file' ? '本地 ROA 文件通过 Static 协议加载，状态与 RTR 连接无关。' : '读取实际 RTR 连接及 ROA Channel 状态，ROA 数量不代表连接已建立。' }}</p></div><button type="button" class="secondary-button compact-command protocol-close" @click="close">关闭</button></header>
    <div class="protocol-runtime-toolbar"><button class="secondary-button compact-command" type="button" :disabled="loading" @click="loadRuntime">{{ loading ? '检查中…' : '刷新协议状态' }}</button><button class="secondary-button compact-command" type="button" @click="edit">编辑配置</button></div>
    <div class="rpki-runtime-content"><p v-if="runtimeError" role="alert">{{ runtimeError }}</p>
      <section v-for="node in runtime?.nodes ?? []" :key="node.nodeId" class="protocol-runtime-card"><h3>{{ nodes.find(n => n.id === node.nodeId)?.name ?? node.nodeId }}</h3><p>检查时间：{{ new Date(node.lastCheckedAt).toLocaleString() }}</p><article v-for="instance in node.protocols" :key="instance.name"><h4>{{ instance.name }} · {{ labels[instance.state] }}</h4><p v-if="instance.error" class="protocol-error" role="alert">{{ instance.error }}</p><p v-if="instance.rtrState">RTR 状态：{{ instance.rtrState }}</p><p v-for="channel in instance.channels" :key="channel.family">{{ channel.family === 'ipv4' ? 'IPv4' : 'IPv6' }} · {{ channel.table }} · {{ channel.state ?? '未知' }} · 导入 {{ channel.imported ?? '未知' }} 条 ROA</p><details><summary>原始协议详情</summary><pre>{{ instance.raw || '无可用详情' }}</pre></details></article></section>
      <h3>ROA Table 明细</h3><p class="protocol-help">最多读取 200 条，显示前缀、允许的最大长度与授权 ASN；这是验证数据，不是转发路由。搜索只筛选本次读取结果。</p>
      <form class="rpki-roa-controls" @submit.prevent="loadRoas"><label class="protocol-form-field">节点<select v-model="nodeId" aria-label="ROA 查询节点"><option v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label><label class="protocol-form-field">地址族<select v-model="family" aria-label="ROA 查询地址族"><option v-if="resource?.roa4Table" value="ipv4">IPv4</option><option v-if="resource?.roa6Table" value="ipv6">IPv6</option></select></label><button class="primary-button" type="submit" :disabled="roaLoading">{{ roaLoading ? '查询中…' : '查询 ROA' }}</button></form>
      <p v-if="roaError" class="protocol-error" role="alert">{{ roaError }}</p><template v-if="roas"><label class="protocol-form-field">搜索已读取的前缀 / ASN<input v-model="search" type="search" aria-label="搜索 ROA 前缀或 ASN"></label><p>{{ roas.table }} · {{ filtered.length }} / {{ roas.entries.length }} 条{{ roas.truncated ? '（已截断，最多 200 条）' : '' }}</p><div class="rpki-roa-table"><table><thead><tr><th>前缀</th><th>Max Length</th><th>ASN</th><th>来源协议</th></tr></thead><tbody><tr v-for="(entry, index) in filtered" :key="index"><td>{{ entry.prefix }}</td><td>{{ entry.maxLength }}</td><td>AS{{ entry.asn }}</td><td>{{ entry.protocol ?? '未知' }}</td></tr></tbody></table></div><p v-if="!filtered.length">暂无匹配 ROA，请检查来源状态、节点和地址族。</p></template>
    </div>
  </dialog>
</template>
<style scoped>
.rpki-runtime-dialog { width: min(980px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; overflow: clip; }
.rpki-runtime-dialog[open] { display: flex; flex-direction: column; }
.rpki-runtime-content { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 20px 24px; }
.rpki-runtime-content p { font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
h3, h4 { font-size: 14px; }
.rpki-roa-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 18px 0; padding: 0; }
.rpki-roa-controls label { flex: 1 1 120px; min-width: 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; max-height: 360px; overflow: auto; font-size: 11px; }
.rpki-roa-table { overflow: auto; margin-top: 14px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; white-space: nowrap; } td, th { padding: 10px; text-align: left; border-bottom: 1px solid var(--line); }
@media (max-width: 600px) { .rpki-runtime-dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); } .rpki-runtime-content { padding: 12px; } .rpki-roa-controls { display: grid; grid-template-columns: minmax(0, 1fr); } }
</style>
