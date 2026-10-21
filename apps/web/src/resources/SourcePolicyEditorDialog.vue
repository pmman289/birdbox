<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import type { SourcePolicyEditorContext, SourcePolicyPreviewResponse, SourcePolicyManualPlan, SourcePolicyMutationResponse } from "@birdbox/contracts/api";
import type { PolicyDefine, SourcePolicyEgress } from "@birdbox/contracts/inventory";

import { useDashboardStore, loadDashboard } from "../dashboard/dashboard-store";
import MultiNodeScopeField from "../shared/MultiNodeScopeField.vue";
import { api, ApiError } from "../shared/api-client";
import { copyText } from "../shared/copy-text";
import { dispatchToast } from "../shared/events";
import { clearFormValidation, presentFormError, validateForm } from "../shared/form-validation";
import { resourceScopeCompactLabel } from "../shared/resource-scope";

interface DraftGroup {
  id: string;
  egressAddress: string;
  kernelTable: number | null;
  sources: string[];
}

interface Draft {
  nodeIds: string[] | null;
  label: string;
  groups: DraftGroup[];
  copyInternalRoutes: boolean;
  internalDefineIds: string[];
  enabled: boolean;
}

const dialog = ref<HTMLDialogElement | null>(null);
const form = ref<HTMLFormElement | null>(null);
const editingId = ref<string | null>(null);
const pending = ref(false);
const deleted = ref(false);
const scopeError = ref(false);
const importText = ref("");
const importOpen = ref(false);
const plans = ref<SourcePolicyManualPlan[]>([]);
const selectedPlanIndex = ref(0);
const previewPending = ref(false);
const previewError = ref("");
const reviewed = ref<SourcePolicyPreviewResponse | null>(null);
const inventoryRevision = ref<number | null>(null), contextReady = ref(false), contextPending = ref(false);
const conflict = ref(false), comparison = ref<SourcePolicyEditorContext | null>(null);
const initialResource = ref<SourcePolicyEgress | null>(null), savedSignature = ref("");
let editorGeneration = 0;
const { dashboard } = useDashboardStore();
let previewTimer: number | null = null;
let previewGeneration = 0;
let previewController: AbortController | null = null;

const draft = reactive<Draft>({
  nodeIds: null,
  label: "",
  groups: [],
  copyInternalRoutes: true,
  internalDefineIds: [],
  enabled: true,
});
const draftSignature = computed(() => JSON.stringify(draft));
const dirty = computed(() => !deleted.value && draftSignature.value !== savedSignature.value);
const affectedNodeIds = computed(() => [...new Set([...(initialResource.value ? initialResource.value.nodeIds ?? nodes.value.map(n => n.id) : []), ...(draft.nodeIds ?? nodes.value.map(n => n.id))])]);

async function loadContext(compare = false): Promise<void> {
  const request = ++editorGeneration;
  contextPending.value = true; previewError.value = "";
  try {
    const result = await api<SourcePolicyEditorContext>(`/api/source-policies/editor-context${editingId.value ? `?id=${encodeURIComponent(editingId.value)}` : ""}`);
    if (request !== editorGeneration || !dialog.value?.open) return;
    if (compare || JSON.stringify(result.resource) !== JSON.stringify(initialResource.value)) {
      invalidatePreview(); comparison.value = result; conflict.value = true;
      previewError.value = "服务端配置已变化。请对比后采用最新配置，或保留草稿重新预检。";
    } else { inventoryRevision.value = result.inventoryRevision; contextReady.value = true; }
  } catch (error) { if (request === editorGeneration) previewError.value = error instanceof Error ? error.message : "读取版本失败"; }
  finally { if (request === editorGeneration) contextPending.value = false; }
}
function keepDraft(): void {
  if (!comparison.value) return;
  if (editingId.value && !comparison.value.resource) { editingId.value = null; savedSignature.value = ""; }
  else if (comparison.value.resource) savedSignature.value = JSON.stringify(draftFromResource(comparison.value.resource));
  initialResource.value = comparison.value.resource; inventoryRevision.value = comparison.value.inventoryRevision;
  comparison.value = null; conflict.value = false; contextReady.value = true; previewError.value = ""; invalidatePreview();
  void refreshPreview();
}
function adoptRemote(): void { if (comparison.value?.resource) open(comparison.value.resource); }

const editing = computed(() => editingId.value !== null && !deleted.value);
const inventory = computed(() => dashboard.value?.inventory ?? null);
const nodes = computed(() => {
  const all = inventory.value?.nodes ?? [];
  // New mappings are Agent-only; retain SSH nodes while editing legacy mappings
  // so their scope can be reviewed and upgraded without losing compatibility.
  if (editingId.value !== null) return all;
  return all.filter((node) => node.transport !== "ssh");
});
const nodeNames = computed(() => new Map(nodes.value.map((node) => [node.id, node.name])));
const defines = computed(() => (inventory.value?.defines ?? []).filter((item) => item.type === "cidr4" && item.enabled));
const selectedPlan = computed(() => plans.value[selectedPlanIndex.value] ?? plans.value[0] ?? null);

function defineEntries(define: PolicyDefine): string {
  return define.type === "expression" ? "" : define.entries.join(", ");
}

const fieldMappings = [
  [/至少选择一个|可用范围|不存在的节点/, "sourcePolicyNodeScope"],
  [/源地址出口映射名称/, "sourcePolicyLabel"],
  [/出口组|出口地址/, "sourcePolicyGroup"],
  [/内核路由表|table ID|保留内核路由表/, "sourcePolicyGroup"],
  [/源地址|源 CIDR/, "sourcePolicyGroup"],
  [/内部路由 Define/, "sourcePolicyInternalDefines"],
] as const;

function emptyGroup(): DraftGroup {
  return { id: "", egressAddress: "", kernelTable: null, sources: [""] };
}

function invalidatePreview(): void {
  previewGeneration += 1;
  previewController?.abort();
  previewController = null;
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  previewTimer = null;
  previewPending.value = false;
  reviewed.value = null;
}

function draftFromResource(resource: SourcePolicyEgress | null): Draft {
  return {
    nodeIds: resource?.nodeIds === null
      ? null
      : resource?.nodeIds
        ? [...resource.nodeIds]
        : (nodes.value.length ? nodes.value.map((node) => node.id) : []),
    label: resource?.label ?? "",
    groups: resource?.groups.map((group) => ({ id: group.id, egressAddress: group.egressAddress, kernelTable: group.kernelTable, sources: [...group.sources] })) ?? [emptyGroup()],
    copyInternalRoutes: resource?.copyInternalRoutes ?? true,
    internalDefineIds: resource?.internalDefineIds ? [...resource.internalDefineIds] : [],
    enabled: resource?.enabled ?? true,
  };
}

function setDraft(resource: SourcePolicyEgress | null): void {
  editingId.value = resource?.id ?? null;
  Object.assign(draft, draftFromResource(resource));
}

function open(resource: SourcePolicyEgress | null): void {
  if (pending.value) return;
  invalidatePreview();
  editorGeneration++; contextReady.value = false; conflict.value = false; comparison.value = null;
  initialResource.value = resource ? JSON.parse(JSON.stringify(resource)) as SourcePolicyEgress : null;
  deleted.value = false;
  scopeError.value = false;
  plans.value = [];
  selectedPlanIndex.value = 0;
  previewError.value = "";
  setDraft(resource);
  savedSignature.value = draftSignature.value;
  importText.value = "";
  importOpen.value = false;
  if (form.value) clearFormValidation(form.value);
  if (!dialog.value?.open) dialog.value?.showModal();
  void nextTick(() => {
    const content = dialog.value?.querySelector<HTMLElement>(".source-policy-content"); if (content) content.scrollTop = 0;
    document.querySelector<HTMLInputElement>("#sourcePolicyLabel")?.focus({ preventScroll: true });
  });
  const loaded = loadContext(), generation = editorGeneration;
  void loaded.then(() => { if (generation === editorGeneration && contextReady.value && dialog.value?.open) void refreshPreview(); });
}


function close(): void {
  if (pending.value) return;
  if (dirty.value && !window.confirm("放弃尚未保存的源地址出口映射修改？")) return;
  editorGeneration++;
  invalidatePreview();
  dialog.value?.close();
}
function openRuntime(): void {
  if (editingId.value && !pending.value) window.dispatchEvent(new CustomEvent("birdbox:source-policy-runtime-open", { detail: { id: editingId.value } }));
}

function addGroup(): void {
  draft.groups.push(emptyGroup());
}

function removeGroup(index: number): void {
  if (draft.groups.length <= 1) {
    dispatchToast("至少保留一个出口组", "error");
    return;
  }
  draft.groups.splice(index, 1);
}

function addSource(group: DraftGroup): void {
  group.sources.push("");
}

function setKernelTable(group: DraftGroup, event: Event): void {
  const value = (event.target as HTMLInputElement).value.trim();
  group.kernelTable = value === "" ? null : Number(value);
}

function removeSource(group: DraftGroup, index: number): void {
  if (group.sources.length <= 1) {
    group.sources[0] = "";
    return;
  }
  group.sources.splice(index, 1);
}

function parseImport(): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(importText.value);
  } catch {
    dispatchToast("批量映射必须是合法 JSON 对象", "error");
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    dispatchToast("批量映射必须是“出口地址 -> 源 CIDR 数组”的对象", "error");
    return;
  }
  const imported: DraftGroup[] = [];
  for (const [egressAddress, sources] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(sources)) {
      dispatchToast(`${egressAddress} 的源地址必须是数组`, "error");
      return;
    }
    imported.push({
      id: draft.groups.find((group) => group.egressAddress === egressAddress)?.id ?? "",
      egressAddress,
      kernelTable: draft.groups.find((group) => group.egressAddress === egressAddress)?.kernelTable ?? null,
      sources: sources.map((source) => String(source)),
    });
  }
  if (!imported.length) {
    dispatchToast("批量映射不能为空", "error");
    return;
  }
  draft.groups = imported;
  importOpen.value = false;
  dispatchToast(`已导入 ${imported.length} 个出口组`, "success");
}

function payload(): Record<string, unknown> {
  return {
    nodeIds: draft.nodeIds,
    label: draft.label,
    groups: draft.groups.map((group) => ({
      id: group.id || undefined,
      egressAddress: group.egressAddress,
      kernelTable: group.kernelTable === null ? undefined : group.kernelTable,
      sources: group.sources.map((source) => source.trim()).filter(Boolean),
    })),
    copyInternalRoutes: draft.copyInternalRoutes,
    internalDefineIds: draft.copyInternalRoutes ? draft.internalDefineIds : [],
    enabled: draft.enabled,
  };
}

function previewReady(): boolean {
  return Boolean(
    draft.label.trim()
    && draft.groups.length
    && draft.groups.every((group) => group.egressAddress.trim() && group.sources.some((source) => source.trim())),
  );
}

async function refreshPreview(preflight = false): Promise<void> {
  if (pending.value) return;
  if (!contextReady.value || conflict.value) return;
  if (preflight && (!form.value || !validateForm(form.value))) return;
  scopeError.value = draft.nodeIds !== null && draft.nodeIds.length === 0;
  if (scopeError.value) { previewError.value = "请至少选择一个下发节点"; return; }
  invalidatePreview();
  const generation = previewGeneration;
  if (!dialog.value?.open || deleted.value || !previewReady()) {
    plans.value = [];
    previewError.value = previewReady() ? "" : "填写映射名称、出口地址和至少一条源 CIDR 后生成预览。";
    previewPending.value = false;
    return;
  }
  previewPending.value = true;
  previewError.value = "";
  const controller = new AbortController();
  previewController = controller;
  try {
    const response = await api<SourcePolicyPreviewResponse>("/api/source-policies/preview", {
      method: "POST",
      mutationWait: false,
      signal: controller.signal,
      timeoutMs: 120_000,
      body: JSON.stringify({ ...payload(), ...(preflight ? {} : { mode: "plan" }), inventoryRevision: inventoryRevision.value, id: editingId.value ?? undefined }),
    });
    if (generation === previewGeneration) {
      plans.value = response.manualPlans;
      selectedPlanIndex.value = 0;
      if (preflight) {
        reviewed.value = response;
        await nextTick();
        const content = dialog.value?.querySelector<HTMLElement>(".source-policy-content"), panel = dialog.value?.querySelector<HTMLElement>("#sourcePolicyPreflight");
        if (content && panel) content.scrollTop += panel.getBoundingClientRect().top - content.getBoundingClientRect().top;
      }
    }
  } catch (error) {
    if (generation === previewGeneration) {
      plans.value = [];
      previewError.value = error instanceof Error ? error.message : "无法生成草稿预览";
      if (error instanceof ApiError && error.code === "STATE_CONFLICT") conflict.value = true;
      if (preflight) {
        presentFormError(form.value!, error, fieldMappings);
        await nextTick();
        const content = dialog.value?.querySelector<HTMLElement>(".source-policy-content"); if (content) content.scrollTop = 0;
      }
    }
  } finally {
    if (generation === previewGeneration) {
      previewPending.value = false;
      previewController = null;
    }
  }
}

watch(draft, () => {
  if (!dialog.value?.open || deleted.value || pending.value) return;
  invalidatePreview();
  plans.value = [];
  previewError.value = "";
  previewTimer = window.setTimeout(() => {
    previewTimer = null;
    void refreshPreview();
  }, 180);
}, { deep: true, flush: "sync" });

async function save(): Promise<void> {
  if (pending.value || previewPending.value || deleted.value || !contextReady.value || conflict.value) return;
  if (!reviewed.value?.valid) { await refreshPreview(true); return; }
  if (!window.confirm(`确认将当前映射应用到 ${reviewed.value.configs?.length ?? 0} 个节点？BIRD 配置与 Agent 系统规则将一起更新。`)) return;
  scopeError.value = draft.nodeIds !== null && draft.nodeIds.length === 0;
  if (scopeError.value) {
    document.querySelector<HTMLElement>("#sourcePolicyNodeScope")?.focus();
    dispatchToast("请至少选择一个下发节点", "error");
    return;
  }
  if (!form.value || !validateForm(form.value)) return;
  const candidate = reviewed.value;
  pending.value = true;
  invalidatePreview();
  previewError.value = "";
  const id = editingId.value;
  try {
    const result = await api<SourcePolicyMutationResponse>(id ? `/api/source-policies/${encodeURIComponent(id)}` : "/api/source-policies", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify({ ...candidate.resource, mode: "apply", previewId: candidate.previewId, candidateHash: candidate.candidateHash, inventoryRevision: candidate.inventoryRevision }),
    });
    setDraft(result.resource);
    initialResource.value = structuredClone(result.resource); savedSignature.value = draftSignature.value;
    inventoryRevision.value = result.inventoryRevision ?? null;
    plans.value = result.manualPlans;
    selectedPlanIndex.value = 0;
    await loadDashboard(draft.nodeIds?.[0] ?? dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null).catch(() => dispatchToast("操作已成功，请刷新资源列表", "error"));
    window.dispatchEvent(new CustomEvent("birdbox:resource-tab-select", { detail: { target: "sourcePolicies" } }));
    const manual = result.manualPlans.some((plan) => plan.management !== "agent");
    dispatchToast(`${id ? "源地址出口映射已更新" : "源地址出口映射已添加"}；BIRD 与 Agent 系统规则已处理${manual ? "，部分节点仍需按计划执行系统规则" : ""}`, manual ? "" : "success");
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : "应用失败，草稿已保留";
    if (error instanceof ApiError && error.code === "STATE_CONFLICT") conflict.value = true;
    presentFormError(form.value, error, fieldMappings);
    await nextTick(); const content = dialog.value?.querySelector<HTMLElement>(".source-policy-content"); if (content) content.scrollTop = 0;
  } finally {
    pending.value = false;
  }
}

async function remove(): Promise<void> {
  if (pending.value || !contextReady.value || conflict.value) return;
  const resource = editingId.value ? inventory.value?.sourcePolicies.find((item) => item.id === editingId.value) : null;
  if (!resource || !window.confirm(`删除源地址出口映射“${resource.label}”？将同时下发系统规则清理。`)) return;
  pending.value = true;
  invalidatePreview();
  previewError.value = "";
  try {
    const result = await api<{ manualPlans: SourcePolicyManualPlan[] }>(`/api/source-policies/${encodeURIComponent(resource.id)}`, { method: "DELETE", body: JSON.stringify({ inventoryRevision: inventoryRevision.value }) });
    plans.value = result.manualPlans;
    selectedPlanIndex.value = 0;
    deleted.value = true;
    await loadDashboard(dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null).catch(() => dispatchToast("操作已成功，请刷新资源列表", "error"));
    const manual = result.manualPlans.some((plan) => plan.management !== "agent");
    dispatchToast(`映射集已删除，Agent 系统规则已处理${manual ? "，部分节点仍需按计划手工清理" : ""}`, manual ? "" : "success");
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : "删除失败，草稿已保留";
    if (error instanceof ApiError && error.code === "STATE_CONFLICT") conflict.value = true;
    presentFormError(form.value!, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

async function copyPlanText(value: string | null, successMessage: string): Promise<void> {
  if (!value) return;
  try {
    await copyText(value);
    dispatchToast(successMessage, "success");
  } catch {
    dispatchToast("浏览器不允许访问剪切板，请手动选择脚本复制", "error");
  }
}

async function copyScript(): Promise<void> {
  await copyPlanText(selectedPlan.value?.applyScript ?? selectedPlan.value?.cleanupScript ?? null, "脚本已复制");
}

async function copySystemdUnit(): Promise<void> {
  await copyPlanText(selectedPlan.value?.systemdUnit ?? null, "systemd unit 已复制");
}

async function copySystemdInstallScript(): Promise<void> {
  await copyPlanText(selectedPlan.value?.systemdInstallScript ?? null, "systemd 安装脚本已复制");
}

function handleCreate(event: CustomEvent<{ kind: string }>): void {
  if (event.detail.kind === "sourcePolicies" && canSwitch()) open(null);
}

function handleEdit(event: CustomEvent<{ kind: string; id: string }>): void {
  if (event.detail.kind !== "sourcePolicies" || !canSwitch()) return;
  const resource = inventory.value?.sourcePolicies.find((item) => item.id === event.detail.id) ?? null;
  if (resource) open(resource);
}

function canSwitch(): boolean { return !pending.value && !(dialog.value?.open && dirty.value && !window.confirm("放弃尚未保存的源地址出口映射修改并切换资源？")); }
function beforeUnload(event: BeforeUnloadEvent): void { if (dialog.value?.open && dirty.value) { event.preventDefault(); event.returnValue = ""; } }
onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("birdbox:resource-create", handleCreate);
  window.addEventListener("birdbox:resource-edit", handleEdit);
});
onBeforeUnmount(() => {
  editorGeneration++; window.removeEventListener("beforeunload", beforeUnload);
  invalidatePreview();
  window.removeEventListener("birdbox:resource-create", handleCreate);
  window.removeEventListener("birdbox:resource-edit", handleEdit);
});
</script>

<template>
  <dialog id="sourcePolicyDialog" ref="dialog" class="editor-dialog source-policy-editor-dialog" aria-labelledby="sourcePolicyDialogTitle" @cancel.prevent="close">
    <form ref="form" novalidate :aria-busy="pending" :inert="pending" @submit.prevent="save">
      <div class="dialog-head"><span class="dialog-icon">⇢</span><div><p class="eyebrow">SOURCE POLICY EGRESS</p><h2 id="sourcePolicyDialogTitle">{{ deleted ? "系统规则清理" : (editing ? "编辑源地址出口映射" : "新增源地址出口映射") }}</h2><p v-if="!deleted" class="source-policy-heading-status">{{ draft.label || '新映射集' }} · {{ !editing ? '新建草稿' : dirty ? '未保存修改' : '已保存配置' }} · 影响 {{ affectedNodeIds.length }} 个节点</p></div></div>
      <div class="source-policy-content">
      <p v-if="previewError" role="alert" class="protocol-notice protocol-error">{{ previewError }}</p>
      <div v-if="!deleted && (conflict || (!contextReady && !contextPending))" class="source-policy-conflict-actions"><button type="button" class="secondary-button" :disabled="contextPending" @click="loadContext(conflict)">加载最新版本并对比</button></div>
      <section v-if="comparison" class="source-policy-comparison"><h3>版本对比 · 本地草稿仍保留</h3><p v-if="editing && !comparison.resource">此映射集已在服务端删除。保留本地草稿后，可作为新资源重新预检。</p><details><summary>打开时的配置</summary><pre>{{ JSON.stringify(initialResource, null, 2) }}</pre></details><details open><summary>服务端最新配置</summary><pre>{{ comparison.resource ? JSON.stringify(comparison.resource, null, 2) : '此映射集已删除' }}</pre></details><details><summary>我的草稿</summary><pre>{{ JSON.stringify(payload(), null, 2) }}</pre></details><div class="source-policy-conflict-actions"><button v-if="comparison.resource" type="button" class="secondary-button" @click="adoptRemote">采用最新配置</button><button type="button" class="secondary-button" @click="keepDraft">{{ editing && !comparison.resource ? '保留草稿并作为新映射预检' : '保留草稿并重新预检' }}</button></div></section>
      <template v-if="!deleted">
        <section class="source-policy-intro"><p>先选择下发节点，再填写“哪些源地址经哪个出口访问”。出口可以通过动态路由递归到达。</p><p>编辑不会立即下发；先预检完整配置和系统规则，查看差异后确认应用。Linux 路由表可留空自动分配。</p><button v-if="editing" class="secondary-button" type="button" :disabled="pending" @click="openRuntime">查看已保存运行态</button></section>
        <div class="dialog-grid">
          <MultiNodeScopeField id="sourcePolicyNodeScope" v-model="draft.nodeIds" :nodes="nodes" :invalid="scopeError" @change="scopeError = false" />
          <div class="field full-width"><label for="sourcePolicyLabel">映射集名称</label><input id="sourcePolicyLabel" v-model.trim="draft.label" maxlength="80" required placeholder="例如：公网业务出口"></div>
          <section id="sourcePolicyGroup" class="source-policy-groups field full-width" tabindex="-1" aria-labelledby="sourcePolicyGroupsTitle">
            <div class="source-policy-section-head"><div><h3 id="sourcePolicyGroupsTitle">出口组</h3><small>每个出口地址可以绑定多条源 IPv4 CIDR；同一源地址不能同时指向多个出口。</small></div><button class="compact-command" type="button" @click="addGroup">+ 出口组</button></div>
            <div v-for="(group, groupIndex) in draft.groups" :key="group.id || groupIndex" class="source-policy-group">
              <div class="source-policy-group-head">
                <div class="field"><label :for="`sourcePolicyGroup${groupIndex}`">出口地址</label><input :id="`sourcePolicyGroup${groupIndex}`" v-model.trim="group.egressAddress" required pattern="(?:\d{1,3}\.){3}\d{1,3}" placeholder="172.20.177.36"></div>
                <div class="field source-policy-table-field"><label :for="`sourcePolicyKernelTable${groupIndex}`">Linux 路由表</label><input :id="`sourcePolicyKernelTable${groupIndex}`" :value="group.kernelTable ?? ''" type="number" min="1" max="2147483647" inputmode="numeric" placeholder="留空自动分配" @input="setKernelTable(group, $event)"><small>留空自动分配；手工值不得与系统或其它映射冲突。</small></div>
                <button class="text-danger-button" type="button" @click="removeGroup(groupIndex)">删除出口组</button>
              </div>
              <div class="source-policy-source-list"><div class="source-policy-list-label">源 CIDR <span>{{ group.sources.length }} 条</span></div><div v-for="(_source, sourceIndex) in group.sources" :key="`${groupIndex}:${sourceIndex}`" class="source-policy-source-row"><input :id="`sourcePolicySource${groupIndex}_${sourceIndex}`" v-model.trim="group.sources[sourceIndex]" required pattern="(?:\d{1,3}\.){3}\d{1,3}/\d{1,2}" placeholder="162.141.136.139/32"><button class="row-edit-button" type="button" title="删除源 CIDR" aria-label="删除源 CIDR" @click="removeSource(group, sourceIndex)">×</button></div><button class="compact-command" type="button" @click="addSource(group)">+ 添加源 CIDR</button></div>
            </div>
            <div v-if="!draft.groups.length" class="empty-cell">请至少添加一个出口组</div>
            <details class="source-policy-import" :open="importOpen" @toggle="importOpen = ($event.target as HTMLDetailsElement).open"><summary>批量导入 JSON 映射</summary><textarea v-model="importText" rows="6" spellcheck="false" placeholder="{\n  &quot;172.20.177.36&quot;: [&quot;162.141.136.139/32&quot;]\n}"></textarea><button class="secondary-button compact-command" type="button" @click="parseImport">解析并替换出口组</button></details>
          </section>
          <section class="source-policy-internal full-width"><label class="toggle-row" for="sourcePolicyCopyInternal"><span><strong>复制内部路由</strong><small>将选中的 IPv4 CIDR Define 复制到每个策略表，避免内网目的地址走默认出口。</small></span><input id="sourcePolicyCopyInternal" v-model="draft.copyInternalRoutes" type="checkbox"><i aria-hidden="true"></i></label><div v-if="draft.copyInternalRoutes" id="sourcePolicyInternalDefines" class="source-policy-define-list field" tabindex="-1"><label v-for="define in defines" :key="define.id" class="source-policy-define-option"><input v-model="draft.internalDefineIds" type="checkbox" :value="define.id"><span><strong>{{ define.label }}</strong><code>{{ defineEntries(define) }}</code></span><small>{{ define.nodeIds === null ? "所有节点" : resourceScopeCompactLabel(define, nodeNames) }}</small></label><p v-if="!defines.length" class="field-error">没有可用的 IPv4 CIDR Define</p></div></section>
          <label class="toggle-row full-width" for="sourcePolicyEnabled"><span><strong>启用映射集</strong></span><input id="sourcePolicyEnabled" v-model="draft.enabled" type="checkbox"><i aria-hidden="true"></i></label>
        </div>
        <section v-if="reviewed" id="sourcePolicyPreflight" class="protocol-preview" aria-live="polite"><h3>{{ reviewed.valid ? '预检通过 · 请确认变更后应用' : '预检未通过 · 请修正后重试' }}</h3><p>影响 {{ reviewed.configs?.length ?? 0 }} 个节点。表号与规则优先级已绑定到本次候选。</p><details v-for="item in reviewed.configs" :key="item.nodeId" :open="!item.validation.ok"><summary>{{ nodeNames.get(item.nodeId) ?? item.nodeId }} · {{ item.validation.ok ? '通过' : '失败' }}</summary><pre v-if="!item.validation.ok" role="alert">{{ item.validation.stderr || item.validation.stdout }}</pre><pre>{{ item.diff }}</pre><details><summary>完整候选配置（含资源片段）</summary><pre>{{ item.config }}</pre></details></details></section>
        <section class="source-policy-preview full-width" aria-labelledby="sourcePolicyPreviewTitle">
          <div class="source-policy-section-head"><div><h3 id="sourcePolicyPreviewTitle">{{ reviewed ? '已预检的系统规则与配置' : '草稿示意 · 尚未预检' }}</h3><small>Agent 节点的系统规则随应用同步。草稿示意的自动分配结果以正式预检为准。<span v-if="previewPending">正在生成…</span></small></div><select v-if="plans.length > 1" v-model.number="selectedPlanIndex" aria-label="选择节点"><option v-for="(plan, index) in plans" :key="plan.nodeId" :value="index">{{ plan.nodeName }}</option></select></div>
          <div v-if="selectedPlan" class="source-policy-plan">
            <div class="source-policy-plan-status"><strong>{{ selectedPlan.nodeName }}</strong><span>{{ selectedPlan.management === "agent" ? "Agent 自动下发" : selectedPlan.management === "local" ? "本机手工执行系统规则" : "旧 SSH 手工" }}</span><span>{{ selectedPlan.managedRules.length }} 条系统规则</span></div>
            <p v-if="selectedPlan.warning" class="form-error" role="alert">{{ selectedPlan.warning }}</p>
            <div class="source-policy-code-grid">
              <div><div class="source-policy-code-head"><span>BIRD 配置片段</span></div><pre>{{ selectedPlan.birdConfig || "删除后不再生成 BIRD 片段" }}</pre></div>
              <div v-if="selectedPlan.management !== 'agent' && selectedPlan.platform === 'linux'"><div class="source-policy-code-head"><span>Linux root 脚本</span><button class="compact-command" type="button" :disabled="!(selectedPlan.applyScript || selectedPlan.cleanupScript)" @click="copyScript">复制脚本</button></div><pre>{{ selectedPlan.applyScript || selectedPlan.cleanupScript || "无需要执行的规则" }}</pre></div>
              <div v-else-if="selectedPlan.management !== 'agent'" class="source-policy-openwrt">
                <div v-if="selectedPlan.removeRules.length" class="source-policy-code-head"><span>1. 先在 LuCI 删除旧规则</span></div>
                <ol v-if="selectedPlan.removeManagedRules.length"><li v-for="rule in selectedPlan.removeManagedRules" :key="`remove:${rule.kind}:${rule.priority}:${rule.source ?? rule.destination}`"><code>Priority {{ rule.priority }}</code><code v-if="rule.kind === 'gateway'">to {{ rule.destination }}</code><code v-else>from {{ rule.source }}</code><code>lookup {{ rule.table === 254 ? "main" : rule.table }}</code></li></ol>
                <div class="source-policy-code-head"><span>{{ selectedPlan.removeManagedRules.length ? "2. 再添加当前规则" : "OpenWrt LuCI 规则清单" }}</span></div>
                <ol><li v-for="rule in selectedPlan.managedRules" :key="`${rule.kind}:${rule.priority}:${rule.source ?? rule.destination}`"><code>Priority {{ rule.priority }}</code><code v-if="rule.kind === 'gateway'">to {{ rule.destination }}</code><code v-else>from {{ rule.source }}</code><code>lookup {{ rule.table === 254 ? "main" : rule.table }}</code></li></ol>
              </div>
            </div>
            <div v-if="selectedPlan.management !== 'agent' && selectedPlan.platform === 'linux' && selectedPlan.systemdInstallScript" class="source-policy-systemd">
              <div class="source-policy-section-head"><div><h3>systemd 持久化</h3><small>安装脚本会写入 helper 和 unit，执行 daemon-reload、enable，并立即重启服务。</small></div></div>
              <div class="source-policy-code-grid">
                <div v-if="selectedPlan.systemdUnit"><div class="source-policy-code-head"><span>systemd unit</span><button class="compact-command" type="button" @click="copySystemdUnit">复制 unit</button></div><pre>{{ selectedPlan.systemdUnit }}</pre></div>
                <div><div class="source-policy-code-head"><span>{{ selectedPlan.managedRules.length ? "systemd 安装/更新脚本" : "systemd 卸载脚本" }}</span><button class="compact-command" type="button" @click="copySystemdInstallScript">复制脚本</button></div><pre>{{ selectedPlan.systemdInstallScript }}</pre></div>
              </div>
            </div>
            <ul v-if="selectedPlan.management !== 'agent'" class="source-policy-instructions"><li v-for="instruction in selectedPlan.instructions" :key="instruction">{{ instruction }}</li></ul>
          </div>
          <p v-else class="empty-cell">填写映射集后生成各节点的下发预览。</p>
        </section>
      </template>
      <template v-else>
        <section class="source-policy-preview">
          <p class="protocol-help">BIRD 配置已删除。Agent 节点已同步清理系统规则；本机和旧 SSH 节点仍需执行下面的清理计划。</p>
          <select v-if="plans.length > 1" v-model.number="selectedPlanIndex" aria-label="选择清理节点"><option v-for="(plan, index) in plans" :key="plan.nodeId" :value="index">{{ plan.nodeName }}</option></select>
          <div v-if="selectedPlan" class="source-policy-plan">
            <div class="source-policy-plan-status"><strong>{{ selectedPlan.nodeName }}</strong><span>{{ selectedPlan.removeManagedRules.length }} 条待清理规则</span></div>
            <p v-if="selectedPlan.management === 'agent'" class="protocol-help">Agent 已完成规则同步，无需手工执行清理脚本。</p>
            <template v-else-if="selectedPlan.platform === 'linux'">
              <div class="source-policy-code-grid"><div><div class="source-policy-code-head"><span>Linux 清理脚本</span><button class="compact-command" type="button" :disabled="!selectedPlan.cleanupScript" @click="copyScript">复制清理脚本</button></div><pre>{{ selectedPlan.cleanupScript || "无需要清理的规则" }}</pre></div></div>
              <div v-if="selectedPlan.systemdInstallScript" class="source-policy-systemd"><div class="source-policy-section-head"><div><h3>systemd 卸载</h3><small>停止并禁用服务，删除 helper 与 unit 后清理对应规则。</small></div></div><div class="source-policy-code-grid"><div><div class="source-policy-code-head"><span>systemd 卸载脚本</span><button class="compact-command" type="button" @click="copySystemdInstallScript">复制脚本</button></div><pre>{{ selectedPlan.systemdInstallScript }}</pre></div></div></div>
            </template>
            <div v-else class="source-policy-openwrt"><div class="source-policy-code-head"><span>OpenWrt LuCI 待删除规则</span></div><ol><li v-for="rule in selectedPlan.removeManagedRules" :key="`${rule.kind}:${rule.priority}:${rule.source ?? rule.destination}`"><code>Priority {{ rule.priority }}</code><code v-if="rule.kind === 'gateway'">to {{ rule.destination }}</code><code v-else>from {{ rule.source }}</code><code>lookup {{ rule.table === 254 ? "main" : rule.table }}</code></li></ol></div>
          </div>
          <p v-else class="empty-cell">没有待清理规则。</p>
        </section>
      </template>
      </div>
      <div v-if="!deleted" class="dialog-actions split-actions"><button v-if="editing" class="text-danger-button" type="button" :disabled="pending || !contextReady || conflict" @click="remove">删除映射集</button><span class="protocol-save-hint">{{ pending ? '正在预检并应用' : contextPending ? '正在读取版本' : conflict ? '库存已变化，请在上方对比恢复草稿' : previewPending ? '正在生成预览' : reviewed?.valid ? '当前草稿预检通过' : '先预检查看变更，再确认应用' }}</span><button class="secondary-button" type="button" :disabled="pending" @click="close">关闭</button><button v-if="reviewed?.valid" class="secondary-button" type="button" :disabled="pending || previewPending || conflict" @click="refreshPreview(true)">重新预检</button><button class="primary-button" type="submit" :disabled="pending || previewPending || !contextReady || conflict">{{ pending ? '正在应用…' : previewPending ? '预览中…' : reviewed?.valid ? '确认应用' : '预检并查看变更' }}</button></div>
      <div v-else class="dialog-actions"><button class="primary-button" type="button" @click="close">完成</button></div>
    </form>
  </dialog>
</template>

<style scoped>
.source-policy-editor-dialog { padding: 0; max-width: calc(100vw - 24px); max-height: 92dvh; overflow: clip; }
.source-policy-editor-dialog[open] { display: flex; flex-direction: column; }
.source-policy-editor-dialog form { display: flex; flex-direction: column; min-height: 0; width: 100%; overflow: clip; padding: 0; }
.source-policy-editor-dialog .dialog-head { flex-shrink: 0; margin: 0; padding: 20px 24px; border-bottom: 1px solid var(--line); }
.source-policy-heading-status { color: var(--muted); font-size: 11px; margin: 6px 0 0; overflow-wrap: anywhere; }
.source-policy-content { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px 24px; }
.source-policy-intro { padding: 14px; border: 1px solid var(--line); background: var(--surface-soft); border-radius: 6px; margin-bottom: 18px; }
.source-policy-intro p { font-size: 12px; line-height: 1.65; margin: 0 0 8px; }
.source-policy-intro p:last-child { margin-bottom: 0; }
.source-policy-editor-dialog .dialog-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex-shrink: 0; margin: 0; padding: 14px 24px; border-top: 1px solid var(--line); background: var(--surface); }
.protocol-save-hint { flex: 1; min-width: 130px; }
.source-policy-conflict-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.source-policy-comparison details, #sourcePolicyPreflight details { margin: 12px 0; }
.source-policy-content pre { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; overflow: auto; }
.source-policy-editor-dialog .source-policy-group-head { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; }
.source-policy-editor-dialog .source-policy-group-head .field { min-width: 0; }
.source-policy-group-head .text-danger-button { grid-column: auto; }
@media (max-width: 700px) {
 .source-policy-editor-dialog .dialog-head, .source-policy-content { padding: 14px; }
 .source-policy-editor-dialog .dialog-grid, .source-policy-editor-dialog .source-policy-group-head, .source-policy-editor-dialog .source-policy-code-grid { grid-template-columns: minmax(0, 1fr); }
 .source-policy-editor-dialog .source-policy-section-head { flex-wrap: wrap; }
 .source-policy-editor-dialog .source-policy-group-head .text-danger-button { justify-self: start; }
 .source-policy-editor-dialog .dialog-actions { padding: 10px 12px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
 .protocol-save-hint { grid-column: 1 / -1; grid-row: 1; min-width: 0; }
 .dialog-actions .primary-button, .dialog-actions .text-danger-button { grid-column: 1 / -1; }
 .dialog-actions button { min-width: 0; white-space: normal; padding: 9px 6px; }
 .dialog-actions .text-danger-button { justify-self: start; padding: 3px 0; }
}
</style>
