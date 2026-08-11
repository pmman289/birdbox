<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRaw, watch } from "vue";

import type { ResourceDeleteResponse, ResourceMutationResponse, StaticMutationRequest } from "@birdbox/contracts/api";
import type {
  AddressFamily,
  CidrDefine,
  StaticProtocol,
  StaticRouteFilter,
  StaticRouteFilterOperation,
} from "@birdbox/contracts/inventory";
import { resourceAppliesToNode } from "@birdbox/contracts/resource-scope";

import { loadDashboard, useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
import { deploymentSummary } from "../shared/deployment";
import { dispatchToast } from "../shared/events";
import { clearFormValidation, markFieldInvalid, presentFormError, validateForm } from "../shared/form-validation";
import { uniqueBirdName } from "../shared/resource-names";
import { resourceScopeShortLabel } from "../shared/resource-scope";
import StaticRouteOperationRow from "./StaticRouteOperationRow.vue";

type RouteActionKind = "blackhole" | "reject" | "unreachable" | "prohibit" | "via";
type OperationKind = StaticRouteFilterOperation["type"];

interface StaticDraft extends Omit<StaticMutationRequest, "routeActions" | "routeFilters" | "action"> {
  action: string | null;
}

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
const customEditor = ref<HTMLTextAreaElement | null>(null);
const editingId = ref<string | null>(null);
const pending = ref(false);
const nameEdited = ref(false);
const selectedPrefix = ref<string | null>(null);
const bulkAction = ref<RouteActionKind>("blackhole");
const bulkVia = ref("");
const addOperationType = ref<OperationKind>("set");
const referenceSearch = ref("");
const routeActions = reactive<Record<string, string>>({});
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
const selectedFilter = computed(() => selectedPrefix.value ? ensureFilter(selectedPrefix.value) : null);
const selectedAction = computed(() => selectedPrefix.value ? actionParts(ensureAction(selectedPrefix.value)) : { action: "blackhole" as RouteActionKind, via: "" });

const references = computed<ReferenceItem[]>(() => {
  const current = inventory.value;
  if (!current) return [];
  const items: ReferenceItem[] = [
    ...current.defines.filter((item) => item.enabled && resourceAppliesToNode(item, draft.nodeId)).map((item) => ({ id: item.id, label: item.label, name: item.name, symbol: item.name, insertion: item.name, kind: "Define" as const, nodeIds: item.nodeIds })),
    ...current.functions.filter((item) => item.enabled && item.callable && resourceAppliesToNode(item, draft.nodeId)).map((item) => ({ id: item.id, label: item.label, name: item.name, symbol: `${item.name}()`, insertion: `${item.name}()`, kind: "Function" as const, nodeIds: item.nodeIds })),
  ];
  const query = referenceSearch.value.trim().toLocaleLowerCase();
  if (!query) return items;
  return items.filter((item) => [item.label, item.name, item.kind, item.symbol, resourceScopeShortLabel(item)].join(" ").toLocaleLowerCase().includes(query));
});

const preview = computed(() => {
  const prefix = selectedPrefix.value;
  const filter = selectedFilter.value;
  if (!prefix || !filter) return "";
  const routeAction = ensureAction(prefix);
  const hasBlock = filter.operations.length > 0 || Boolean(filter.custom);
  const lines = [`route ${prefix} ${routeAction}${hasBlock ? " {" : ";"}`];
  for (const operation of filter.operations) {
    if (operation.type === "set") {
      lines.push(`  ${operation.attribute} = ${operation.attribute === "bgp_origin" ? `ORIGIN_${operation.value.toUpperCase()}` : operation.value};`);
    } else if (operation.type === "community") {
      const attribute = operation.list === "large" ? "bgp_large_community" : "bgp_community";
      lines.push(operation.operation === "empty" ? `  ${attribute}.empty;` : `  ${attribute}.${operation.operation}((${operation.value.join(", ")}));`);
    } else {
      for (let count = 0; count < operation.count; count += 1) lines.push(`  bgp_path.prepend(${operation.asn});`);
    }
  }
  if (filter.custom) lines.push(...filter.custom.split("\n").map((line) => `  ${line}`));
  if (hasBlock) lines.push("};");
  return lines.join("\n");
});

const fieldMappings = [
  [/Static 所属节点|不存在的节点/, "staticNodeId"],
  [/Static 显示名称/, "staticLabel"],
  [/Static 协议名称|BIRD 全局标识符冲突/, "staticName"],
  [/Static 地址族/, "staticFamily"],
  [/Static.*CIDR Define/, "staticDefineId"],
  [/Static CIDR .*via 地址|静态路由动作/, "staticRouteVia"],
  [/Static CIDR .*快捷操作/, "staticFilterOperationList"],
  [/Static CIDR .*自定义 per-route/, "staticRouteCustom"],
  [/Static Import/, "staticImport"],
  [/Static Export/, "staticExport"],
  [/Static 资源至少|Static 指令/, "staticRaw"],
] as const;

function emptyFilter(): StaticRouteFilter {
  return { operations: [], custom: "" };
}

function cloneFilter(filter: StaticRouteFilter | undefined): StaticRouteFilter {
  return structuredClone(toRaw(filter ?? emptyFilter()));
}

function cloneOperation(operation: StaticRouteFilterOperation): StaticRouteFilterOperation {
  return structuredClone(toRaw(operation));
}

function clearRecord<Value>(record: Record<string, Value>): void {
  for (const key of Object.keys(record)) delete record[key];
}

function actionParts(action: string): { action: RouteActionKind; via: string } {
  const match = /^via(?:\s+(.*))?$/i.exec(action);
  return match ? { action: "via", via: match[1] ?? "" } : { action: (action || "blackhole") as RouteActionKind, via: "" };
}

function ensureAction(prefix: string): string {
  routeActions[prefix] ??= draft.action ?? "blackhole";
  return routeActions[prefix]!;
}

function ensureFilter(prefix: string): StaticRouteFilter {
  routeFilters[prefix] ??= emptyFilter();
  return routeFilters[prefix]!;
}

function syncRoutes(): void {
  if (draft.defineId && !draft.action) draft.action = "blackhole";
  if (!draft.defineId) draft.action = null;
  const entries = routeEntries.value;
  for (const prefix of entries) {
    ensureAction(prefix);
    ensureFilter(prefix);
  }
  selectedPrefix.value = selectedPrefix.value && entries.includes(selectedPrefix.value) ? selectedPrefix.value : (entries[0] ?? null);
}

function syncName(): void {
  if (editing.value || nameEdited.value || !draft.label || !inventory.value) return;
  draft.name = uniqueBirdName(inventory.value, draft.family === "ipv6" ? "birdbox_static6" : "birdbox_static4", draft.label);
}

function changeFamily(): void {
  if (!compatibleDefines.value.some((resource) => resource.id === draft.defineId)) draft.defineId = null;
  if (!editing.value && !nameEdited.value) syncName();
  syncRoutes();
}

function defaultOperation(type: OperationKind): StaticRouteFilterOperation {
  if (type === "community") return { type, list: "standard", operation: "add", value: [65000, 100] };
  if (type === "prepend") return { type, asn: 65000, count: 1 };
  return { type: "set", attribute: "preference", value: 100 };
}

function operationSummary(filter: StaticRouteFilter): string {
  return `${filter.operations.length ? `${filter.operations.length} 项` : "无快捷操作"}${filter.custom ? " · 自定义" : ""}`;
}

function setSelectedAction(action: RouteActionKind, via: string): void {
  if (!selectedPrefix.value) return;
  routeActions[selectedPrefix.value] = action === "via" ? `via ${via}` : action;
}

function addOperation(): void {
  const filter = selectedFilter.value;
  if (!filter) return;
  if (filter.operations.length >= 32) {
    dispatchToast("每条 CIDR 最多 32 项快捷操作", "error");
    return;
  }
  filter.operations.push(defaultOperation(addOperationType.value));
}

function updateOperation(index: number, operation: StaticRouteFilterOperation): void {
  const filter = selectedFilter.value;
  if (filter) filter.operations[index] = operation;
}

function removeOperation(index: number): void {
  selectedFilter.value?.operations.splice(index, 1);
}

function moveOperation(index: number, direction: "up" | "down"): void {
  const operations = selectedFilter.value?.operations;
  if (!operations) return;
  const target = index + (direction === "up" ? -1 : 1);
  if (target < 0 || target >= operations.length) return;
  const current = operations[index];
  const other = operations[target];
  if (!current || !other) return;
  operations[index] = other;
  operations[target] = current;
}

function applyOperationToAll(index: number): void {
  const source = selectedFilter.value?.operations[index];
  if (!source || !selectedPrefix.value) return;
  const targets = routeEntries.value.filter((prefix) => prefix !== selectedPrefix.value);
  if (!targets.length) {
    dispatchToast("当前 Define 只有一个可编辑 CIDR", "error");
    return;
  }
  if (!window.confirm(`将第 ${index + 1} 项快捷操作追加到其余 ${targets.length} 条 CIDR，继续吗？`)) return;
  const full = targets.find((prefix) => ensureFilter(prefix).operations.length >= 32);
  if (full) {
    dispatchToast(`${full} 已达到 32 项上限`, "error");
    return;
  }
  for (const prefix of targets) ensureFilter(prefix).operations.push(cloneOperation(source));
}

function applyBulkAction(): void {
  if (!draft.defineId) return;
  if (bulkAction.value === "via" && !bulkVia.value.trim()) {
    const input = form.value?.querySelector<HTMLInputElement>("#staticBulkVia");
    if (form.value && input) markFieldInvalid(form.value, input);
    dispatchToast("请输入统一使用的 via 地址", "error");
    return;
  }
  if (!window.confirm(`将统一修改 ${routeEntries.value.length} 条 CIDR 的转发动作，继续吗？`)) return;
  const action = bulkAction.value === "via" ? `via ${bulkVia.value.trim()}` : bulkAction.value;
  draft.action = action;
  for (const prefix of routeEntries.value) routeActions[prefix] = action;
}

function copyBlockToAll(): void {
  if (!selectedPrefix.value || !window.confirm(`将当前 per-route 块复制到 ${routeEntries.value.length} 条 CIDR，继续吗？`)) return;
  const source = cloneFilter(ensureFilter(selectedPrefix.value));
  for (const prefix of routeEntries.value) routeFilters[prefix] = cloneFilter(source);
}

function clearBlocks(): void {
  if (!window.confirm(`将清空 ${routeEntries.value.length} 条 CIDR 的快捷操作和自定义块，继续吗？`)) return;
  for (const prefix of routeEntries.value) routeFilters[prefix] = emptyFilter();
}

function insertReference(item: ReferenceItem): void {
  const textarea = customEditor.value;
  const filter = selectedFilter.value;
  if (!textarea || !filter) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.setRangeText(item.insertion, start, end, "end");
  filter.custom = textarea.value;
  textarea.focus();
}

function open(resource: StaticProtocol | null): void {
  const selectedNodeId = resource?.nodeId ?? dashboard.value?.node?.id ?? nodes.value[0]?.id ?? "";
  if (!selectedNodeId) {
    dispatchToast("请先添加受管节点", "error");
    return;
  }
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
  });
  clearRecord(routeActions);
  clearRecord(routeFilters);
  Object.assign(routeActions, structuredClone(toRaw(resource?.routeActions ?? {})));
  for (const [prefix, filter] of Object.entries(resource?.routeFilters ?? {})) routeFilters[prefix] = cloneFilter(filter);
  const defaultAction = resource?.action ?? Object.values(resource?.routeActions ?? {})[0] ?? (resource?.defineId ? "blackhole" : "");
  const parts = actionParts(defaultAction);
  bulkAction.value = parts.action;
  bulkVia.value = parts.via;
  selectedPrefix.value = null;
  referenceSearch.value = "";
  nameEdited.value = Boolean(resource);
  syncRoutes();
  if (form.value) clearFormValidation(form.value);
  if (!dialog.value?.open) dialog.value?.showModal();
  dialog.value?.scrollTo({ top: 0 });
  void nextTick(() => document.querySelector<HTMLInputElement>("#staticLabel")?.focus({ preventScroll: true }));
}

function close(): void {
  if (!pending.value) dialog.value?.close();
}

function payload(): StaticMutationRequest {
  const entries = routeEntries.value;
  const action = draft.defineId ? (draft.action ?? ensureAction(entries[0] ?? "")) : null;
  return {
    nodeId: draft.nodeId,
    label: draft.label,
    name: draft.name,
    family: draft.family,
    defineId: draft.defineId,
    action,
    routeActions: draft.defineId ? Object.fromEntries(entries.map((prefix) => [prefix, ensureAction(prefix)])) : {},
    routeFilters: draft.defineId ? Object.fromEntries(entries.map((prefix) => [prefix, cloneFilter(ensureFilter(prefix))])) : {},
    import: draft.import,
    export: draft.export,
    raw: draft.raw,
    enabled: draft.enabled,
  };
}

async function save(): Promise<void> {
  if (!form.value) return;
  const defineInput = form.value.querySelector<HTMLSelectElement>("#staticDefineId");
  const rawInput = form.value.querySelector<HTMLTextAreaElement>("#staticRaw");
  defineInput?.setCustomValidity(draft.defineId && !routeEntries.value.length && !draft.raw.trim() ? "所选 CIDR Define 没有可用于 Static 的完整 CIDR 条目" : "");
  rawInput?.setCustomValidity(!draft.defineId && !draft.raw.trim() ? "请配置标准路由或填写自定义 Static 指令" : "");
  if (!validateForm(form.value)) return;
  pending.value = true;
  const id = editingId.value;
  try {
    const result = await api<ResourceMutationResponse<StaticProtocol>>(id ? `/api/statics/${encodeURIComponent(id)}` : "/api/statics", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload()),
    });
    const peerId = dashboard.value?.node?.id === draft.nodeId ? dashboard.value.selectedPeer?.id ?? null : null;
    await loadDashboard(draft.nodeId, peerId);
    window.dispatchEvent(new CustomEvent("birdbox:resource-tab-select", { detail: { target: "statics" } }));
    dialog.value?.close();
    dispatchToast(`Static 已${id ? "更新" : "添加"}，${deploymentSummary(result.deployment)}`, "success");
  } catch (error) {
    const prefixMatch = error instanceof Error ? /Static CIDR (\S+)/.exec(error.message) : null;
    if (prefixMatch?.[1] && routeEntries.value.includes(prefixMatch[1])) selectedPrefix.value = prefixMatch[1];
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
    await loadDashboard(resource.nodeId, dashboard.value?.node?.id === resource.nodeId ? dashboard.value.selectedPeer?.id ?? null : null);
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
  window.removeEventListener("birdbox:resource-create", handleCreate);
  window.removeEventListener("birdbox:resource-edit", handleEdit);
});
</script>

<template>
  <dialog id="staticDialog" ref="dialog" class="editor-dialog static-editor-dialog" aria-labelledby="staticDialogTitle" @cancel.prevent="close">
    <form id="staticForm" ref="form" novalidate :aria-busy="pending" @submit.prevent="save">
      <div class="dialog-head"><span class="dialog-icon">S</span><div><p class="eyebrow">BIRD Static</p><h2 id="staticDialogTitle">{{ editing ? "编辑 Static 资源" : "添加 Static 资源" }}</h2></div></div>
      <div class="dialog-grid">
        <div class="field full-width"><label for="staticNodeId">所属节点</label><select id="staticNodeId" v-model="draft.nodeId" required :disabled="editing"><option v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></div>
        <div class="field"><label for="staticLabel">显示名称</label><input id="staticLabel" v-model.trim="draft.label" maxlength="80" required @input="syncName"></div>
        <div class="field"><label for="staticName">BIRD 名称（自动，可编辑）</label><input id="staticName" v-model.trim="draft.name" pattern="[A-Za-z_][A-Za-z0-9_]*" maxlength="64" required @input="nameEdited = true"></div>
        <div class="field"><label for="staticFamily">地址族</label><select id="staticFamily" v-model="draft.family" @change="changeFamily"><option value="ipv4">IPv4</option><option value="ipv6">IPv6</option></select></div>
        <div class="field"><label for="staticDefineId">CIDR Define</label><select id="staticDefineId" v-model="draft.defineId"><option :value="null">不创建标准路由</option><option v-for="resource in compatibleDefines" :key="resource.id" :value="resource.id">{{ resource.label }} · {{ resource.name }} · {{ resourceScopeShortLabel(resource, draft.nodeId) }}</option></select></div>
        <div class="field"><label for="staticImport">Static Import</label><select id="staticImport" v-model="draft.import"><option value="all">all</option><option value="none">none</option></select></div>
        <div class="field"><label for="staticExport">Static Export</label><select id="staticExport" v-model="draft.export"><option value="none">none</option><option value="all">all</option></select></div>
        <section v-if="draft.defineId" id="staticRouteActionsSection" class="static-route-editor full-width" aria-labelledby="staticRouteActionsTitle">
          <div class="static-route-editor-head"><div><h3 id="staticRouteActionsTitle">CIDR 条目与 per-route 块</h3><small id="staticRouteActionSummary">{{ routeEntries.length ? `已筛选 ${routeEntries.length} 条完整 CIDR` : "该 Define 没有完整 CIDR 条目" }}</small></div></div>
          <div class="static-route-bulk">
            <div class="field"><label for="staticBulkAction">统一设置动作</label><select id="staticBulkAction" v-model="bulkAction"><option value="blackhole">blackhole</option><option value="reject">reject</option><option value="unreachable">unreachable</option><option value="prohibit">prohibit</option><option value="via">via</option></select></div>
            <div v-if="bulkAction === 'via'" id="staticBulkViaField" class="field"><label for="staticBulkVia">via 地址</label><input id="staticBulkVia" v-model.trim="bulkVia" :placeholder="draft.family === 'ipv6' ? '2001:db8::1' : '198.51.100.1'" required></div>
            <button id="applyStaticBulkActionButton" class="secondary-button" type="button" @click="applyBulkAction">统一转发动作</button>
            <button id="copyStaticRouteBlockButton" class="secondary-button" type="button" :disabled="!selectedPrefix" @click="copyBlockToAll">复制当前块到全部</button>
            <button id="clearStaticRouteBlocksButton" class="text-danger-button" type="button" @click="clearBlocks">清空全部块</button>
          </div>
          <div class="static-route-workspace">
            <div id="staticRouteActionList" class="static-route-action-list" role="listbox" aria-label="Static CIDR 条目">
              <button v-for="prefix in routeEntries" :key="prefix" class="static-route-row" :class="{ active: prefix === selectedPrefix }" type="button" role="option" :aria-selected="prefix === selectedPrefix" :data-static-route-prefix="prefix" @click="selectedPrefix = prefix"><code class="static-route-prefix">{{ prefix }}</code><small>{{ ensureAction(prefix) }}</small><span>{{ operationSummary(ensureFilter(prefix)) }}</span></button>
              <p v-if="!routeEntries.length" class="static-route-empty">没有可编辑的完整 CIDR 条目</p>
            </div>
            <div v-if="selectedPrefix && selectedFilter" id="staticRouteDetail" class="static-route-detail">
              <div class="static-route-detail-head"><div><span>当前 CIDR</span><code id="staticRouteDetailPrefix">{{ selectedPrefix }}</code></div><span id="staticRouteDetailStatus">{{ operationSummary(selectedFilter) }}</span></div>
              <div class="static-route-action-fields">
                <div class="field"><label for="staticRouteAction">转发动作</label><select id="staticRouteAction" :value="selectedAction.action" @change="setSelectedAction(($event.target as HTMLSelectElement).value as RouteActionKind, selectedAction.via)"><option value="blackhole">blackhole</option><option value="reject">reject</option><option value="unreachable">unreachable</option><option value="prohibit">prohibit</option><option value="via">via</option></select></div>
                <div v-if="selectedAction.action === 'via'" id="staticRouteViaField" class="field"><label for="staticRouteVia">via 地址</label><input id="staticRouteVia" :value="selectedAction.via" :placeholder="draft.family === 'ipv6' ? '2001:db8::1' : '198.51.100.1'" required @input="setSelectedAction('via', ($event.target as HTMLInputElement).value)"></div>
              </div>
              <section class="static-filter-operations" aria-labelledby="staticFilterOperationsTitle">
                <div class="static-filter-section-head"><div><span>快捷操作</span><strong id="staticFilterOperationsTitle">{{ operationSummary(selectedFilter) }} · 按列表顺序执行</strong></div><div class="static-filter-add-controls"><select v-model="addOperationType" aria-label="快捷操作类型"><option value="set">设置属性</option><option value="community">Community</option><option value="prepend">AS prepend</option></select><button class="secondary-button" type="button" @click="addOperation">添加</button></div></div>
                <div id="staticFilterOperationList" class="static-filter-operation-list"><StaticRouteOperationRow v-for="(operation, index) in selectedFilter.operations" :key="`${selectedPrefix}-${index}-${operation.type}`" :operation="operation" :index="index" :total="selectedFilter.operations.length" @update="updateOperation(index, $event)" @remove="removeOperation(index)" @move="moveOperation(index, $event)" @apply-all="applyOperationToAll(index)" /><p v-if="!selectedFilter.operations.length" class="static-filter-empty">暂无快捷操作</p></div>
              </section>
              <div class="field static-route-custom-field"><label for="staticRouteCustom">自定义 per-route 源码</label><textarea id="staticRouteCustom" ref="customEditor" v-model="selectedFilter.custom" class="compact-code-editor" maxlength="8192" spellcheck="false" placeholder="if net.len = 24 then bgp_med = 50;"></textarea></div>
              <section class="static-code-references" aria-labelledby="staticReferenceTitle"><div class="code-reference-toolbar"><div class="code-reference-heading"><strong id="staticReferenceTitle">可用资源</strong><span id="staticReferenceCount">{{ references.length }} 项</span></div><input id="staticReferenceSearch" v-model.trim="referenceSearch" type="search" placeholder="搜索 Define / Function"></div><div id="staticReferences" class="code-reference-groups"><section v-if="references.length" class="code-reference-group"><div class="code-reference-list"><button v-for="item in references" :key="item.id" class="code-reference-button" type="button" @click="insertReference(item)"><span class="code-reference-copy"><strong>{{ item.label }}</strong><code>{{ item.symbol }}</code></span><span class="code-reference-meta"><span>{{ item.kind }}</span><span>{{ resourceScopeShortLabel(item, draft.nodeId) }}</span></span></button></div></section><span v-else class="code-reference-empty">没有匹配的资源</span></div></section>
              <div class="static-route-preview"><span>最终 BIRD 路由</span><pre id="staticRoutePreview">{{ preview }}</pre></div>
            </div>
          </div>
        </section>
        <div class="field full-width"><label for="staticRaw">自定义 Static 指令</label><textarea id="staticRaw" v-model="draft.raw" class="compact-code-editor" spellcheck="false" placeholder="route 192.0.2.0/24 via 198.51.100.1;"></textarea></div>
        <label class="toggle-row full-width" for="staticEnabled"><span><strong>启用资源</strong></span><input id="staticEnabled" v-model="draft.enabled" type="checkbox"><i aria-hidden="true"></i></label>
      </div>
      <div class="dialog-actions split-actions"><button v-if="editing" id="deleteStaticButton" class="text-danger-button" type="button" :disabled="pending" @click="remove">删除 Static</button><span></span><button class="secondary-button" type="button" data-close="staticDialog" :disabled="pending" @click="close">取消</button><button id="saveStaticButton" class="primary-button" type="submit" :disabled="pending">{{ pending ? "正在预检" : "预检、保存并应用" }}</button></div>
    </form>
  </dialog>
</template>
