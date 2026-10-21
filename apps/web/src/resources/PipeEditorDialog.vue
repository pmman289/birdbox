<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { AddressFamily, ChannelPolicy, PipeProtocol } from "@birdbox/contracts/inventory";
import type { PipePreviewResponse } from "@birdbox/contracts/api";
import { resourceScopeContains } from "@birdbox/contracts/resource-scope";
import { loadDashboard, useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
import { dispatchToast, type ResourceEditKind } from "../shared/events";
import PolicyEditor from "../sessions/PolicyEditor.vue";
const { dashboard } = useDashboardStore();
const dialog = ref<HTMLDialogElement>();
const pending = ref(false), previewPending = ref(false), error = ref("");
const preview = ref<PipePreviewResponse | null>(null);
const editingId = ref<string | null>(null), scopeAll = ref(false);
const nodes = computed(() => dashboard.value?.inventory.nodes ?? []);
const policy = (action: "all" | "none"): ChannelPolicy => ({ mode: "form", steps: [], filterId: null, formAction: action });
const draft = reactive<Omit<PipeProtocol, "id">>({ label: "", name: "birdbox_pipe", nodeIds: [], family: "ipv4", table: { name: "master4", source: "existing" }, peerTable: { name: "", source: "managed" }, importPolicy: policy("none"), exportPolicy: policy("all"), enabled: true });
const targetIds = computed(() => scopeAll.value ? nodes.value.map(n => n.id) : draft.nodeIds ?? []);
const functions = computed(() => dashboard.value?.inventory.functions.filter(f => f.enabled && resourceScopeContains(f, { nodeIds: scopeAll.value ? null : draft.nodeIds })) ?? []);
const filters = computed(() => dashboard.value?.inventory.filters.filter(f => f.enabled && resourceScopeContains(f, { nodeIds: scopeAll.value ? null : draft.nodeIds })) ?? []);
const nodeSearch = ref("");
const visibleNodes = computed(() => nodes.value.filter(n => `${n.name} ${n.id} ${n.routerId}`.toLocaleLowerCase().includes(nodeSearch.value.toLocaleLowerCase())));
const catalog = ref<Array<{ nodeId: string; name: string; family: AddressFamily }>>([]);
const suggestions = computed(() => [...new Set(catalog.value.filter(t => t.family === draft.family && targetIds.value.every(id => catalog.value.some(other => other.nodeId === id && other.name === t.name && other.family === t.family))).map(t => t.name))]);
const body = (): Omit<PipeProtocol, "id"> => ({ ...(JSON.parse(JSON.stringify(draft)) as Omit<PipeProtocol, "id">), nodeIds: scopeAll.value ? null : [...draft.nodeIds ?? []] });
const signature = computed(() => JSON.stringify([draft, scopeAll.value]));
let catalogGeneration = 0;
let savedSignature = "", generation = 0, controller: AbortController | null = null;
function invalidate() { generation++; controller?.abort(); controller = null; previewPending.value = false; preview.value = null; }
watch(scopeAll, value => { if (!value && draft.nodeIds === null) draft.nodeIds = []; });
watch(signature, invalidate, { flush: "sync" });
function close() {
  if (pending.value) return;
  if (signature.value !== savedSignature && !window.confirm("放弃尚未保存的 Pipe 修改？")) return;
  catalogGeneration++; invalidate(); dialog.value?.close();
}
async function open(resource?: PipeProtocol) {
  if (pending.value) return;
  invalidate(); editingId.value = resource?.id ?? null;
  Object.assign(draft, resource ? (({ id: _id, ...rest }) => rest)(structuredClone(resource)) : { label: "", name: "birdbox_pipe", nodeIds: [dashboard.value?.node?.id ?? nodes.value[0]?.id].filter(Boolean), family: "ipv4", table: { name: "master4", source: "existing" }, peerTable: { name: "", source: "managed" }, importPolicy: policy("none"), exportPolicy: policy("all"), enabled: true });
  scopeAll.value = resource?.nodeIds === null;
  savedSignature = signature.value; error.value = ""; catalog.value = []; nodeSearch.value = "";
  dialog.value?.querySelectorAll("details[open]").forEach(element => element.removeAttribute("open"));
  dialog.value?.showModal();
  await nextTick(); dialog.value?.querySelector(".pipe-content")?.scrollTo({ top: 0 });
  const request = ++catalogGeneration;
  try { const result = await api<{ tables: typeof catalog.value }>("/api/pipes/tables"); if (request === catalogGeneration && dialog.value?.open) catalog.value = result.tables; }
  catch { /* Manual entry remains available offline. */ }
}
function changeFamily() { if (["master4", "master6"].includes(draft.table.name)) draft.table.name = draft.family === "ipv4" ? "master4" : "master6"; }
function validate() {
  if (!draft.label.trim() || !draft.name.trim() || !draft.peerTable.name.trim() || !draft.table.name.trim()) throw new Error("请填写显示名称、协议名称和两侧路由表");
  if (!targetIds.value.length) throw new Error("请至少选择一个下发节点");
}
async function inspect() {
  invalidate(); const request = generation; controller = new AbortController(); const signal = controller.signal;
  error.value = "";
  try {
    validate(); previewPending.value = true;
    const result = await api<PipePreviewResponse>("/api/pipes/preview", { method: "POST", body: JSON.stringify({ ...body(), ...(editingId.value ? { id: editingId.value } : {}) }), signal, timeoutMs: 120_000, mutationWait: false });
    if (request === generation && !signal.aborted) {
      preview.value = result; await nextTick();
      const content = dialog.value?.querySelector<HTMLElement>(".pipe-content"), panel = dialog.value?.querySelector<HTMLElement>("#pipePreview");
      if (content && panel) content.scrollTop += panel.getBoundingClientRect().top - content.getBoundingClientRect().top;
    }
  } catch (e) { if (request === generation && !signal.aborted) error.value = e instanceof Error ? e.message : "预检失败"; }
  finally { if (request === generation) previewPending.value = false; }
}
async function mutate(remove = false) {
  if (pending.value) return;
  try { if (!remove) validate(); } catch (e) { error.value = (e as Error).message; return; }
  if (remove && !window.confirm(`删除此 Pipe 并应用到 ${targetIds.value.length} 个节点？最后一个管理引用删除后，相关表声明也会移除。`)) return;
  invalidate(); pending.value = true; error.value = "";
  try {
    await api(editingId.value ? `/api/pipes/${encodeURIComponent(editingId.value)}` : "/api/pipes", { method: remove ? "DELETE" : editingId.value ? "PUT" : "POST", ...(remove ? {} : { body: JSON.stringify(body()) }) });
    savedSignature = signature.value; dialog.value?.close();
    dispatchToast(remove ? "Pipe 已删除并应用" : "Pipe 已保存并应用", "success");
    try { await loadDashboard(dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null); }
    catch { dispatchToast("操作已成功，请刷新资源列表", "error"); }
  } catch (e) { error.value = e instanceof Error ? e.message : "操作失败，编辑内容已保留"; }
  finally { pending.value = false; }
}
function create(e: CustomEvent<{ kind: ResourceEditKind }>) { if (e.detail.kind === "pipes") void open(); }
function edit(e: CustomEvent<{ kind: ResourceEditKind; id: string }>) { if (e.detail.kind === "pipes") { const resource = dashboard.value?.inventory.pipeProtocols?.find(p => p.id === e.detail.id); if (resource) void open(resource); } }
onMounted(() => { window.addEventListener("birdbox:resource-create", create); window.addEventListener("birdbox:resource-edit", edit); });
onBeforeUnmount(() => { catalogGeneration++; invalidate(); window.removeEventListener("birdbox:resource-create", create); window.removeEventListener("birdbox:resource-edit", edit); });
const summary = (p: ChannelPolicy) => p.mode === "custom" ? "自定义 Filter" : p.mode === "combined" ? "Function 组合策略" : p.formAction === "all" ? "允许全部" : "禁止全部";
</script>
<template>
  <dialog id="pipeDialog" ref="dialog" class="editor-dialog pipe-dialog protocol-editor" aria-labelledby="pipeTitle" @cancel.prevent="close">
    <header class="dialog-head protocol-dialog-head"><span class="dialog-icon">⇄</span><div><p class="eyebrow">BIRD Pipe</p><h2 id="pipeTitle">{{ editingId ? '编辑 Pipe' : '添加 Pipe' }}</h2><p class="protocol-description">选择下发节点和两侧路由表，分别设置传递方向。</p></div><button type="button" class="secondary-button compact-command protocol-close" :disabled="pending" aria-label="关闭 Pipe 编辑器" @click="close">关闭</button></header>
    <form @submit.prevent="mutate()">
      <div class="pipe-content">
        <fieldset :disabled="pending" class="pipe-fields">
          <section class="protocol-section" aria-labelledby="pipeBasicsTitle">
            <div class="protocol-section-title"><span>1</span><div><h3 id="pipeBasicsTitle">基本信息</h3><p>每条 Pipe 对应一个地址族。</p></div></div>
            <div class="dialog-grid"><label class="protocol-form-field">显示名称<input id="pipeLabel" v-model="draft.label" required></label><label class="protocol-form-field">协议名称<input id="pipeName" v-model="draft.name" required pattern="[A-Za-z_][A-Za-z0-9_]*"></label><label class="protocol-form-field">地址族<select id="pipeFamily" v-model="draft.family" @change="changeFamily"><option value="ipv4">IPv4</option><option value="ipv6">IPv6</option></select></label></div>
            <label class="toggle-row" for="pipeEnabled"><span><strong>启用协议</strong><small>{{ draft.enabled ? '应用后在两侧表间传递路由' : '保留配置与管理表，停用协议' }}</small></span><input id="pipeEnabled" v-model="draft.enabled" type="checkbox"><i aria-hidden="true"></i></label>
          </section>
          <section class="protocol-section" aria-labelledby="pipeNodesTitle">
            <div class="protocol-section-title"><span>2</span><div><h3 id="pipeNodesTitle">下发节点</h3><p>两侧路由表与策略需要在所选节点上可用。</p></div><span class="protocol-count">已选 {{ targetIds.length }} 个</span></div>
            <label class="protocol-form-field protocol-source-field">节点范围<select id="pipeScope" v-model="scopeAll"><option :value="false">指定节点</option><option :value="true">所有节点（含后续新增）</option></select></label>
            <div v-if="!scopeAll" class="policy-scope-selector"><div class="policy-scope-toolbar"><input v-model="nodeSearch" type="search" placeholder="搜索节点" aria-label="搜索 Pipe 下发节点"><span><button class="secondary-button compact-command" type="button" @click="draft.nodeIds = nodes.map(n => n.id)">全选</button><button class="secondary-button compact-command" type="button" @click="draft.nodeIds = []">清空</button></span></div>
              <div class="pipe-node-list"><label v-for="node in visibleNodes" :key="node.id" class="protocol-checkbox pipe-node-option"><input v-model="draft.nodeIds" type="checkbox" :value="node.id"><span><strong>{{ node.name }}</strong><small>{{ node.routerId || node.id }}</small></span></label><p v-if="!visibleNodes.length" class="protocol-help">没有匹配的节点</p></div>
            </div>
          </section>
          <section class="protocol-section" aria-labelledby="pipeTablesTitle">
            <div class="protocol-section-title"><span>3</span><div><h3 id="pipeTablesTitle">路由表与传递方向</h3><p>默认允许主表到对端表，反向默认禁止。</p></div></div>
            <div class="pipe-tables"><section v-for="(side, i) in [draft.table, draft.peerTable]" :key="i"><h4>{{ i === 0 ? '主表' : '对端表' }}</h4><label class="protocol-form-field">表来源<select v-model="side.source" :aria-label="`${i === 0 ? '主表' : '对端表'}来源`"><option value="existing">引用已有表</option><option value="managed">由 Birdbox 创建</option></select></label><label class="protocol-form-field">表名<input v-model="side.name" :id="i === 0 ? 'pipeTable' : 'pipePeerTable'" :list="side.source === 'existing' ? 'pipeKnownTables' : undefined" required placeholder="选择或手动输入表名"></label><p class="protocol-help">{{ side.source === 'managed' ? '由 Birdbox 创建并维护；停用协议时保留表。' : '支持手动输入，由节点预检确认表是否可用。' }}</p></section></div>
            <datalist id="pipeKnownTables"><option v-for="name in suggestions" :key="name" :value="name" /></datalist>
            <details class="pipe-policy protocol-disclosure"><summary><span>主表 → 对端表（Export）</span><span class="protocol-policy-summary">{{ summary(draft.exportPolicy) }}</span></summary><p class="protocol-help">{{ draft.table.name || '主表' }} → {{ draft.peerTable.name || '对端表' }}</p><PolicyEditor :family="draft.family" direction="export" :policy="draft.exportPolicy" :export-define-id="null" :functions="functions" :filters="filters" :defines="[]" :disabled="pending" :show-policy-action="false" :allow-export-cidr="false" @update:policy="draft.exportPolicy = $event" /></details>
            <details class="pipe-policy protocol-disclosure"><summary><span>对端表 → 主表（Import）</span><span class="protocol-policy-summary">{{ summary(draft.importPolicy) }}</span></summary><p class="protocol-help">{{ draft.peerTable.name || '对端表' }} → {{ draft.table.name || '主表' }}</p><PolicyEditor :family="draft.family" direction="import" :policy="draft.importPolicy" :export-define-id="null" :functions="functions" :filters="filters" :defines="[]" :disabled="pending" :show-policy-action="false" :allow-export-cidr="false" @update:policy="draft.importPolicy = $event" /></details>
          </section>
        </fieldset>
        <p v-if="error" role="alert" class="protocol-notice protocol-error">{{ error }}</p>
        <section v-if="preview" id="pipePreview" class="protocol-preview"><h3>{{ preview.valid ? '预检通过' : '预检未通过' }}</h3><details v-for="item in preview.configs" :key="item.nodeId"><summary>{{ nodes.find(n => n.id === item.nodeId)?.name ?? item.nodeId }} · {{ item.validation.ok ? '通过' : '失败' }}</summary><pre>{{ item.validation.stdout }}{{ item.validation.stderr }}</pre><pre>{{ item.config }}</pre></details></section>
      </div>
      <footer class="pipe-actions protocol-editor-actions"><button v-if="editingId" type="button" class="text-danger-button" :disabled="pending" @click="mutate(true)">删除 Pipe</button><span class="protocol-save-hint">{{ pending ? '正在下发配置，请稍候' : `将应用到 ${targetIds.length} 个节点` }}</span><button type="button" class="secondary-button" :disabled="pending" @click="close">取消</button><button type="button" class="secondary-button" :disabled="pending || previewPending" @click="inspect">{{ previewPending ? '预检中…' : '预检配置' }}</button><button class="primary-button" type="submit" :disabled="pending || previewPending">{{ pending ? '正在应用…' : '保存并应用' }}</button></footer>
    </form>
  </dialog>
</template>
<style scoped>
.pipe-dialog { width: min(940px, calc(100vw - 32px)); max-width: calc(100vw - 24px); max-height: 92dvh; overflow: clip; padding: 0; box-sizing: border-box; }
.pipe-dialog[open] { display: flex; flex-direction: column; }
.pipe-dialog form { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: clip; padding: 0; }
.pipe-content { flex: 1; overflow: auto; min-height: 0; padding: 20px 24px; overscroll-behavior: contain; background: var(--surface-soft); }
.pipe-fields { border: 0; margin: 0; padding: 0; min-width: 0; display: grid; gap: 16px; }
.pipe-node-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; max-height: 220px; overflow: auto; }
.pipe-node-option { min-height: 52px; padding: 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); }
.pipe-node-option:has(input:checked) { border-color: var(--green); background: var(--green-soft); }
.pipe-node-option span { display: grid; gap: 4px; min-width: 0; }
.pipe-node-option strong { font-size: 12px; overflow-wrap: anywhere; }
.pipe-node-option small { color: var(--muted); font: 10px ui-monospace, monospace; overflow-wrap: anywhere; }
.pipe-tables { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 16px; }
.pipe-tables section { padding: 16px; min-width: 0; background: var(--surface-soft); border: 1px solid var(--line); border-radius: 6px; display: grid; gap: 12px; }
.pipe-tables h4 { margin: 0; font-size: 13px; }
.pipe-tables p { margin: 0; }
.pipe-policy { margin-top: 12px; }
.pipe-actions { flex-shrink: 0; margin: 0; }
.pipe-dialog .toggle-row { margin-top: 16px; }
pre { max-width: 100%; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 600px) {
  .pipe-content { padding: 12px; }
  .pipe-tables, .pipe-dialog .dialog-grid, .pipe-node-list { grid-template-columns: minmax(0, 1fr); }
  .pipe-tables { gap: 10px; }
}
</style>
