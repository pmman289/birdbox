<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import type { ResourceDeleteResponse, ResourceMutationResponse, StaticMutationRequest, StaticPreviewResponse } from "@birdbox/contracts/api";
import type {
  AddressFamily,
  CidrDefine,
  StaticProtocol,
  StaticRouteFilter,
  StaticRoute,
  StaticRouteAction,
  StaticRouteForwarding,
} from "@birdbox/contracts/inventory";
import { resourceAppliesToNode } from "@birdbox/contracts/resource-scope";

import { loadDashboard, useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
import { cloneReactive } from "../shared/clone-reactive";
import { deploymentSummary } from "../shared/deployment";
import { dispatchToast } from "../shared/events";
import { clearFormValidation, markFieldInvalid, presentFormError, validateForm } from "../shared/form-validation";
import { uniqueBirdName } from "../shared/resource-names";
import { resourceScopeShortLabel } from "../shared/resource-scope";
import StaticRoutesEditor from "./StaticRoutesEditor.vue";
import PolicyEditor from "../sessions/PolicyEditor.vue";
import { defineRoute, routeForwarding } from "../shared/static-route-sources";

type StaticDraft = Omit<StaticMutationRequest, "routeActions" | "routeFilters">;

interface ReferenceItem {
  id: string;
  label: string;
  name: string;
  symbol: string;
  insertion: string;
  kind: "Define" | "Function";
  nodeIds: string[] | null;
}

const dialog = ref<HTMLDialogElement | null>(null);
const form = ref<HTMLFormElement | null>(null);
const editingId = ref<string | null>(null);
const pending = ref(false);
const nameEdited = ref(false);
const routeEditorVersion = ref(0);
const serverPreview = ref<StaticPreviewResponse | null>(null);
const previewPending = ref(false), previewError = ref("");
const tableCatalog = ref<Array<{ nodeId: string; name: string; family: AddressFamily }>>([]);
let previewGeneration = 0, catalogGeneration = 0, previewController: AbortController | null = null, savedSignature = "";

const routeActions = reactive<Record<string, StaticRouteAction>>({});
const defineDrafts = reactive<Record<string, StaticRoute>>({});
const defineDefaults = reactive<Record<string, StaticRouteAction>>({});
const originalDefineId = ref<string | null>(null);
const hydrating = ref(false);
const routeFilters = reactive<Record<string, StaticRouteFilter>>({});
const { dashboard } = useDashboardStore();

const draft = reactive<StaticDraft>({
  nodeId: "",
  label: "",
  name: "",
  family: "ipv4",
  defineId: null,
  action: null,
  import: "all",
  export: "none",
  raw: "",
  enabled: true,
  routes: [], table: { name: "master4", source: "existing" }, igpTable: null, checkLink: false,
});

const editing = computed(() => editingId.value !== null);
const inventory = computed(() => dashboard.value?.inventory ?? null);
const nodes = computed(() => inventory.value?.nodes ?? []);
const compatibleDefines = computed<CidrDefine[]>(() => (inventory.value?.defines ?? []).filter((resource): resource is CidrDefine =>
  resource.enabled
  && resource.type === (draft.family === "ipv6" ? "cidr6" : "cidr4")
  && resourceAppliesToNode(resource, draft.nodeId),
));
const selectedDefine = computed(() => compatibleDefines.value.find((resource) => resource.id === draft.defineId) ?? null);
const routeEntries = computed(() => (selectedDefine.value?.entries ?? []).filter((entry) => /^[0-9A-Fa-f:.]+\/\d{1,3}$/.test(entry)));
const references = computed<ReferenceItem[]>(() => {
  const current = inventory.value;
  if (!current) return [];
  const items: ReferenceItem[] = [
    ...current.defines.filter((item) => item.enabled && resourceAppliesToNode(item, draft.nodeId)).map((item) => ({ id: item.id, label: item.label, name: item.name, symbol: item.name, insertion: item.name, kind: "Define" as const, nodeIds: item.nodeIds })),
    ...current.functions.filter((item) => item.enabled && item.callable && resourceAppliesToNode(item, draft.nodeId)).map((item) => ({ id: item.id, label: item.label, name: item.name, symbol: `${item.name}()`, insertion: `${item.name}()`, kind: "Function" as const, nodeIds: item.nodeIds })),
  ];
  return items;
});

const fieldMappings = [
  [/Static 所属节点|不存在的节点/, "staticNodeId"],
  [/Static 显示名称/, "staticLabel"],
  [/Static 协议名称|BIRD 全局标识符冲突/, "staticName"],
  [/Static 地址族/, "staticFamily"],
  [/Static.*CIDR Define/, "staticDefineId"],

  [/Static Import/, "staticImport"],
  [/Static Export/, "staticExport"],
  [/Static 资源至少|Static 指令/, "staticRaw"],
] as const;

function emptyFilter(): StaticRouteFilter {
  return { operations: [], custom: "" };
}

function cloneFilter(filter: StaticRouteFilter | undefined): StaticRouteFilter {
  return cloneReactive(filter ?? emptyFilter());
}

function clearRecord<Value>(record: Record<string, Value>): void {
  for (const key of Object.keys(record)) delete record[key];
}

function generatedRoute(prefix: string): StaticRoute {
  const defineId = draft.defineId!;
  const key = `${defineId}:${prefix}`;
  if (!defineDrafts[key]) {
    const original = defineId === originalDefineId.value;
    defineDrafts[key] = defineRoute(prefix, defineId, (original ? routeActions[prefix] : undefined) ?? defineDefaults[defineId] ?? "blackhole", (original ? routeFilters[prefix] : undefined) ?? emptyFilter());
  }
  return defineDrafts[key]!;
}
const generatedRoutes = computed(() => !hydrating.value && draft.defineId ? routeEntries.value.map(generatedRoute) : []);
const origins = computed(() => Object.fromEntries(generatedRoutes.value.map(route => [route.id, selectedDefine.value?.label ?? selectedDefine.value?.name ?? "CIDR Define"])));
const allRoutes = computed<StaticRoute[]>({
  get: () => [...generatedRoutes.value, ...draft.routes ?? []],
  set: routes => {
    const generatedIds = new Set(generatedRoutes.value.map(route => route.id));
    draft.routes = routes.filter(route => !generatedIds.has(route.id));
    for (const route of routes.filter(route => generatedIds.has(route.id))) defineDrafts[`${draft.defineId}:${route.prefix}`] = route;
  },
});
function setDefaultForwarding(value: StaticRouteForwarding): void {
  if (draft.defineId) defineDefaults[draft.defineId] = { ...cloneReactive(value), enabled: true };
}
function syncRoutes(): void {
  if (draft.defineId) {
    defineDefaults[draft.defineId] ??= "blackhole";
    routeEntries.value.forEach(generatedRoute);
  }
}

function syncName(): void {
  if (editing.value || nameEdited.value || !draft.label || !inventory.value) return;
  draft.name = uniqueBirdName(inventory.value, draft.family === "ipv6" ? "birdbox_static6" : "birdbox_static4", draft.label);
}

function changeFamily(): void {
  if (draft.table && ["master4", "master6"].includes(draft.table.name)) draft.table.name = draft.family === "ipv4" ? "master4" : "master6";
  if (!compatibleDefines.value.some((resource) => resource.id === draft.defineId)) draft.defineId = null;
  if (!editing.value && !nameEdited.value) syncName();
  syncRoutes();
}

function open(resource: StaticProtocol | null): void {
  if (pending.value) return;
  const selectedNodeId = resource?.nodeId ?? dashboard.value?.node?.id ?? nodes.value[0]?.id ?? "";
  if (!selectedNodeId) {
    dispatchToast("请先添加受管节点", "error");
    return;
  }
  invalidatePreview(); previewError.value = ""; routeEditorVersion.value++;
  // Populate all source snapshots before reactive readers can initialize route drafts.
  hydrating.value = true;
  editingId.value = resource?.id ?? null;
  Object.assign(draft, {
    nodeId: selectedNodeId,
    label: resource?.label ?? "",
    name: resource?.name ?? "",
    family: resource?.family ?? "ipv4",
    defineId: resource?.defineId ?? null,
    action: resource?.action ?? null,
    import: resource?.import ?? "all",
    export: resource?.export ?? "none",
    raw: resource?.raw ?? "",
    enabled: resource?.enabled ?? true,
    routes: cloneReactive(resource?.routes ?? []),
    table: cloneReactive(resource?.table ?? { name: resource?.family === "ipv6" ? "master6" : "master4", source: "existing" }),
    igpTable: resource?.igpTable ?? null, checkLink: resource?.checkLink ?? false,
    importPolicy: cloneReactive(resource?.importPolicy ?? { mode: "form", formAction: resource?.import ?? "all", steps: [], filterId: null }),
  });
  clearRecord(defineDrafts); clearRecord(defineDefaults); originalDefineId.value = resource?.defineId ?? null;
  if (resource?.defineId) defineDefaults[resource.defineId] = cloneReactive(resource.action ?? "blackhole");
  clearRecord(routeActions);
  clearRecord(routeFilters);
  Object.assign(routeActions, cloneReactive(resource?.routeActions ?? {}));
  for (const [prefix, filter] of Object.entries(resource?.routeFilters ?? {})) routeFilters[prefix] = cloneFilter(filter);
  nameEdited.value = Boolean(resource);
  syncRoutes();
  hydrating.value = false;
  if (form.value) clearFormValidation(form.value);
  savedSignature = signature.value;
  dialog.value?.querySelectorAll("details[open]").forEach(item => item.removeAttribute("open"));
  if (!dialog.value?.open) dialog.value?.showModal();
  tableCatalog.value = []; const request = ++catalogGeneration;
  void api<{ tables: typeof tableCatalog.value }>("/api/pipes/tables").then(result => { if (request === catalogGeneration && dialog.value?.open) tableCatalog.value = result.tables; }).catch(() => {});
  dialog.value?.scrollTo({ top: 0 });
  void nextTick(() => { dialog.value?.querySelector(".static-content")?.scrollTo({ top: 0 }); document.querySelector<HTMLInputElement>("#staticLabel")?.focus({ preventScroll: true }); });
}

function close(): void {
  if (pending.value) return;
  if (signature.value !== savedSignature && !window.confirm("放弃尚未保存的 Static 修改？")) return;
  catalogGeneration++; invalidatePreview(); dialog.value?.close();
}

function payload(): StaticMutationRequest {
  const generated = generatedRoutes.value;
  const action = draft.defineId ? defineDefaults[draft.defineId] ?? "blackhole" : null;
  return {
    nodeId: draft.nodeId,
    label: draft.label,
    name: draft.name,
    family: draft.family,
    defineId: draft.defineId,
    action,
    routeActions: draft.defineId ? Object.fromEntries(generated.map(route => [route.prefix, routeForwarding(route)])) : {},
    routeFilters: draft.defineId ? Object.fromEntries(generated.map(route => [route.prefix, cloneFilter(route.filter)])) : {},
    import: draft.import,
    export: draft.export,
    raw: draft.raw,
    enabled: draft.enabled,
    routes: cloneReactive(draft.routes ?? []), table: cloneReactive(draft.table), igpTable: draft.igpTable || null, checkLink: draft.checkLink,
    importPolicy: draft.importPolicy ? cloneReactive(draft.importPolicy) : undefined,
  };
}

const signature = computed(() => JSON.stringify([draft, generatedRoutes.value, defineDefaults[draft.defineId ?? ""]]));
const tableSuggestions = computed(() => tableCatalog.value.filter(item => item.nodeId === draft.nodeId && item.family === draft.family));
const policyFunctions = computed(() => inventory.value?.functions.filter(item => item.enabled && resourceAppliesToNode(item, draft.nodeId)) ?? []);
const policyFilters = computed(() => inventory.value?.filters.filter(item => item.enabled && resourceAppliesToNode(item, draft.nodeId)) ?? []);
function invalidatePreview() { previewGeneration++; previewController?.abort(); previewController = null; previewPending.value = false; serverPreview.value = null; }
watch(signature, () => {
  invalidatePreview();
  for (const id of ["staticDefineId", "staticRaw"]) form.value?.querySelector<HTMLInputElement>(`#${id}`)?.setCustomValidity("");
}, { flush: "sync" });
async function inspect(): Promise<boolean> {
  if (!form.value || !validateForm(form.value)) return false;
  invalidatePreview(); const request = previewGeneration; previewController = new AbortController(); const signal = previewController.signal;
  previewPending.value = true; previewError.value = "";
  try {
    const result = await api<StaticPreviewResponse>("/api/statics/preview", { method: "POST", body: JSON.stringify({ ...payload(), ...(editingId.value ? { id: editingId.value } : {}) }), signal, timeoutMs: 120_000, mutationWait: false });
    if (request !== previewGeneration || signal.aborted) return false;
    serverPreview.value = result; await nextTick();
    const content = dialog.value?.querySelector<HTMLElement>(".static-content"), panel = dialog.value?.querySelector<HTMLElement>("#staticServerPreview");
    if (content && panel) content.scrollTop += panel.getBoundingClientRect().top - content.getBoundingClientRect().top; return result.valid;
  } catch (error) { if (request === previewGeneration && !signal.aborted) { previewError.value = error instanceof Error ? error.message : "预检失败"; presentFormError(form.value!, error, fieldMappings); } return false; }
  finally { if (request === previewGeneration) previewPending.value = false; }
}

async function save(): Promise<void> {
  if (!form.value) return;
  const defineInput = form.value.querySelector<HTMLSelectElement>("#staticDefineId");
  const rawInput = form.value.querySelector<HTMLTextAreaElement>("#staticRaw");
  defineInput?.setCustomValidity(draft.defineId && !routeEntries.value.length && !draft.raw.trim() && !draft.routes?.length ? "所选 CIDR Define 没有可用于 Static 的完整 CIDR 条目" : "");
  rawInput?.setCustomValidity(!draft.defineId && !draft.raw.trim() && !draft.routes?.length ? "请配置标准路由或填写自定义 Static 指令" : "");
  if (!validateForm(form.value)) return;
  if (!serverPreview.value?.valid) {
    await inspect();
    if (serverPreview.value?.valid) previewError.value = "预检已通过，请查看下方配置变更，再点击保存并应用。";
    return;
  }
  pending.value = true;
  const acceptedPreview = serverPreview.value;
  const id = editingId.value;
  try {
    const result = await api<ResourceMutationResponse<StaticProtocol>>(id ? `/api/statics/${encodeURIComponent(id)}` : "/api/statics", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify({ ...(({ id: _id, ...rest }) => rest)(acceptedPreview.resource), previewId: acceptedPreview.previewId, inventoryRevision: acceptedPreview.inventoryRevision }),
    });
    const peerId = dashboard.value?.node?.id === draft.nodeId ? dashboard.value.selectedPeer?.id ?? null : null;
    try { await loadDashboard(draft.nodeId, peerId); } catch { dispatchToast("Static 已应用，请刷新资源列表", "error"); }
    window.dispatchEvent(new CustomEvent("birdbox:resource-tab-select", { detail: { target: "statics" } }));
    dialog.value?.close();
    dispatchToast(`Static 已${id ? "更新" : "添加"}，${deploymentSummary(result.deployment)}`, "success");
  } catch (error) {
    invalidatePreview();
    previewError.value = error instanceof Error ? error.message : "应用失败，编辑内容已保留";
    presentFormError(form.value, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

async function remove(): Promise<void> {
  const resource = editingId.value ? inventory.value?.staticProtocols.find((item) => item.id === editingId.value) : null;
  if (!resource || !window.confirm(`删除 Static ${resource.name}？`)) return;
  pending.value = true;
  try {
    const result = await api<ResourceDeleteResponse>(`/api/statics/${encodeURIComponent(resource.id)}`, { method: "DELETE" });
    try { await loadDashboard(resource.nodeId, dashboard.value?.node?.id === resource.nodeId ? dashboard.value.selectedPeer?.id ?? null : null); } catch { dispatchToast("Static 已删除，请刷新资源列表", "error"); }
    window.dispatchEvent(new CustomEvent("birdbox:resource-tab-select", { detail: { target: "statics" } }));
    dialog.value?.close();
    dispatchToast(`Static 已删除，${deploymentSummary(result.deployment)}`, "success");
  } catch (error) {
    presentFormError(form.value!, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

function handleCreate(event: CustomEvent<{ kind: string }>): void {
  if (event.detail.kind === "statics") open(null);
}

function handleEdit(event: CustomEvent<{ kind: string; id: string }>): void {
  if (event.detail.kind !== "statics") return;
  const resource = inventory.value?.staticProtocols.find((item) => item.id === event.detail.id) ?? null;
  if (resource) open(resource);
}

watch(() => [draft.nodeId, draft.family, draft.defineId, routeEntries.value.join("\n")], syncRoutes);
onMounted(() => {
  window.addEventListener("birdbox:resource-create", handleCreate);
  window.addEventListener("birdbox:resource-edit", handleEdit);
});
onBeforeUnmount(() => {
  catalogGeneration++; invalidatePreview();
  window.removeEventListener("birdbox:resource-create", handleCreate);
  window.removeEventListener("birdbox:resource-edit", handleEdit);
});
</script>

<template>
  <dialog id="staticDialog" ref="dialog" class="editor-dialog static-editor-dialog static-dialog protocol-editor" aria-labelledby="staticDialogTitle" @cancel.prevent="close">
    <form id="staticForm" ref="form" novalidate :aria-busy="pending" @submit.prevent="save">
      <div class="dialog-head protocol-dialog-head"><span class="dialog-icon">S</span><div><p class="eyebrow">BIRD Static</p><h2 id="staticDialogTitle">{{ editing ? "编辑 Static 资源" : "添加 Static 资源" }}</h2><p class="protocol-description">选择节点与路由表，添加路由，预检后确认应用。</p></div><button type="button" class="secondary-button compact-command protocol-close" aria-label="关闭 Static 编辑器" :disabled="pending" @click="close">关闭</button></div>
      <div class="static-content"><fieldset class="static-fields" :disabled="pending">
        <section class="protocol-section" aria-labelledby="staticBasicsTitle">
          <div class="protocol-section-title"><span>1</span><div><h3 id="staticBasicsTitle">基本信息</h3><p>此资源只应用到所选节点。</p></div></div>
          <div class="dialog-grid">
            <div class="field"><label for="staticLabel">显示名称</label><input id="staticLabel" v-model.trim="draft.label" maxlength="80" required @input="syncName"></div>
            <div class="field"><label for="staticName">BIRD 名称（自动，可编辑）</label><input id="staticName" v-model.trim="draft.name" pattern="[A-Za-z_][A-Za-z0-9_]*" maxlength="64" required @input="nameEdited = true"></div>
            <div class="field"><label for="staticNodeId">所属节点</label><select id="staticNodeId" v-model="draft.nodeId" required :disabled="editing"><option v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></div>
            <div class="field"><label for="staticFamily">地址族</label><select id="staticFamily" v-model="draft.family" @change="changeFamily"><option value="ipv4">IPv4</option><option value="ipv6">IPv6</option></select></div>
          </div>
          <label class="toggle-row" for="staticEnabled"><span><strong>启用资源</strong><small>{{ draft.enabled ? '应用后加载该协议' : '保留配置与管理表，停用协议' }}</small></span><input id="staticEnabled" v-model="draft.enabled" type="checkbox"><i aria-hidden="true"></i></label>
        </section>
        <section v-if="draft.table" class="protocol-section static-table-settings" aria-labelledby="staticTableTitle">
          <div class="protocol-section-title"><span>2</span><div><h3 id="staticTableTitle">路由表</h3><p>静态路由写入此 BIRD 表，可通过 Pipe 传递到其它表。</p></div></div>
          <div class="dialog-grid"><label class="protocol-form-field">表来源<select v-model="draft.table.source" id="staticTableSource"><option value="existing">引用已有表</option><option value="managed">由 Birdbox 创建</option></select></label><label class="protocol-form-field">写入 BIRD 路由表<input id="staticTable" v-model.trim="draft.table.name" list="staticKnownTables" required placeholder="master4"></label></div>
          <datalist id="staticKnownTables"><option v-for="item in tableSuggestions" :key="item.name" :value="item.name" /></datalist>
          <p class="protocol-help">这是 BIRD 路由表，不是 Linux 内核表编号。停用协议会保留管理表。</p>
        </section>
        <section class="protocol-section" aria-labelledby="staticRoutesTitle">
          <div class="protocol-section-title"><span>3</span><div><h3 id="staticRoutesTitle">配置路由</h3><p>直接添加或关联 Define，所有条目在此统一编辑。</p></div></div>
          <div class="field protocol-source-field"><label for="staticDefineId">关联 CIDR Define（可选）</label><select id="staticDefineId" v-model="draft.defineId"><option :value="null">不关联，仅直接添加路由</option><option v-for="resource in compatibleDefines" :key="resource.id" :value="resource.id">{{ resource.label }} · {{ resource.name }} · {{ resourceScopeShortLabel(resource, draft.nodeId) }}</option></select><p class="protocol-help">关联后自动生成网段，可与手动路由一起编辑。网段随 Define 更新，转发设置可逐条覆盖；不再需要的条目可单独停用。</p></div>
          <StaticRoutesEditor :key="routeEditorVersion" v-model="allRoutes" :origins="origins" :references="references" :family="draft.family" @apply-forwarding="setDefaultForwarding" />
        </section>
        <details class="static-protocol-advanced protocol-disclosure"><summary>协议高级设置与 Import 策略</summary>
          <div class="dialog-grid"><label class="protocol-form-field">递归查询的 IGP 表（可选）<input id="staticIgpTable" v-model.trim="draft.igpTable" list="staticKnownTables" placeholder="默认使用当前 BIRD 路由表"></label><label class="protocol-checkbox"><input id="staticCheckLink" v-model="draft.checkLink" type="checkbox">检测出口接口链路状态（check link）</label></div>
          <div class="field protocol-source-field"><label for="staticExport">Static Export</label><select id="staticExport" v-model="draft.export"><option value="none">none（默认）</option><option value="all">all</option></select></div>
          <p class="protocol-help">Import 控制静态路由进入 BIRD 表；向 BGP / OSPF 发布时仍由对应协议策略决定。</p>
          <details id="staticImport" class="protocol-inline-disclosure"><summary>Import 策略 · {{ draft.importPolicy?.mode === "custom" ? "自定义 Filter" : draft.importPolicy?.mode === "combined" ? "Function 组合" : draft.importPolicy?.formAction === "none" ? "不接收静态路由" : "接收所有静态路由" }}</summary>
          <PolicyEditor v-if="draft.importPolicy" :family="draft.family" direction="import" :policy="draft.importPolicy" :export-define-id="null" :functions="policyFunctions" :filters="policyFilters" :defines="[]" :disabled="pending" :show-policy-action="false" :allow-export-cidr="false" @update:policy="draft.importPolicy = $event" />
          </details>
        <div class="field full-width"><label for="staticRaw">自定义 Static 指令</label><textarea id="staticRaw" v-model="draft.raw" class="compact-code-editor" spellcheck="false" placeholder="route 192.0.2.0/24 via 198.51.100.1;"></textarea></div>
        </details>
      <p v-if="previewError" role="alert" class="protocol-notice">{{ previewError }}</p>
      <section v-if="serverPreview" id="staticServerPreview" class="protocol-preview"><h3>{{ serverPreview.valid ? '预检通过' : '预检未通过' }}</h3><p>受影响节点：{{ nodes.find(node => node.id === draft.nodeId)?.name }}。{{ draft.enabled ? '' : '当前为停用配置；已额外检查启用后的合法性。' }}</p><article v-for="item in serverPreview.configs" :key="item.nodeId"><pre>{{ item.validation.stdout }}{{ item.validation.stderr }}</pre><details open><summary>配置变更</summary><pre>{{ item.diff }}</pre></details><details><summary>服务端生成的完整配置</summary><pre>{{ item.config }}</pre></details></article></section>
      </fieldset></div>
      <div class="dialog-actions protocol-editor-actions"><button v-if="editing" id="deleteStaticButton" class="text-danger-button" type="button" :disabled="pending" @click="remove">删除 Static</button><span class="protocol-save-hint">{{ pending ? '正在下发配置，请稍候' : serverPreview?.valid ? '预检通过 · 等待确认应用' : signature !== savedSignature ? '有未保存修改 · 请先预检' : editing ? '已保存 · 修改后需重新预检' : '新建资源 · 请先预检' }}</span><button class="secondary-button" type="button" data-close="staticDialog" :disabled="pending" @click.stop="close">取消</button><button v-if="serverPreview" class="secondary-button" type="button" :disabled="pending || previewPending" @click="inspect">{{ previewPending ? "预检中…" : "重新预检" }}</button><button id="saveStaticButton" class="primary-button" type="submit" :disabled="pending || previewPending">{{ pending ? "正在应用…" : previewPending ? "预检中…" : serverPreview?.valid ? "保存并应用" : "预检并查看变更" }}</button></div>
    </form>
  </dialog>
</template>

<style scoped>
.static-dialog { width: min(1040px, calc(100vw - 32px)); max-width: calc(100vw - 24px); max-height: 92dvh; overflow: clip; padding: 0; box-sizing: border-box; }
.static-dialog[open] { display: flex; flex-direction: column; }
.static-dialog form { display: flex; flex-direction: column; min-height: 0; height: min(92dvh, 920px); max-height: 92dvh; padding: 0; overflow: clip; }
.static-dialog .dialog-head { flex-shrink: 0; }
.static-content { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 20px 24px; overscroll-behavior: contain; background: var(--surface-soft); }
.static-fields { display: grid; gap: 16px; border: 0; min-width: 0; margin: 0; padding: 0; }
.static-dialog .dialog-actions { flex-shrink: 0; margin: 0; }
.static-source-field { margin: 16px 0; }
.static-dialog .toggle-row { margin-top: 16px; }
.static-dialog pre { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; overflow: auto; }
.static-dialog :deep(.policy-block) { margin-top: 16px; }
@media (max-width: 600px) {
  .static-content { padding: 12px; }
  .static-dialog .dialog-grid { grid-template-columns: minmax(0, 1fr); }
  .static-dialog .static-route-bulk { grid-template-columns: minmax(0, 1fr); }
}
</style>
