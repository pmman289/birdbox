<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";

import type { ResourceMutationResponse } from "@birdbox/contracts/api";
import type {
  PolicyCollection,
  PolicyDefine,
  PolicyFilter,
  PolicyFunction,
} from "@birdbox/contracts/inventory";

import { loadDashboard, useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
import { deploymentSummary } from "../shared/deployment";
import { dispatchToast } from "../shared/events";
import { clearFormValidation, presentFormError, validateForm } from "../shared/form-validation";
import {
  availablePolicySourceReferences,
  policySourceReferenceInsertion,
  type PolicyReferenceResource,
} from "../shared/policy-references";
import { uniqueBirdName } from "../shared/resource-names";

type PolicyResource = PolicyDefine | PolicyFunction | PolicyFilter;
type DefineType = PolicyDefine["type"];

interface Draft {
  nodeId: string | null;
  type: DefineType;
  label: string;
  name: string;
  source: string;
  enabled: boolean;
}

interface ReferenceGroup {
  kind: "define" | "function";
  label: string;
  resources: PolicyReferenceResource[];
}

const dialog = ref<HTMLDialogElement | null>(null);
const form = ref<HTMLFormElement | null>(null);
const editor = ref<HTMLTextAreaElement | null>(null);
const editingId = ref<string | null>(null);
const collection = ref<PolicyCollection>("defines");
const pending = ref(false);
const search = ref("");
const line = ref(1);
const column = ref(1);
const nameEdited = ref(false);
const sourceEdited = ref(false);
const { dashboard } = useDashboardStore();

const draft = reactive<Draft>({
  nodeId: null,
  type: "cidr4",
  label: "",
  name: "",
  source: "",
  enabled: true,
});

const editing = computed(() => editingId.value !== null);
const kindLabel = computed(() => collection.value === "functions" ? "Function" : collection.value === "filters" ? "Filter" : "Define");
const icon = computed(() => collection.value === "functions" ? "ƒ" : collection.value === "filters" ? "F" : "D");
const isCidrDefine = computed(() => collection.value === "defines" && draft.type !== "expression");
const sourceLabel = computed(() => collection.value !== "defines" ? "源码" : draft.type === "cidr4" ? "IPv4 CIDR 条目" : draft.type === "cidr6" ? "IPv6 CIDR 条目" : "值 / 表达式");
const sourcePlaceholder = computed(() => collection.value === "functions"
  ? "function allow_route()\n{\n  return true;\n}"
  : collection.value === "filters"
    ? "filter peer_policy\n{\n  reject;\n}"
    : draft.type === "cidr4"
      ? "10.0.0.0/8+\n192.0.2.0/24"
      : draft.type === "cidr6"
        ? "2001:db8::/32+\n2001:db8:100::/48"
        : "150");
const lineNumbers = computed(() => Array.from({ length: Math.max(1, draft.source.split("\n").length) }, (_, index) => index + 1).join("\n"));
const nodes = computed(() => dashboard.value?.inventory.nodes ?? []);
const nodeNames = computed(() => new Map(nodes.value.map((node) => [node.id, node.name])));

const referenceGroups = computed<ReferenceGroup[]>(() => {
  const inventory = dashboard.value?.inventory;
  const available = availablePolicySourceReferences({
    inventory,
    collection: collection.value,
    currentId: editingId.value ?? "",
    nodeId: draft.nodeId,
  });
  const normalizedQuery = search.value.trim().toLocaleLowerCase();
  const matches = (resource: PolicyReferenceResource, kind: ReferenceGroup["kind"]): boolean => {
    if (!normalizedQuery) return true;
    const sourceResource = kind === "function"
      ? inventory?.functions.find((item) => item.id === resource.id)
      : inventory?.defines.find((item) => item.id === resource.id);
    const type = kind === "function"
      ? (resource.callable ? "无参 function" : "有参 function")
      : sourceResource && "type" in sourceResource ? sourceResource.type : "define";
    const scope = resource.nodeId === null ? "所有节点 global" : (nodeNames.value.get(resource.nodeId) ?? resource.nodeId);
    const text = [resource.name, sourceResource?.label, type, scope].join(" ").toLocaleLowerCase();
    return normalizedQuery.split(/\s+/).every((term) => text.includes(term));
  };
  return [
    { kind: "define" as const, label: "Defines", resources: available.defines.filter((resource) => matches(resource, "define")) },
    { kind: "function" as const, label: "Functions", resources: available.functions.filter((resource) => matches(resource, "function")) },
  ].filter((group) => group.resources.length > 0);
});

const referenceTotal = computed(() => {
  const available = availablePolicySourceReferences({
    inventory: dashboard.value?.inventory,
    collection: collection.value,
    currentId: editingId.value ?? "",
    nodeId: draft.nodeId,
  });
  return available.defines.length + available.functions.length;
});
const referenceShown = computed(() => referenceGroups.value.reduce((count, group) => count + group.resources.length, 0));

const fieldMappings = [
  [/可用范围|不存在的节点/, "policyResourceNodeId"],
  [/Define 类型/, "policyResourceType"],
  [/显示名称/, "policyResourceLabel"],
  [/BIRD 全局标识符冲突|BIRD .*名称|Define 名称|策略名称|声明开始/, "policyResourceName"],
  [/CIDR 列表|Define 表达式|策略源码|源码|顶层声明|花括号|括号/, "policyResourceSource"],
] as const;

function defaultSource(kind: PolicyCollection, name: string): string {
  if (!name) return "";
  if (kind === "functions") return `function ${name}()\n{\n  return true;\n}`;
  if (kind === "filters") return `filter ${name}\n{\n  reject;\n}`;
  return "true";
}

function defaultName(): string {
  const inventory = dashboard.value?.inventory;
  if (!inventory) return "";
  const prefix = collection.value === "functions" ? "function"
    : collection.value === "filters" ? "filter"
      : draft.type === "cidr4" ? "prefix4" : draft.type === "cidr6" ? "prefix6" : "define";
  return uniqueBirdName(inventory, prefix, draft.label, editing.value ? [draft.name] : []);
}

function syncName(): void {
  if (editing.value || nameEdited.value || !draft.label) return;
  const previous = draft.name;
  const generated = defaultName();
  draft.name = generated;
  if (!sourceEdited.value) {
    draft.source = isCidrDefine.value ? "" : defaultSource(collection.value, generated);
  } else if (previous && collection.value !== "defines") {
    const declaration = collection.value === "functions" ? "function" : "filter";
    const escaped = previous.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    draft.source = draft.source.replace(new RegExp(`^(\\s*${declaration}\\s+)${escaped}(?=\\s*[({])`), `$1${generated}`);
  }
}

function changeType(): void {
  if (!sourceEdited.value) draft.source = isCidrDefine.value ? "" : "true";
  if (!nameEdited.value) {
    draft.name = "";
    syncName();
  }
}

function resourceSource(resource: PolicyResource): string {
  if ("source" in resource) return resource.source;
  if (resource.type === "expression") return resource.value;
  return resource.entries.join("\n");
}

function open(nextCollection: PolicyCollection, resource: PolicyResource | null): void {
  collection.value = nextCollection;
  editingId.value = resource?.id ?? null;
  draft.nodeId = resource?.nodeId ?? null;
  draft.type = resource && "type" in resource ? resource.type : "cidr4";
  draft.label = resource?.label ?? resource?.name ?? "";
  draft.name = resource?.name ?? "";
  draft.source = resource ? resourceSource(resource) : "";
  draft.enabled = resource?.enabled ?? true;
  nameEdited.value = Boolean(resource);
  sourceEdited.value = Boolean(resource);
  search.value = "";
  if (!resource) syncName();
  if (form.value) clearFormValidation(form.value);
  if (!dialog.value?.open) dialog.value?.showModal();
  void nextTick(() => document.querySelector<HTMLInputElement>("#policyResourceLabel")?.focus());
}

function close(): void {
  if (!pending.value) dialog.value?.close();
}

function updateCursor(): void {
  const textarea = editor.value;
  if (!textarea) return;
  const before = textarea.value.slice(0, textarea.selectionStart);
  const lines = before.split("\n");
  line.value = lines.length;
  column.value = (lines.at(-1)?.length ?? 0) + 1;
}

function replaceSource(start: number, end: number, text: string, selectionStart: number, selectionEnd = selectionStart): void {
  const textarea = editor.value;
  if (!textarea) return;
  textarea.setRangeText(text, start, end, "end");
  textarea.setSelectionRange(selectionStart, selectionEnd);
  draft.source = textarea.value;
  sourceEdited.value = true;
  updateCursor();
}

function handleEditorKeydown(event: KeyboardEvent): void {
  const textarea = editor.value;
  if (!textarea) return;
  if (event.key === "Tab") {
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end, value: source } = textarea;
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    if (start === end && !event.shiftKey) {
      replaceSource(start, end, "  ", start + 2);
      return;
    }
    const blockEnd = source.indexOf("\n", end);
    const replaceEnd = blockEnd < 0 ? source.length : blockEnd;
    const block = source.slice(lineStart, replaceEnd);
    const lines = block.split("\n");
    const transformed = lines.map((value) => event.shiftKey ? value.replace(/^ {1,2}/, "") : `  ${value}`);
    const firstDelta = (transformed[0]?.length ?? 0) - (lines[0]?.length ?? 0);
    const replacement = transformed.join("\n");
    replaceSource(lineStart, replaceEnd, replacement, Math.max(lineStart, start + firstDelta), Math.max(lineStart, end + replacement.length - block.length));
    return;
  }
  if (event.key !== "Enter") return;
  event.preventDefault();
  const { selectionStart: start, selectionEnd: end, value: source } = textarea;
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const currentLine = source.slice(lineStart, start);
  const baseIndent = currentLine.match(/^\s*/)?.[0] ?? "";
  const nested = currentLine.trimEnd().endsWith("{");
  const indent = nested ? `${baseIndent}  ` : baseIndent;
  if (nested && source.slice(end).trimStart().startsWith("}")) {
    const insertion = `\n${indent}\n${baseIndent}`;
    replaceSource(start, end, insertion, start + 1 + indent.length);
  } else {
    const insertion = `\n${indent}`;
    replaceSource(start, end, insertion, start + insertion.length);
  }
}

function insertReference(resource: PolicyReferenceResource, kind: ReferenceGroup["kind"]): void {
  const textarea = editor.value;
  if (!textarea) return;
  const insertion = policySourceReferenceInsertion(resource, kind);
  replaceSource(textarea.selectionStart, textarea.selectionEnd, insertion, textarea.selectionStart + insertion.length);
  textarea.focus();
}

function referenceLabel(resource: PolicyReferenceResource, kind: ReferenceGroup["kind"]): string {
  if (kind === "function") return resource.callable ? "无参 Function" : "有参 Function";
  const define = dashboard.value?.inventory.defines.find((item) => item.id === resource.id);
  if (define?.type === "cidr4") return "IPv4 CIDR";
  if (define?.type === "cidr6") return "IPv6 CIDR";
  return "表达式 Define";
}

function referenceSymbol(resource: PolicyReferenceResource, kind: ReferenceGroup["kind"]): string {
  if (kind === "define") return resource.name;
  const source = dashboard.value?.inventory.functions.find((item) => item.id === resource.id)?.source ?? "";
  const signature = source.match(/^\s*function\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)/)?.[1]?.trim() ?? "";
  return `${resource.name}(${signature})`;
}

async function save(): Promise<void> {
  if (!form.value || !validateForm(form.value)) return;
  pending.value = true;
  const id = editingId.value;
  const body = collection.value === "defines"
    ? {
        nodeId: draft.nodeId,
        label: draft.label,
        name: draft.name,
        enabled: draft.enabled,
        type: draft.type,
        ...(isCidrDefine.value ? { entries: draft.source } : { value: draft.source }),
      }
    : { nodeId: draft.nodeId, label: draft.label, name: draft.name, enabled: draft.enabled, source: draft.source };
  try {
    const result = await api<ResourceMutationResponse<PolicyResource>>(id ? `/api/${collection.value}/${encodeURIComponent(id)}` : `/api/${collection.value}`, {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    await loadDashboard(draft.nodeId ?? dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null);
    window.dispatchEvent(new CustomEvent("birdbox:resource-tab-select", { detail: { target: collection.value } }));
    dialog.value?.close();
    dispatchToast(`${kindLabel.value} 已${id ? "更新" : "添加"}，${deploymentSummary(result.deployment)}`, "success");
  } catch (error) {
    presentFormError(form.value, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

async function remove(): Promise<void> {
  const id = editingId.value;
  const resource = id ? dashboard.value?.inventory[collection.value].find((item) => item.id === id) : null;
  if (!resource || !window.confirm(`删除 ${kindLabel.value} ${resource.name}？`)) return;
  pending.value = true;
  try {
    await api(`/api/${collection.value}/${encodeURIComponent(resource.id)}`, { method: "DELETE" });
    await loadDashboard(resource.nodeId ?? dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null);
    window.dispatchEvent(new CustomEvent("birdbox:resource-tab-select", { detail: { target: collection.value } }));
    dialog.value?.close();
    dispatchToast(`${kindLabel.value} 已删除`, "success");
  } catch (error) {
    presentFormError(form.value!, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

function handleCreate(event: CustomEvent<{ kind: string }>): void {
  if (event.detail.kind === "defines" || event.detail.kind === "functions" || event.detail.kind === "filters") open(event.detail.kind, null);
}

function handleEdit(event: CustomEvent<{ kind: string; id: string }>): void {
  const kind = event.detail.kind;
  if (kind !== "defines" && kind !== "functions" && kind !== "filters") return;
  const resource = dashboard.value?.inventory[kind].find((item) => item.id === event.detail.id) ?? null;
  if (resource) open(kind, resource);
}

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
  <dialog id="policyResourceDialog" ref="dialog" class="editor-dialog policy-editor-dialog" aria-labelledby="policyResourceDialogTitle" @cancel.prevent="close">
    <form id="policyResourceForm" ref="form" novalidate :aria-busy="pending" @submit.prevent="save">
      <div class="dialog-head"><span id="policyResourceIcon" class="dialog-icon">{{ icon }}</span><div><p class="eyebrow">BIRD Policy</p><h2 id="policyResourceDialogTitle">{{ editing ? "编辑" : "添加" }} {{ kindLabel }}</h2></div></div>
      <div class="dialog-grid">
        <div class="field full-width"><label for="policyResourceNodeId">可用范围</label><select id="policyResourceNodeId" v-model="draft.nodeId"><option :value="null">所有节点</option><option v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></div>
        <div v-if="collection === 'defines'" id="policyResourceTypeField" class="field"><label for="policyResourceType">Define 类型</label><select id="policyResourceType" v-model="draft.type" @change="changeType"><option value="cidr4">IPv4 CIDR 列表</option><option value="cidr6">IPv6 CIDR 列表</option><option value="expression">表达式</option></select></div>
        <div id="policyResourceLabelField" class="field"><label for="policyResourceLabel">显示名称 / 备注</label><input id="policyResourceLabel" v-model.trim="draft.label" maxlength="80" required placeholder="例如：上游导入优先级" @input="syncName"></div>
        <div class="field full-width"><label for="policyResourceName">BIRD 名称（自动，可编辑）</label><input id="policyResourceName" v-model.trim="draft.name" pattern="[A-Za-z_][A-Za-z0-9_]*" required @input="nameEdited = true"></div>
        <div id="policyResourceSourceField" class="field full-width">
          <label id="policyResourceSourceLabel" for="policyResourceSource">{{ sourceLabel }}</label>
          <div class="code-input">
            <pre id="policySourceLines" class="code-input-lines" aria-hidden="true">{{ lineNumbers }}</pre>
            <textarea id="policyResourceSource" ref="editor" v-model="draft.source" class="policy-source-editor" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off" required :placeholder="sourcePlaceholder" @input="sourceEdited = true; updateCursor()" @keydown="handleEditorKeydown" @click="updateCursor" @keyup="updateCursor"></textarea>
            <div class="code-input-status"><span>BIRD</span><span id="policySourcePosition">Ln {{ line }}, Col {{ column }}</span></div>
          </div>
          <div v-if="!isCidrDefine" id="policySourceReferencePanel" class="code-references">
            <div class="code-reference-toolbar"><div class="code-reference-heading"><strong>可用资源</strong><span id="policySourceReferenceCount">{{ search ? `${referenceShown} / ${referenceTotal} 项` : `${referenceTotal} 项` }}</span></div><input id="policySourceReferenceSearch" v-model.trim="search" type="search" autocomplete="off" aria-label="搜索可用策略资源" placeholder="搜索名称、标识符或类型"></div>
            <div id="policySourceReferences" class="code-reference-groups" aria-live="polite">
              <section v-for="group in referenceGroups" :key="group.kind" class="code-reference-group" :aria-label="`可用 ${group.label}`">
                <div class="code-reference-group-heading"><span class="code-reference-kind" :class="group.kind" aria-hidden="true">{{ group.kind === "function" ? "ƒ" : "D" }}</span><strong>{{ group.label }}</strong><span>{{ group.resources.length }}</span></div>
                <div class="code-reference-list"><button v-for="resource in group.resources" :key="resource.id" class="code-reference-button" type="button" :title="`插入 ${policySourceReferenceInsertion(resource, group.kind)}`" @click="insertReference(resource, group.kind)"><span class="code-reference-copy"><strong>{{ dashboard?.inventory[group.kind === "function" ? "functions" : "defines"].find((item) => item.id === resource.id)?.label ?? resource.name }}</strong><code>{{ referenceSymbol(resource, group.kind) }}</code></span><span class="code-reference-meta"><span>{{ referenceLabel(resource, group.kind) }}</span><span>{{ resource.nodeId === null ? "所有节点" : (nodeNames.get(resource.nodeId) ?? "当前节点") }}</span></span></button></div>
              </section>
              <span v-if="!referenceGroups.length" class="code-reference-empty">{{ referenceTotal ? "没有匹配的资源" : "当前作用域没有可用资源" }}</span>
            </div>
          </div>
        </div>
        <label class="toggle-row full-width" for="policyResourceEnabled"><span><strong>启用资源</strong></span><input id="policyResourceEnabled" v-model="draft.enabled" type="checkbox"><i aria-hidden="true"></i></label>
      </div>
      <div class="dialog-actions split-actions"><button v-if="editing" id="deletePolicyResourceButton" class="text-danger-button" type="button" :disabled="pending" @click="remove">删除资源</button><span></span><button class="secondary-button" type="button" data-close="policyResourceDialog" :disabled="pending" @click="close">取消</button><button id="savePolicyResourceButton" class="primary-button" type="submit" :disabled="pending">{{ pending ? "正在预检" : "预检、保存并应用" }}</button></div>
    </form>
  </dialog>
</template>
