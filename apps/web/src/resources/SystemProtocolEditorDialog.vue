<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { AddressFamily, ChannelPolicy, DirectProtocol, KernelExportPolicy, KernelProtocol, PipeTableReference } from "@birdbox/contracts/inventory";
import type { SystemProtocolEditorContext, SystemProtocolKind, SystemProtocolPreviewResponse } from "@birdbox/contracts/api";
import { useDashboardStore, loadDashboard } from "../dashboard/dashboard-store";
import { api, ApiError } from "../shared/api-client";
import { dispatchToast } from "../shared/events";
import { uniqueBirdName } from "../shared/resource-names";
import NullableNumberInput from "../shared/NullableNumberInput.vue";
import PolicyEditor from "../sessions/PolicyEditor.vue";
import { resourceScopeContains } from "@birdbox/contracts/resource-scope";

const dialog = ref<HTMLDialogElement>(), form = ref<HTMLFormElement>();
const editingId = ref<string | null>(null), kind = ref<SystemProtocolKind>("directs");
const pending = ref(false), contextLoading = ref(false), previewPending = ref(false), error = ref("");
const preview = ref<SystemProtocolPreviewResponse | null>(null), revision = ref<number | null>(null);
const conflict = ref(false), comparison = ref<SystemProtocolEditorContext | null>(null);
const interfaceLoading = ref(false), interfaceError = ref("");
const interfaceSearch = ref(""), interfaceOptions = ref<string[]>([]), kernelNodeSearch = ref("");
let interfaceRequestId = 0, generation = 0, contextGeneration = 0;
let interfaceController: AbortController | null = null, controller: AbortController | null = null;
const baseline = ref("");
let initialResource: DirectProtocol | KernelProtocol | null = null;
const { dashboard } = useDashboardStore();
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const defaultPolicy = (direction: "import" | "export"): ChannelPolicy => ({ mode: "form", steps: [], filterId: null, formAction: direction === "import" ? "none" : "all" });
const defaultExport = (): KernelExportPolicy => ({ mode: "visual", policy: defaultPolicy("export"), prefSrc: null });
const draft = reactive({ label: "", name: "", nodeId: "", nodeIds: [] as string[], kernelGlobal: false, interfaces: [] as string[], ipv4: true, ipv6: true, importPolicies: { ipv4: defaultPolicy("import"), ipv6: defaultPolicy("import") }, tables: { ipv4: { name: "master4", source: "existing" } as PipeTableReference, ipv6: { name: "master6", source: "existing" } as PipeTableReference }, exportPolicies: { ipv4: defaultExport(), ipv6: defaultExport() }, table: null as number | null, scanTime: 60 as number | null, persist: false, enabled: true, checkLink: false, learn: false, gracefulRestart: false, metric: null as number | null, mergePaths: null as number | null });
const editing = computed(() => editingId.value !== null), title = computed(() => kind.value === "directs" ? "Direct" : "Kernel");
const nodes = computed(() => dashboard.value?.inventory.nodes ?? []);
const targetIds = computed(() => kind.value === "directs" ? [draft.nodeId].filter(Boolean) : draft.kernelGlobal ? nodes.value.map(n => n.id) : draft.nodeIds);
const affectedIds = computed(() => [...new Set([...targetIds.value, ...(initialResource ? "nodeId" in initialResource ? [initialResource.nodeId] : initialResource.nodeIds ?? nodes.value.map(n => n.id) : [])])]);
const functions = computed(() => dashboard.value?.inventory.functions.filter(f => f.enabled && f.callable && resourceScopeContains(f, { nodeIds: draft.kernelGlobal ? null : draft.nodeIds })) ?? []);
const filters = computed(() => dashboard.value?.inventory.filters.filter(f => f.enabled && resourceScopeContains(f, { nodeIds: draft.kernelGlobal ? null : draft.nodeIds })) ?? []);
const enabledKernelFamilies = computed<AddressFamily[]>(() => [...(draft.ipv4 ? ["ipv4" as const] : []), ...(draft.ipv6 ? ["ipv6" as const] : [])]);
const visibleKernelNodes = computed(() => nodes.value.filter(n => `${n.name} ${n.id} ${n.routerId}`.toLocaleLowerCase().includes(kernelNodeSearch.value.trim().toLocaleLowerCase())));
const filteredInterfaces = computed(() => interfaceOptions.value.filter(i => i.toLocaleLowerCase().includes(interfaceSearch.value.trim().toLocaleLowerCase())));
const policySummary = (p: ChannelPolicy) => p.mode === "custom" ? "自定义 Filter" : p.mode === "combined" ? "Function 组合" : p.formAction === "all" ? "允许全部" : "禁止全部";
const tableCatalog = ref<Array<{ nodeId: string; name: string; family: AddressFamily }>>([]);
const tableSuggestions = (family: AddressFamily) => [...new Set(tableCatalog.value.filter(t => t.family === family && targetIds.value.every(id => tableCatalog.value.some(other => other.nodeId === id && other.name === t.name && other.family === family))).map(t => t.name))];
const nameForNode = (id: string) => nodes.value.find(n => n.id === id)?.name ?? id;
function body() {
  return kind.value === "directs" ? { label: draft.label, name: draft.name, nodeId: draft.nodeId, interfaces: [...draft.interfaces], ipv4: draft.ipv4, ipv6: draft.ipv6, enabled: draft.enabled, checkLink: draft.checkLink }
    : { label: draft.label, name: draft.name, nodeIds: draft.kernelGlobal ? null : [...draft.nodeIds], ipv4: draft.ipv4, ipv6: draft.ipv6, importPolicy: clone(draft.importPolicies.ipv4), importPolicies: clone(draft.importPolicies), tables: clone(draft.tables), exportPolicy: clone(draft.exportPolicies.ipv4.policy), exportPolicies: clone(draft.exportPolicies), table: draft.table, scanTime: draft.scanTime, persist: draft.persist, enabled: draft.enabled, learn: draft.learn, gracefulRestart: draft.gracefulRestart, metric: draft.metric, mergePaths: draft.mergePaths };
}
const signature = computed(() => JSON.stringify(body()));
const dirty = computed(() => signature.value !== baseline.value);
function invalidate() { generation++; controller?.abort(); controller = null; previewPending.value = false; preview.value = null; }
watch(signature, invalidate, { flush: "sync" });
function reset(resource: DirectProtocol | KernelProtocol | null) {
  const selectedNodeId = dashboard.value?.node?.id ?? nodes.value[0]?.id ?? "";
  editingId.value = resource?.id ?? null; initialResource = resource ? clone(resource) : null;
  Object.assign(draft, { label: resource?.label ?? "", name: resource?.name ?? (dashboard.value ? uniqueBirdName(dashboard.value.inventory, kind.value === "directs" ? "direct" : "kernel", "routes") : `birdbox_${title.value.toLowerCase()}`), ipv4: resource?.ipv4 ?? true, ipv6: resource?.ipv6 ?? true, enabled: resource?.enabled ?? true });
  if (kind.value === "directs") {
    const item = resource as DirectProtocol | null;
    Object.assign(draft, { nodeId: item?.nodeId ?? selectedNodeId, interfaces: [...item?.interfaces ?? []], checkLink: item?.checkLink ?? false });
  } else {
    const item = resource as KernelProtocol | null;
    Object.assign(draft, { kernelGlobal: item?.nodeIds === null, nodeIds: [...item?.nodeIds ?? [selectedNodeId].filter(Boolean)], importPolicies: { ipv4: clone(item?.importPolicies?.ipv4 ?? item?.importPolicy ?? defaultPolicy("import")), ipv6: clone(item?.importPolicies?.ipv6 ?? item?.importPolicy ?? defaultPolicy("import")) }, tables: { ipv4: clone(item?.tables?.ipv4 ?? { name: "master4", source: "existing" }), ipv6: clone(item?.tables?.ipv6 ?? { name: "master6", source: "existing" }) }, exportPolicies: { ipv4: clone(item?.exportPolicies?.ipv4 ?? { ...defaultExport(), policy: item?.exportPolicy ?? defaultPolicy("export") }), ipv6: clone(item?.exportPolicies?.ipv6 ?? { ...defaultExport(), policy: item?.exportPolicy ?? defaultPolicy("export") }) }, table: item?.table ?? null, scanTime: item?.scanTime ?? 60, persist: item?.persist ?? false, learn: item?.learn ?? false, gracefulRestart: item?.gracefulRestart ?? false, metric: item?.metric ?? null, mergePaths: item?.mergePaths ?? null });
  }
  baseline.value = signature.value;
}
function stopInterfaces() { interfaceRequestId++; interfaceController?.abort(); interfaceController = null; interfaceLoading.value = false; }
function canDiscard() { return !pending.value && (!dialog.value?.open || !dirty.value || window.confirm(`放弃尚未保存的 ${title.value} 修改？`)); }
function close() { if (!canDiscard()) return; contextGeneration++; contextLoading.value = false; invalidate(); stopInterfaces(); dialog.value?.close(); }
async function open(nextKind: SystemProtocolKind, resource: DirectProtocol | KernelProtocol | null) {
  if (!canDiscard()) return;
  invalidate(); stopInterfaces(); kind.value = nextKind; reset(resource);
  error.value = ""; conflict.value = false; comparison.value = null; revision.value = null; tableCatalog.value = []; interfaceError.value = ""; interfaceOptions.value = []; interfaceSearch.value = ""; kernelNodeSearch.value = "";
  dialog.value?.querySelectorAll("details[open]").forEach(el => el.removeAttribute("open"));
  if (!dialog.value?.open) dialog.value?.showModal();
  contextLoading.value = true; const request = ++contextGeneration;
  try {
    const result = await api<SystemProtocolEditorContext>(`/api/${nextKind}/editor-context${resource ? `?id=${encodeURIComponent(resource.id)}` : ""}`);
    if (request !== contextGeneration || !dialog.value?.open) return;
    revision.value = result.inventoryRevision;
    if (resource && !result.resource) { conflict.value = true; comparison.value = result; error.value = "资源已被删除，请比较后决定是否用本地草稿重新创建"; return; }
    reset(result.resource);
    if (nextKind === "kernels") {
      const catalogRequest = contextGeneration;
      void api<{ tables: typeof tableCatalog.value }>("/api/pipes/tables").then(result => { if (catalogRequest === contextGeneration && dialog.value?.open) tableCatalog.value = result.tables; }).catch(() => {});
    }
    if (nextKind === "directs") void loadInterfaces(draft.nodeId);
  } catch (e) { if (request === contextGeneration) error.value = `无法加载编辑版本：${(e as Error).message}`; }
  finally { if (request === contextGeneration) contextLoading.value = false; }
  await nextTick(); dialog.value?.querySelector(".system-protocol-content")?.scrollTo({ top: 0 });
}
async function loadInterfaces(nodeId: string) {
  stopInterfaces(); const request = interfaceRequestId; interfaceController = new AbortController(); const signal = interfaceController.signal;
  interfaceOptions.value = [...draft.interfaces]; interfaceError.value = "";
  if (!nodeId) return;
  interfaceLoading.value = true;
  try { const result = await api<{ interfaces: string[] }>(`/api/nodes/${encodeURIComponent(nodeId)}/interfaces`, { signal }); if (request === interfaceRequestId && draft.nodeId === nodeId) interfaceOptions.value = [...new Set([...result.interfaces, ...draft.interfaces])].sort(); }
  catch (e) { if (request === interfaceRequestId && !signal.aborted) interfaceError.value = `${(e as Error).message}；可手动填写接口或匹配规则。`; }
  finally { if (request === interfaceRequestId) interfaceLoading.value = false; }
}
function selectDirectNode() { draft.interfaces = []; void loadInterfaces(draft.nodeId); }
function toggleInterface(name: string) { draft.interfaces = draft.interfaces.includes(name) ? draft.interfaces.filter(i => i !== name) : [...draft.interfaces, name]; }
function setManualInterfaces(e: Event) { draft.interfaces = [...new Set((e.target as HTMLInputElement).value.split(",").map(i => i.trim()).filter(Boolean))]; }
function toggleNode(id: string) { draft.nodeIds = draft.nodeIds.includes(id) ? draft.nodeIds.filter(i => i !== id) : [...draft.nodeIds, id]; }
function validate() {
  if (!form.value?.reportValidity()) return false;
  if (!targetIds.value.length) { error.value = "请至少选择一个下发节点"; return false; }
  if (!draft.ipv4 && !draft.ipv6) { error.value = "至少启用一个地址族"; return false; }
  return true;
}
function showError(e: unknown) { error.value = (e as Error).message; if (e instanceof ApiError && e.code === "STATE_CONFLICT") { conflict.value = true; comparison.value = null; } }
async function inspect() {
  if (pending.value || contextLoading.value || conflict.value) return;
  invalidate(); error.value = ""; if (!validate()) return;
  const request = generation; controller = new AbortController(); const signal = controller.signal; previewPending.value = true;
  try {
    const result = await api<SystemProtocolPreviewResponse>(`/api/${kind.value}/preview`, { method: "POST", body: JSON.stringify({ ...body(), ...(editingId.value ? { id: editingId.value } : {}), inventoryRevision: revision.value }), signal, timeoutMs: 120_000, mutationWait: false });
    if (request !== generation || signal.aborted) return;
    preview.value = result;
    await nextTick(); const content = dialog.value?.querySelector<HTMLElement>(".system-protocol-content"), panel = dialog.value?.querySelector<HTMLElement>("#systemProtocolPreview");
    if (content && panel) content.scrollTop += panel.getBoundingClientRect().top - content.getBoundingClientRect().top;
  } catch (e) { if (request === generation && !signal.aborted) showError(e); }
  finally { if (request === generation) previewPending.value = false; }
}
async function save() {
  if (!preview.value?.valid) { await inspect(); return; }
  if (!window.confirm(`确认应用 ${title.value} 到 ${preview.value.configs.length} 个受影响节点？`)) return;
  pending.value = true; error.value = "";
  try {
    const p = preview.value;
    await api(editingId.value ? `/api/${kind.value}/${encodeURIComponent(editingId.value)}` : `/api/${kind.value}`, { method: editingId.value ? "PUT" : "POST", body: JSON.stringify({ ...body(), mode: "apply", previewId: p.previewId, candidateHash: p.candidateHash, inventoryRevision: p.inventoryRevision }) });
    baseline.value = signature.value; invalidate(); stopInterfaces();
    try { await loadDashboard(dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null); } catch { dispatchToast("操作已成功，请刷新列表", "error"); }
    dialog.value?.close(); dispatchToast("协议资源已保存并应用", "success");
  } catch (e) { showError(e); preview.value = null; }
  finally { pending.value = false; }
}
async function remove() {
  if (!editingId.value || !window.confirm(`确认删除 ${title.value}「${initialResource?.label}」并清理 ${affectedIds.value.map(nameForNode).join("、")} 上已保存的协议？${dirty.value ? "未保存的编辑也将丢弃。" : ""}`)) return;
  pending.value = true; error.value = "";
  try {
    await api(`/api/${kind.value}/${encodeURIComponent(editingId.value)}`, { method: "DELETE", body: JSON.stringify({ inventoryRevision: revision.value }) });
    baseline.value = signature.value; invalidate(); stopInterfaces();
    try { await loadDashboard(dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null); } catch { dispatchToast("删除已成功，请刷新列表", "error"); }
    dialog.value?.close(); dispatchToast("协议资源已删除", "success");
  } catch (e) { showError(e); } finally { pending.value = false; }
}
async function compareLatest() {
  const request = ++contextGeneration; contextLoading.value = true;
  try { const result = await api<SystemProtocolEditorContext>(`/api/${kind.value}/editor-context${editingId.value ? `?id=${encodeURIComponent(editingId.value)}` : ""}`); if (request === contextGeneration && dialog.value?.open) comparison.value = result; }
  catch (e) { if (request === contextGeneration) showError(e); } finally { if (request === contextGeneration) contextLoading.value = false; }
}
function resolveConflict(keep: boolean) {
  const latest = comparison.value; if (!latest) return;
  revision.value = latest.inventoryRevision;
  if (!keep) reset(latest.resource);
  else { initialResource = latest.resource ? clone(latest.resource) : null; if (!latest.resource) editingId.value = null; }
  conflict.value = false; comparison.value = null; error.value = ""; invalidate();
}
function create(e: CustomEvent<{ kind: string }>) { if (e.detail.kind === "directs" || e.detail.kind === "kernels") void open(e.detail.kind, null); }
function edit(e: CustomEvent<{ kind: string; id: string }>) {
  if (e.detail.kind !== "directs" && e.detail.kind !== "kernels") return;
  const resource = (e.detail.kind === "directs" ? dashboard.value?.inventory.directProtocols : dashboard.value?.inventory.kernelProtocols)?.find(item => item.id === e.detail.id);
  if (resource) void open(e.detail.kind, resource);
}
function beforeUnload(e: BeforeUnloadEvent) { if (dialog.value?.open && dirty.value) { e.preventDefault(); e.returnValue = ""; } }
onMounted(() => { window.addEventListener("birdbox:resource-create", create); window.addEventListener("birdbox:resource-edit", edit); window.addEventListener("beforeunload", beforeUnload); });
onBeforeUnmount(() => { contextGeneration++; invalidate(); stopInterfaces(); window.removeEventListener("birdbox:resource-create", create); window.removeEventListener("birdbox:resource-edit", edit); window.removeEventListener("beforeunload", beforeUnload); });
</script>

<template>
  <dialog id="systemProtocolDialog" ref="dialog" class="editor-dialog protocol-editor system-protocol-dialog" :aria-labelledby="`${kind}DialogTitle`" @cancel.prevent="close">
    <header class="dialog-head protocol-dialog-head"><span class="dialog-icon">{{ title[0] }}</span><div><p class="eyebrow">BIRD {{ title }}</p><h2 :id="`${kind}DialogTitle`">{{ editing ? '编辑' : '添加' }} {{ title }}</h2><p class="protocol-description">{{ kind === 'directs' ? '把选定接口的直连网段导入 BIRD 路由表。先选节点和接口，再预检应用。' : '在 BIRD 与 Linux 路由表之间同步路由。先选节点，再确认两个方向的策略。' }}</p><small class="system-edit-state">{{ editing ? dirty ? '有未保存修改' : '已保存' : '尚未创建' }} · 影响 {{ affectedIds.length }} 个节点 · {{ draft.name }}</small></div><button type="button" class="secondary-button compact-command protocol-close" :disabled="pending" @click="close">关闭</button></header>
    <form ref="form" @submit.prevent="save">
      <div class="system-protocol-content">
        <p v-if="contextLoading" role="status">正在加载最新编辑版本…</p>
        <p v-if="error" class="protocol-notice protocol-error" role="alert">{{ error }}</p>
        <section v-if="conflict" class="protocol-notice system-conflict" aria-label="库存冲突对比"><h3>草稿已保留</h3><p>先比较最新配置，再决定使用哪一份。</p><button class="secondary-button" type="button" :disabled="contextLoading" @click="compareLatest">加载最新版本并对比</button><template v-if="comparison"><details><summary>打开时的配置</summary><pre>{{ JSON.stringify(initialResource, null, 2) }}</pre></details><details><summary>服务端最新配置</summary><pre>{{ comparison.resource ? JSON.stringify(comparison.resource, null, 2) : '资源已被删除' }}</pre></details><details open><summary>本地草稿</summary><pre>{{ JSON.stringify(body(), null, 2) }}</pre></details><button type="button" class="secondary-button" @click="resolveConflict(false)">使用最新配置</button><button type="button" class="secondary-button" @click="resolveConflict(true)">{{ comparison.resource ? '保留草稿，重新预检' : '保留草稿，作为新资源预检' }}</button></template></section>
        <fieldset class="system-protocol-fields" :disabled="pending || contextLoading || conflict || revision === null">
          <section class="protocol-section"><div class="protocol-section-title"><span>1</span><div><h3>基本信息与节点</h3><p>选择本次配置要应用的位置。</p></div></div>
            <div class="dialog-grid"><label class="protocol-form-field" for="systemProtocolLabel">显示名称<input id="systemProtocolLabel" v-model.trim="draft.label" required placeholder="例如：边缘节点直连网段"></label><label class="protocol-form-field" for="systemProtocolName">协议名称<input id="systemProtocolName" v-model.trim="draft.name" required pattern="[A-Za-z_][A-Za-z0-9_]*"><small class="field-help">BIRD 配置中的唯一名称</small></label>
            <label v-if="kind === 'directs'" class="protocol-form-field full-width" for="directNode">所属节点<select id="directNode" v-model="draft.nodeId" @change="selectDirectNode"><option value="" disabled>请选择节点</option><option v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }} · {{ node.routerId }}</option></select></label>
            <template v-else><label class="protocol-form-field full-width" for="kernelScope">下发节点范围<select id="kernelScope" v-model="draft.kernelGlobal"><option :value="false">指定节点</option><option :value="true">所有节点（含后续新增）</option></select></label><div v-if="!draft.kernelGlobal" class="policy-scope-selector full-width"><div class="policy-scope-toolbar"><input v-model="kernelNodeSearch" type="search" placeholder="搜索节点" aria-label="搜索 Kernel 下发节点"><span><button class="compact-command" type="button" @click="draft.nodeIds = nodes.map(n => n.id)">全选</button><button class="compact-command" type="button" @click="draft.nodeIds = []">清空</button></span></div><div class="policy-scope-node-list"><label v-for="node in visibleKernelNodes" :key="node.id" class="policy-scope-node"><input type="checkbox" :checked="draft.nodeIds.includes(node.id)" @change="toggleNode(node.id)"><span><strong>{{ node.name }}</strong><code>{{ node.routerId }}</code></span></label><p v-if="!visibleKernelNodes.length">没有匹配的节点</p></div><p v-if="!draft.nodeIds.length" class="field-error">请至少选择一个节点</p></div></template>
            <div class="field full-width"><span class="field-label">地址族</span><div class="address-family-options" role="group" :aria-label="`${title} 地址族`"><label><input v-model="draft.ipv4" type="checkbox"><span>IPv4</span></label><label><input v-model="draft.ipv6" type="checkbox"><span>IPv6</span></label></div></div></div>
            <label class="toggle-row" for="systemProtocolEnabled"><span><strong>启用资源</strong><small>{{ draft.enabled ? '确认应用后加载协议' : '保留配置，确认应用后停用协议' }}</small></span><input id="systemProtocolEnabled" v-model="draft.enabled" type="checkbox"><i aria-hidden="true"></i></label>
          </section>
          <section v-if="kind === 'directs'" class="protocol-section"><div class="protocol-section-title"><span>2</span><div><h3>学习接口</h3><p>{{ draft.interfaces.length ? `仅学习 ${draft.interfaces.length} 条接口规则匹配的直连网段` : '当前学习全部接口的直连网段，也可以限定接口。' }}</p></div></div>
            <div class="field-label-row system-interface-actions"><span>{{ interfaceLoading ? '正在发现节点接口…' : '节点接口目录' }}</span><button v-if="interfaceLoading" type="button" class="secondary-button compact-command" @click="stopInterfaces">取消发现</button><button v-else type="button" class="secondary-button compact-command" :disabled="!draft.nodeId" @click="loadInterfaces(draft.nodeId)">刷新接口</button></div>
            <div class="interface-picker"><div class="interface-picker-toolbar"><input v-model="interfaceSearch" type="search" placeholder="搜索节点接口" aria-label="搜索节点接口"><span>{{ draft.interfaces.length }} 个已选择</span></div><div v-if="filteredInterfaces.length" class="interface-option-list"><label v-for="item in filteredInterfaces" :key="item" class="interface-option"><input type="checkbox" :checked="draft.interfaces.includes(item)" @change="toggleInterface(item)"><span><strong>{{ item }}</strong><small>{{ interfaceOptions.includes(item) ? '节点接口或已保存规则' : '手动规则' }}</small></span></label></div><p v-else class="interface-empty">{{ interfaceLoading ? '正在读取节点接口…' : '未发现接口，可继续手动填写规则。' }}</p></div>
            <label class="protocol-form-field protocol-source-field">手动接口或匹配规则<input :value="draft.interfaces.join(', ')" placeholder="例如 eth0, vlan*；留空匹配全部" aria-label="手动填写接口或匹配规则" @input="setManualInterfaces"></label><p v-if="interfaceError" class="field-error" role="status">{{ interfaceError }}</p><p class="protocol-help">逗号分隔多个规则，支持通配符。清空选择会匹配全部接口。</p>
            <details class="protocol-inline-disclosure"><summary>高级接口设置</summary><label class="protocol-checkbox"><input v-model="draft.checkLink" type="checkbox">检查链路状态（check link）</label><p class="protocol-help">仅在接口链路可用时学习直连网段。</p></details>
          </section>
          <template v-else>
            <section class="protocol-section"><div class="protocol-section-title"><span>2</span><div><h3>路由同步方向</h3><p>Import：Linux → BIRD；Export：BIRD → Linux。默认只向 Linux 导出。</p></div></div>
              <div v-for="family in enabledKernelFamilies" :key="`kernel-table-${family}`" class="system-kernel-table">
                <h4>{{ family === 'ipv4' ? 'IPv4' : 'IPv6' }} 路由表</h4><div class="dialog-grid"><label class="protocol-form-field">BIRD 表来源<select v-model="draft.tables[family].source" :aria-label="`${family} BIRD 表来源`"><option value="existing">引用已有表</option><option value="managed">由 Birdbox 创建</option></select></label><label class="protocol-form-field" :for="`kernelBirdTable-${family}`">BIRD 路由表<input :id="`kernelBirdTable-${family}`" v-model.trim="draft.tables[family].name" :list="`kernelTables-${family}`" required pattern="[A-Za-z_][A-Za-z0-9_]*"><datalist :id="`kernelTables-${family}`"><option v-for="table in tableSuggestions(family)" :key="table" :value="table" /></datalist></label></div>
                <p class="protocol-help">{{ draft.tables[family].source === 'managed' ? '管理表与 Pipe / Static 共享去重；停用协议后仍保留表。' : '可选库存已知表或填写节点上已有的表名，最终由节点预检验证。' }}</p>
                <details class="protocol-disclosure system-policy"><summary>Linux → BIRD（{{ family === 'ipv4' ? 'IPv4' : 'IPv6' }} Import）<span class="protocol-policy-summary">{{ policySummary(draft.importPolicies[family]) }}</span></summary><p class="protocol-help">从内核学习其它程序安装的路由还需在高级设置启用 learn。</p><PolicyEditor :family="family" direction="import" :policy="draft.importPolicies[family]" :export-define-id="null" :functions="functions" :filters="filters" :defines="[]" :disabled="pending" :show-policy-action="false" @update:policy="draft.importPolicies[family] = $event" /></details>
              <details class="protocol-disclosure system-policy"><summary>BIRD → Linux（{{ family === 'ipv4' ? 'IPv4' : 'IPv6' }} Export）<span class="protocol-policy-summary">{{ draft.exportPolicies[family].mode === 'krt_prefsrc' ? `源地址 ${draft.exportPolicies[family].prefSrc || '未填写'}` : policySummary(draft.exportPolicies[family].policy) }}</span></summary>
                <label class="protocol-form-field protocol-source-field">导出方式<select v-model="draft.exportPolicies[family].mode" :aria-label="`${family} Kernel 导出策略模式`"><option value="visual">可视化编辑</option><option value="krt_prefsrc">快速设置 krt_prefsrc</option></select></label>
                <label v-if="draft.exportPolicies[family].mode === 'krt_prefsrc'" class="protocol-form-field protocol-source-field" :for="`kernelPrefSrc-${family}`">源地址（{{ family === 'ipv4' ? 'IPv4' : 'IPv6' }}）<input :id="`kernelPrefSrc-${family}`" v-model.trim="draft.exportPolicies[family].prefSrc" required :placeholder="family === 'ipv4' ? '192.0.2.1' : '2001:db8::1'"><small class="field-help">向 Linux 导出的路由指定首选源地址并接受全部路由。</small></label>
                <PolicyEditor v-else :family="family" direction="export" :policy="draft.exportPolicies[family].policy" :export-define-id="null" :functions="functions" :filters="filters" :defines="[]" :disabled="pending" :show-policy-action="false" :allow-export-cidr="false" @update:policy="draft.exportPolicies[family].policy = $event" />
              </details>
              </div>
            </section>
            <details class="protocol-disclosure"><summary>高级内核设置<span class="protocol-policy-summary">Linux 表 {{ draft.table ?? 'main' }} · 扫描 {{ draft.scanTime ?? '默认' }} 秒</span></summary><div class="dialog-grid"><label class="protocol-form-field">Linux 路由表<NullableNumberInput v-model="draft.table" min="1" max="4294967295" placeholder="留空使用 main" /></label><label class="protocol-form-field">扫描周期（秒）<NullableNumberInput v-model="draft.scanTime" min="1" max="86400" /></label><label class="protocol-form-field">默认 Metric<NullableNumberInput v-model="draft.metric" min="0" max="4294967295" placeholder="使用 BIRD 默认值" /></label><label class="protocol-form-field">ECMP 路径上限<NullableNumberInput v-model="draft.mergePaths" min="1" max="64" placeholder="留空关闭合并" /></label></div><label class="protocol-checkbox"><input v-model="draft.persist" type="checkbox">退出 BIRD 时保留内核路由（persist）</label><label class="protocol-checkbox"><input v-model="draft.learn" type="checkbox">学习其它程序安装的路由（learn）</label><label class="protocol-checkbox"><input v-model="draft.gracefulRestart" type="checkbox">平滑重启（graceful restart）</label><p class="protocol-help">Linux 路由表是系统 FIB，不是上方的 BIRD 表名；两侧表一一对应，每个地址族分别同步。</p></details>
          </template>
        </fieldset>
        <section v-if="preview" id="systemProtocolPreview" class="protocol-preview" aria-label="服务端预检结果"><h3>{{ preview.valid ? '预检通过，可以确认应用' : '预检未通过，请修正后重试' }}</h3><p>受影响节点 {{ preview.configs.length }} 个。这里只检查候选配置，不修改库存或活动配置。</p><article v-for="item in preview.configs" :key="item.nodeId"><h4>{{ nameForNode(item.nodeId) }} · {{ item.validation.ok ? '通过' : '失败' }}</h4><p v-if="!item.validation.ok" class="protocol-error">{{ item.validation.stderr || item.validation.stdout }}</p><details open><summary>配置差异</summary><pre>{{ item.diff }}</pre></details><details><summary>完整服务端配置</summary><pre>{{ item.config }}</pre></details></article></section>
      </div>
      <footer class="dialog-actions protocol-editor-actions"><button v-if="editing" class="text-danger-button" type="button" :disabled="pending || contextLoading || conflict || revision === null" @click="remove">删除资源</button><span class="protocol-save-hint">{{ pending ? '正在预检并应用，请等待结果' : preview?.valid ? '确认后才下发远端配置' : '先查看差异，再确认应用' }}</span><button class="secondary-button" type="button" :disabled="pending" @click="close">取消</button><button v-if="preview?.valid" class="secondary-button" type="button" :disabled="pending || previewPending" @click="inspect">重新预检</button><button class="primary-button" type="submit" :disabled="pending || previewPending || contextLoading || conflict || revision === null">{{ pending ? '正在应用' : previewPending ? '正在预检…' : preview?.valid ? '确认应用' : '预检并查看变更' }}</button></footer>
    </form>
  </dialog>
</template>
<style scoped>
.system-protocol-dialog { width: min(920px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; overflow: clip; }
.system-protocol-dialog[open] { display: flex; flex-direction: column; }
.system-protocol-dialog form { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: clip; }
.system-protocol-content { display: grid; gap: 16px; min-height: 0; padding: 20px 24px; overflow: auto; overscroll-behavior: contain; }
.system-protocol-fields { display: grid; gap: 16px; min-width: 0; margin: 0; padding: 0; border: 0; }
.system-edit-state { display: block; margin-top: 6px; color: var(--muted); overflow-wrap: anywhere; }
.toggle-row input:focus-visible + i { outline: 2px solid var(--green); outline-offset: 3px; }
.system-interface-actions { margin: 16px 0 10px; }
.system-policy { margin-top: 14px; }
.system-kernel-table { margin-top: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.system-kernel-table h4 { margin: 0; font-size: 13px; }
.protocol-preview article { border-top: 1px solid var(--line); padding-top: 8px; margin-top: 14px; min-width: 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; max-height: 360px; overflow: auto; font-size: 11px; }
.protocol-editor-actions { flex-shrink: 0; margin: 0; }
.system-conflict { display: grid; gap: 10px; min-width: 0; }
.system-conflict h3 { margin: 0; }
@media (max-width: 600px) { .system-protocol-dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); } .system-protocol-content { padding: 12px; } .dialog-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
