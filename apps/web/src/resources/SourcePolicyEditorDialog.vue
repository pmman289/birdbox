<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import type { SourcePolicyManualPlan, SourcePolicyMutationResponse } from "@birdbox/contracts/api";
import type { PolicyDefine, SourcePolicyEgress } from "@birdbox/contracts/inventory";

import { useDashboardStore, loadDashboard } from "../dashboard/dashboard-store";
import MultiNodeScopeField from "../shared/MultiNodeScopeField.vue";
import { api } from "../shared/api-client";
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
const { dashboard } = useDashboardStore();
let previewTimer: number | null = null;
let previewGeneration = 0;

const draft = reactive<Draft>({
  nodeIds: null,
  label: "",
  groups: [],
  copyInternalRoutes: true,
  internalDefineIds: [],
  enabled: true,
});

const editing = computed(() => editingId.value !== null && !deleted.value);
const inventory = computed(() => dashboard.value?.inventory ?? null);
const nodes = computed(() => inventory.value?.nodes ?? []);
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

function open(resource: SourcePolicyEgress | null): void {
  editingId.value = resource?.id ?? null;
  deleted.value = false;
  scopeError.value = false;
  plans.value = [];
  selectedPlanIndex.value = 0;
  previewPending.value = false;
  previewError.value = "";
  Object.assign(draft, {
    nodeIds: resource?.nodeIds === null || !resource ? null : [...resource.nodeIds],
    label: resource?.label ?? "",
    groups: resource?.groups.map((group) => ({ id: group.id, egressAddress: group.egressAddress, kernelTable: group.kernelTable, sources: [...group.sources] })) ?? [emptyGroup()],
    copyInternalRoutes: resource?.copyInternalRoutes ?? true,
    internalDefineIds: resource?.internalDefineIds ? [...resource.internalDefineIds] : [],
    enabled: resource?.enabled ?? true,
  });
  importText.value = "";
  importOpen.value = false;
  if (form.value) clearFormValidation(form.value);
  dialog.value?.showModal();
  void nextTick(() => {
    document.querySelector<HTMLInputElement>("#sourcePolicyLabel")?.focus();
    void refreshPreview();
  });
}


function close(): void {
  if (pending.value) return;
  previewGeneration += 1;
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  previewTimer = null;
  previewPending.value = false;
  dialog.value?.close();
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

async function refreshPreview(): Promise<void> {
  const generation = ++previewGeneration;
  if (!dialog.value?.open || deleted.value || !previewReady()) {
    plans.value = [];
    previewError.value = previewReady() ? "" : "填写映射名称、出口地址和至少一条源 CIDR 后生成预览。";
    previewPending.value = false;
    return;
  }
  previewPending.value = true;
  previewError.value = "";
  try {
    const response = await api<{ manualPlans: SourcePolicyManualPlan[] }>("/api/source-policies/preview", {
      method: "POST",
      mutationWait: false,
      body: JSON.stringify({ ...payload(), id: editingId.value ?? undefined }),
    });
    if (generation === previewGeneration) {
      plans.value = response.manualPlans;
      selectedPlanIndex.value = 0;
    }
  } catch (error) {
    if (generation === previewGeneration) {
      plans.value = [];
      previewError.value = error instanceof Error ? error.message : "无法生成草稿预览";
    }
  } finally {
    if (generation === previewGeneration) previewPending.value = false;
  }
}

watch(draft, () => {
  if (!dialog.value?.open || deleted.value) return;
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    previewTimer = null;
    void refreshPreview();
  }, 180);
}, { deep: true, flush: "post" });

async function save(): Promise<void> {
  scopeError.value = draft.nodeIds !== null && draft.nodeIds.length === 0;
  if (scopeError.value) {
    document.querySelector<HTMLElement>("#sourcePolicyNodeScope")?.focus();
    dispatchToast("请至少选择一个下发节点", "error");
    return;
  }
  if (!form.value || !validateForm(form.value)) return;
  pending.value = true;
  const id = editingId.value;
  try {
    const result = await api<SourcePolicyMutationResponse>(id ? `/api/source-policies/${encodeURIComponent(id)}` : "/api/source-policies", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload()),
    });
    plans.value = result.manualPlans;
    selectedPlanIndex.value = 0;
    await loadDashboard(draft.nodeIds?.[0] ?? dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null);
    window.dispatchEvent(new CustomEvent("birdbox:resource-tab-select", { detail: { target: "sourcePolicies" } }));
    dispatchToast(`${id ? "源地址出口映射已更新" : "源地址出口映射已添加"}；BIRD 已下发，请完成系统规则手工操作`, "success");
  } catch (error) {
    presentFormError(form.value, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

async function remove(): Promise<void> {
  const resource = editingId.value ? inventory.value?.sourcePolicies.find((item) => item.id === editingId.value) : null;
  if (!resource || !window.confirm(`删除源地址出口映射“${resource.label}”？删除后仍需清理系统规则。`)) return;
  pending.value = true;
  try {
    const result = await api<{ manualPlans: SourcePolicyManualPlan[] }>(`/api/source-policies/${encodeURIComponent(resource.id)}`, { method: "DELETE" });
    plans.value = result.manualPlans;
    selectedPlanIndex.value = 0;
    deleted.value = true;
    await loadDashboard(dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null);
    dispatchToast("映射集已删除，请完成系统规则清理", "success");
  } catch (error) {
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
  if (event.detail.kind === "sourcePolicies") open(null);
}

function handleEdit(event: CustomEvent<{ kind: string; id: string }>): void {
  if (event.detail.kind !== "sourcePolicies") return;
  const resource = inventory.value?.sourcePolicies.find((item) => item.id === event.detail.id) ?? null;
  if (resource) open(resource);
}

onMounted(() => {
  window.addEventListener("birdbox:resource-create", handleCreate);
  window.addEventListener("birdbox:resource-edit", handleEdit);
});
onBeforeUnmount(() => {
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  window.removeEventListener("birdbox:resource-create", handleCreate);
  window.removeEventListener("birdbox:resource-edit", handleEdit);
});
</script>

<template>
  <dialog id="sourcePolicyDialog" ref="dialog" class="editor-dialog source-policy-editor-dialog" aria-labelledby="sourcePolicyDialogTitle" @cancel.prevent="close">
    <form ref="form" novalidate :aria-busy="pending" @submit.prevent="save">
      <div class="dialog-head"><span class="dialog-icon">⇢</span><div><p class="eyebrow">SOURCE POLICY EGRESS</p><h2 id="sourcePolicyDialogTitle">{{ deleted ? "系统规则清理" : (editing ? "编辑源地址出口映射" : "新增源地址出口映射") }}</h2></div></div>
      <template v-if="!deleted">
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
        <section class="source-policy-preview full-width" aria-labelledby="sourcePolicyPreviewTitle">
          <div class="source-policy-section-head"><div><h3 id="sourcePolicyPreviewTitle">手工操作计划</h3><small>BIRD 配置由 Birdbox 下发；Linux/OpenWrt 的系统规则需要你在节点上手工完成。<span v-if="previewPending">正在更新草稿预览…</span></small></div><select v-if="plans.length > 1" v-model.number="selectedPlanIndex" aria-label="选择节点"><option v-for="(plan, index) in plans" :key="plan.nodeId" :value="index">{{ plan.nodeName }}</option></select></div>
          <p v-if="previewError" class="form-error">{{ previewError }}</p>
          <div v-if="selectedPlan" class="source-policy-plan">
            <div class="source-policy-plan-status"><strong>{{ selectedPlan.nodeName }}</strong><span>{{ selectedPlan.platform === "openwrt" ? "OpenWrt LuCI" : "Linux" }}</span><span>{{ selectedPlan.rules.length }} 条规则</span></div>
            <div class="source-policy-code-grid">
              <div><div class="source-policy-code-head"><span>BIRD 配置片段</span></div><pre>{{ selectedPlan.birdConfig || "删除后不再生成 BIRD 片段" }}</pre></div>
              <div v-if="selectedPlan.platform === 'linux'"><div class="source-policy-code-head"><span>Linux root 脚本</span><button class="compact-command" type="button" :disabled="!(selectedPlan.applyScript || selectedPlan.cleanupScript)" @click="copyScript">复制脚本</button></div><pre>{{ selectedPlan.applyScript || selectedPlan.cleanupScript || "无需要执行的规则" }}</pre></div>
              <div v-else class="source-policy-openwrt">
                <div v-if="selectedPlan.removeRules.length" class="source-policy-code-head"><span>1. 先在 LuCI 删除旧规则</span></div>
                <ol v-if="selectedPlan.removeRules.length"><li v-for="rule in selectedPlan.removeRules" :key="`remove:${rule.priority}:${rule.source}`"><code>Priority {{ rule.priority }}</code><code>from {{ rule.source }}</code><code>lookup {{ rule.table }}</code></li></ol>
                <div class="source-policy-code-head"><span>{{ selectedPlan.removeRules.length ? "2. 再添加当前规则" : "OpenWrt LuCI 规则清单" }}</span></div>
                <ol><li v-for="rule in selectedPlan.rules" :key="`${rule.priority}:${rule.source}`"><code>Priority {{ rule.priority }}</code><code>from {{ rule.source }}</code><code>lookup {{ rule.table }}</code></li></ol>
              </div>
            </div>
            <div v-if="selectedPlan.platform === 'linux' && selectedPlan.systemdInstallScript" class="source-policy-systemd">
              <div class="source-policy-section-head"><div><h3>systemd 持久化</h3><small>安装脚本会写入 helper 和 unit，执行 daemon-reload、enable，并立即重启服务。</small></div></div>
              <div class="source-policy-code-grid">
                <div v-if="selectedPlan.systemdUnit"><div class="source-policy-code-head"><span>systemd unit</span><button class="compact-command" type="button" @click="copySystemdUnit">复制 unit</button></div><pre>{{ selectedPlan.systemdUnit }}</pre></div>
                <div><div class="source-policy-code-head"><span>{{ selectedPlan.rules.length ? "systemd 安装/更新脚本" : "systemd 卸载脚本" }}</span><button class="compact-command" type="button" @click="copySystemdInstallScript">复制脚本</button></div><pre>{{ selectedPlan.systemdInstallScript }}</pre></div>
              </div>
            </div>
            <ul class="source-policy-instructions"><li v-for="instruction in selectedPlan.instructions" :key="instruction">{{ instruction }}</li></ul>
          </div>
          <p v-else class="empty-cell">保存映射集后生成各节点的手工操作计划。</p>
        </section>
        <div class="dialog-actions split-actions"><button v-if="editing" class="text-danger-button" type="button" :disabled="pending" @click="remove">删除映射集</button><span></span><button class="secondary-button" type="button" :disabled="pending" @click="close">关闭</button><button class="primary-button" type="submit" :disabled="pending">{{ pending ? "正在预检并应用" : "预检、保存并下发 BIRD" }}</button></div>
      </template>
      <template v-else>
        <section class="source-policy-preview">
          <p class="form-error">BIRD 配置已删除。请先在以下节点完成系统规则清理，避免遗留无主 ip rule。</p>
          <div v-if="selectedPlan" class="source-policy-plan">
            <div class="source-policy-plan-status"><strong>{{ selectedPlan.nodeName }}</strong><span>{{ selectedPlan.removeRules.length }} 条待清理规则</span></div>
            <template v-if="selectedPlan.platform === 'linux'">
              <div class="source-policy-code-grid"><div><div class="source-policy-code-head"><span>Linux 清理脚本</span><button class="compact-command" type="button" :disabled="!selectedPlan.cleanupScript" @click="copyScript">复制清理脚本</button></div><pre>{{ selectedPlan.cleanupScript || "无需要清理的规则" }}</pre></div></div>
              <div v-if="selectedPlan.systemdInstallScript" class="source-policy-systemd"><div class="source-policy-section-head"><div><h3>systemd 卸载</h3><small>停止并禁用服务，删除 helper 与 unit 后清理对应规则。</small></div></div><div class="source-policy-code-grid"><div><div class="source-policy-code-head"><span>systemd 卸载脚本</span><button class="compact-command" type="button" @click="copySystemdInstallScript">复制脚本</button></div><pre>{{ selectedPlan.systemdInstallScript }}</pre></div></div></div>
            </template>
            <div v-else class="source-policy-openwrt"><div class="source-policy-code-head"><span>OpenWrt LuCI 待删除规则</span></div><ol><li v-for="rule in selectedPlan.removeRules" :key="`${rule.priority}:${rule.source}`"><code>Priority {{ rule.priority }}</code><code>from {{ rule.source }}</code><code>lookup {{ rule.table }}</code></li></ol></div>
          </div>
          <p v-else class="empty-cell">没有待清理规则。</p>
        </section>
        <div class="dialog-actions"><button class="primary-button" type="button" @click="close">完成</button></div>
      </template>
    </form>
  </dialog>
</template>
