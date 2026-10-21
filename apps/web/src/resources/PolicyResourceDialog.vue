<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import type { PolicyResourceEditorContext, PolicyResourcePreviewResponse, ResourceMutationResponse } from "@birdbox/contracts/api";
import type {
  PolicyCollection,
  PolicyDefine,
  PolicyFilter,
  PolicyFunction,
} from "@birdbox/contracts/inventory";

import { loadDashboard, useDashboardStore } from "../dashboard/dashboard-store";
import MultiNodeScopeField from "../shared/MultiNodeScopeField.vue";
import { policyResourceReferences } from "@birdbox/contracts/define-references";
import { splitBirdPrefixEntries } from "@birdbox/contracts/prefix-entries";
import { api, ApiError } from "../shared/api-client";
import { deploymentSummary } from "../shared/deployment";
import { dispatchToast } from "../shared/events";
import { clearFormValidation, presentFormError, validateForm } from "../shared/form-validation";
import {
  availablePolicySourceReferences,
  policySourceReferenceInsertion,
  type PolicyReferenceResource,
} from "../shared/policy-references";
import { uniqueBirdName } from "../shared/resource-names";
import { resourceScopeLabel, resourceScopeShortLabel } from "../shared/resource-scope";

type PolicyResource = PolicyDefine | PolicyFunction | PolicyFilter;
type DefineType = PolicyDefine["type"];

interface Draft {
  nodeIds: string[] | null;
  type: DefineType;
  label: string;
  name: string;
  source: string;
  entrySourceKind: "manual" | "irr-as-set";
  asSet: string;
  server: string;
  databases: string;
  refreshIntervalSeconds: number;
  prefixLimit: number;
  allowMoreSpecific: boolean;
  sync: Record<string, unknown> | null;
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
const resolving = ref(false);
const search = ref("");
const line = ref(1);
const column = ref(1);
const nameEdited = ref(false);
const sourceEdited = ref(false);
const scopeError = ref(false);
const { dashboard } = useDashboardStore();
let resolveController: AbortController | null = null;
let resolveGeneration = 0;

const draft = reactive<Draft>({
  nodeIds: null,
  type: "cidr4",
  label: "",
  name: "",
  source: "",
  entrySourceKind: "manual",
  asSet: "",
  server: "rr.ntt.net",
  databases: "RIPE,ARIN,APNIC,LACNIC,AFRINIC",
  refreshIntervalSeconds: 86400,
  prefixLimit: 10000,
  allowMoreSpecific: false,
  sync: null,
  enabled: true,
});

const definePreview = ref<PolicyResourcePreviewResponse | null>(null);
const previewPending = ref(false), contextPending = ref(false), contextReady = ref(false);
const editorError = ref(""), conflict = ref(false);
const comparison = ref<PolicyResourceEditorContext | null>(null);
const initialResource = ref<PolicyResource | null>(null);
const contextReferences = ref<PolicyResourceEditorContext["references"] | null>(null);
const inventoryRevision = ref<number | null>(null);
const prefixSearch = ref("");
const expandedSnapshot = ref(false);
const savedSignature = ref("");
const reconciliationId = ref<string | null>(null);
const sourceDrafts = new Map<string, { source: string; sync: Draft["sync"]; expanded: boolean }>();
let previewGeneration = 0, editorGeneration = 0;
let previewController: AbortController | null = null;
function signatureOfDraft(value: Draft): string {
  return JSON.stringify({ ...value, sync: undefined, ...(collection.value === "defines" && value.type !== "expression" && value.entrySourceKind === "irr-as-set" ? { source: undefined } : {}) });
}
const draftSignature = computed(() => signatureOfDraft(draft));
const dirty = computed(() => draftSignature.value !== savedSignature.value);
const references = computed(() => definePreview.value?.references ?? contextReferences.value ?? (dashboard.value?.inventory && initialResource.value ? policyResourceReferences(dashboard.value.inventory, initialResource.value, collection.value) : []));
const affectedNodeIds = computed(() => [...new Set([...(initialResource.value ? initialResource.value.nodeIds ?? nodes.value.map(n => n.id) : []), ...(draft.nodeIds ?? nodes.value.map(n => n.id))])]);
const prefixEntries = computed(() => splitBirdPrefixEntries(draft.source));
const duplicatePrefixCount = computed(() => prefixEntries.value.length - new Set(prefixEntries.value.map(entry => entry.replace(/\s+/g, ""))).size);
const matchingPrefixes = computed(() => prefixEntries.value.filter(entry => entry.toLowerCase().includes(prefixSearch.value.toLowerCase())));
async function revealFeedback(): Promise<void> {
  await nextTick();
  const content = dialog.value?.querySelector<HTMLElement>(".policy-editor-content");
  const feedback = dialog.value?.querySelector<HTMLElement>(".policy-review-panels > [role='alert']");
  if (!content || !feedback) return;
  content.scrollTop += feedback.getBoundingClientRect().top - content.getBoundingClientRect().top - 8;
  feedback.focus({ preventScroll: true });
}
function invalidatePreview() {
  previewGeneration++; previewController?.abort(); previewController = null;
  previewPending.value = false; definePreview.value = null;
}
watch(draftSignature, invalidatePreview, { flush: "sync" });
watch(() => JSON.stringify([draft.type, draft.entrySourceKind, draft.asSet, draft.server, draft.databases, draft.prefixLimit, draft.allowMoreSpecific]), () => {
  resolveGeneration++; resolveController?.abort(); resolveController = null; resolving.value = false; expandedSnapshot.value = false;
}, { flush: "sync" });
function defineBody(): Record<string, unknown> {
  return { nodeIds: draft.nodeIds, label: draft.label, name: draft.name, enabled: draft.enabled, type: draft.type,
    ...(isCidrDefine.value ? { entries: draft.source, entrySource: draft.entrySourceKind === "manual" ? { kind: "manual" } : {
      kind: "irr-as-set", asSet: draft.asSet, server: draft.server,
      databases: draft.databases.split(",").map(item => item.trim()).filter(Boolean),
      refreshIntervalSeconds: draft.refreshIntervalSeconds, prefixLimit: draft.prefixLimit, allowMoreSpecific: draft.allowMoreSpecific,
    } } : { value: draft.source }), inventoryRevision: inventoryRevision.value };
}
function policyBody(): Record<string, unknown> {
  return collection.value === "defines" ? defineBody() : { nodeIds: draft.nodeIds, label: draft.label, name: draft.name, enabled: draft.enabled, source: draft.source, inventoryRevision: inventoryRevision.value };
}
function referenceTitle(kind: string): string {
  return ({ defines: "Define", functions: "Function", filters: "Filter", sessions: "BGP", statics: "Static", sourcePolicies: "源地址出口", ospf: "OSPF", kernels: "Kernel", pipes: "Pipe" } as Record<string, string>)[kind] ?? kind;
}
async function loadContext(compare = false): Promise<void> {
  const request = ++editorGeneration;
  contextPending.value = true; editorError.value = "";
  try {
    const id = reconciliationId.value ?? editingId.value;
    const result = await api<PolicyResourceEditorContext>(`/api/${collection.value}/editor-context${id ? `?id=${encodeURIComponent(id)}` : ""}`);
    if (request !== editorGeneration || !dialog.value?.open) return;
    contextReferences.value = result.references;
    if (compare || JSON.stringify(result.resource) !== JSON.stringify(initialResource.value)) {
      comparison.value = result; conflict.value = true;
      editorError.value = "服务端配置已变化。请对比后选择采用最新配置，或保留草稿重新预检。";
    } else { inventoryRevision.value = result.inventoryRevision; contextReady.value = true; }
  } catch (error) {
    if (request === editorGeneration) editorError.value = error instanceof Error ? error.message : "读取版本失败";
  } finally { if (request === editorGeneration) contextPending.value = false; }
}
function keepDraft() {
  if (!comparison.value) return;
  inventoryRevision.value = comparison.value.inventoryRevision;
  if (editingId.value && !comparison.value.resource) {
    // The original was deleted elsewhere. Keep the user's fields, but create
    // a new resource rather than retrying PUT against the removed ID.
    editingId.value = null;
    savedSignature.value = "";
  } else savedSignature.value = comparison.value.resource ? signatureOfDraft(draftFromResource(comparison.value.resource)) : savedSignature.value;
  initialResource.value = comparison.value.resource;
  if (reconciliationId.value && comparison.value.resource) editingId.value = comparison.value.resource.id;
  reconciliationId.value = null;
  comparison.value = null; conflict.value = false; contextReady.value = true; editorError.value = "";
  invalidatePreview();
}
function adoptRemote() {
  if (!comparison.value) return;
  const resource = comparison.value.resource;
  if (!resource) return;
  open(collection.value, resource);
}
function openReference(item: PolicyResourceEditorContext["references"][number]) {
  if (item.kind === "sessions" || item.kind === "ospf") return;
  close(); if (dialog.value?.open) return;
  window.dispatchEvent(new CustomEvent("birdbox:resource-tab-select", { detail: { target: item.kind } }));
  window.dispatchEvent(new CustomEvent("birdbox:resource-edit", { detail: { kind: item.kind, id: item.id } }));
}
function localSummary() {
  const body = policyBody();
  return JSON.stringify({ ...body, ...(isCidrDefine.value ? { entries: prefixEntries.value.slice(0, 30), totalEntries: prefixEntries.value.length } : {}) }, null, 2);
}
function snapshotSummary(resource: PolicyResource | null): string {
  if (!resource) return "尚未创建";
  return JSON.stringify("source" in resource || resource.type === "expression" ? resource : { ...resource, entries: resource.entries.slice(0, 30), totalEntries: resource.entries.length }, null, 2);
}
async function inspectDefine(refreshSnapshot = false): Promise<void> {
  if (!contextReady.value || conflict.value || !form.value) return;
  scopeError.value = draft.nodeIds !== null && draft.nodeIds.length === 0;
  if (scopeError.value || !affectedNodeIds.value.length) {
    editorError.value = nodes.value.length ? "请至少选择一个下发节点" : `请先添加受管节点，再预检 ${kindLabel.value} 配置`;
    return;
  }
  if (!validateForm(form.value)) return;
  invalidatePreview(); const request = previewGeneration; const controller = new AbortController(); previewController = controller;
  previewPending.value = true; editorError.value = "";
  try {
    const result = await api<PolicyResourcePreviewResponse>(`/api/${collection.value}/preview`, { method: "POST", body: JSON.stringify({ ...policyBody(), ...(refreshSnapshot ? { refreshSnapshot: true } : {}), ...(editingId.value ? { id: editingId.value } : {}) }), signal: controller.signal, mutationWait: false, timeoutMs: 120_000 });
    if (request !== previewGeneration || controller.signal.aborted) return;
    definePreview.value = result;
    await nextTick();
    const content = dialog.value?.querySelector<HTMLElement>(".policy-editor-content"), panel = dialog.value?.querySelector<HTMLElement>("#definePreview");
    if (content && panel) content.scrollTop += panel.getBoundingClientRect().top - content.getBoundingClientRect().top;
  } catch (error) {
    if (request !== previewGeneration || controller.signal.aborted) return;
    editorError.value = error instanceof Error ? error.message : "预检失败";
    if (error instanceof ApiError && error.code === "STATE_CONFLICT") conflict.value = true;
    presentFormError(form.value, error, fieldMappings);
  } finally { if (request === previewGeneration) previewPending.value = false; }
}
function deduplicatePrefixes() { draft.source = [...new Set(prefixEntries.value.map(entry => entry.replace(/\s+/g, "")))].join("\n"); sourceEdited.value = true; }
async function importPrefixes(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  if (!file) return;
  if (file.size > 1024 * 1024) { editorError.value = "导入文件不能超过 1 MiB"; input.value = ""; return; }
  const request = editorGeneration, signature = draftSignature.value;
  try {
    const text = await file.text();
    if (request !== editorGeneration || !dialog.value?.open || signature !== draftSignature.value) return;
    // Imported BIRD lists may have their own surrounding brackets. Split the
    // two lists separately so appending a file preserves valid prefix entries.
    draft.source = [...prefixEntries.value, ...splitBirdPrefixEntries(text)].join("\n"); sourceEdited.value = true;
  } catch { editorError.value = "读取文件失败，请重试"; }
  input.value = "";
}
function exportPrefixes() {
  const url = URL.createObjectURL(new Blob([prefixEntries.value.join("\n")], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `${draft.name || "prefixes"}.txt`; link.click(); URL.revokeObjectURL(url);
}
function applyTemplate(event: Event) {
  const select = event.target as HTMLSelectElement;
  if (draft.source.trim() && !window.confirm("用模板替换当前表达式？")) { select.value = ""; return; }
  draft.source = select.value; sourceEdited.value = true; select.value = "";
}

const editing = computed(() => editingId.value !== null);
const kindLabel = computed(() => collection.value === "functions" ? "Function" : collection.value === "filters" ? "Filter" : "Define");
const icon = computed(() => collection.value === "functions" ? "ƒ" : collection.value === "filters" ? "F" : "D");
const isCidrDefine = computed(() => collection.value === "defines" && draft.type !== "expression");
const isIrrDefine = computed(() => isCidrDefine.value && draft.entrySourceKind === "irr-as-set");
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
    nodeIds: draft.nodeIds,
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
    const scope = `${resourceScopeLabel(resource, nodeNames.value)} ${resource.nodeIds === null ? "global" : ""}`;
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
    nodeIds: draft.nodeIds,
  });
  return available.defines.length + available.functions.length;
});
const referenceShown = computed(() => referenceGroups.value.reduce((count, group) => count + group.resources.length, 0));

const fieldMappings = [
  [/可用范围|不存在的节点|作用域不兼容/, "policyResourceNodeScope"],
  [/Define 类型/, "policyResourceType"],
  [/显示名称/, "policyResourceLabel"],
  [/BIRD 全局标识符冲突|BIRD .*名称|Define 名称|策略名称|声明开始/, "policyResourceName"],
  [/CIDR 条目|前缀模式|前缀长度|CIDR 列表|Define 表达式|策略源码|源码|顶层声明|花括号|括号|依赖形成循环|声明顺序/, "policyResourceSource"],
  [/AS-SET/, "policyResourceAsSet"],
  [/IRR Server/, "policyResourceIrrServer"],
  [/Database/, "policyResourceIrrDatabases"],
  [/前缀上限/, "policyResourcePrefixLimit"],
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

function sourceDraftKey(): string {
  return draft.type === "expression" ? "expression" : `${draft.type}:${draft.entrySourceKind}`;
}
function switchSource(update: () => void): void {
  sourceDrafts.set(sourceDraftKey(), { source: draft.source, sync: draft.sync, expanded: expandedSnapshot.value });
  update();
  const remembered = sourceDrafts.get(sourceDraftKey());
  draft.source = remembered?.source ?? (draft.type === "expression" ? "true" : "");
  draft.sync = remembered?.sync ?? null;
  expandedSnapshot.value = remembered?.expanded ?? false;
  sourceEdited.value = Boolean(draft.source);
  prefixSearch.value = "";
  if (form.value) clearFormValidation(form.value);
}
function changeType(event: Event): void {
  switchSource(() => { draft.type = (event.target as HTMLSelectElement).value as DefineType; });
  if (!editing.value && !nameEdited.value) draft.name = defaultName();
}
function changeEntrySource(event: Event): void {
  switchSource(() => { draft.entrySourceKind = (event.target as HTMLSelectElement).value as Draft["entrySourceKind"]; });
}

function resourceSource(resource: PolicyResource): string {
  if ("source" in resource) return resource.source;
  if (resource.type === "expression") return resource.value;
  return resource.entries.join("\n");
}

function draftFromResource(resource: PolicyResource | null): Draft {
  const cidr = resource && "type" in resource && resource.type !== "expression" ? resource : null;
  const irr = cidr?.entrySource.kind === "irr-as-set" ? cidr.entrySource : null;
  return {
    nodeIds: resource?.nodeIds === null || !resource ? null : [...resource.nodeIds],
    type: resource && "type" in resource ? resource.type : "cidr4",
    label: resource?.label ?? resource?.name ?? "",
    name: resource?.name ?? "",
    source: resource ? resourceSource(resource) : "",
    entrySourceKind: cidr?.entrySource.kind ?? "manual",
    asSet: irr?.asSet ?? "",
    server: irr?.server ?? "rr.ntt.net",
    databases: irr?.databases.join(",") ?? "RIPE,ARIN,APNIC,LACNIC,AFRINIC",
    refreshIntervalSeconds: irr?.refreshIntervalSeconds ?? 86400,
    prefixLimit: irr?.prefixLimit ?? 10000,
    allowMoreSpecific: irr?.allowMoreSpecific ?? false,
    sync: cidr?.sync ? { ...cidr.sync } : null,
    enabled: resource?.enabled ?? true,
  };
}

function open(nextCollection: PolicyCollection, resource: PolicyResource | null): void {
  if (pending.value) return;
  invalidatePreview(); editorGeneration++;
  expandedSnapshot.value = false; contextReferences.value = null; contextReady.value = false; comparison.value = null; conflict.value = false; editorError.value = ""; prefixSearch.value = "";
  initialResource.value = resource ? JSON.parse(JSON.stringify(resource)) as PolicyResource : null;
  resolveGeneration += 1;
  resolveController?.abort();
  resolveController = null;
  resolving.value = false;
  collection.value = nextCollection;
  editingId.value = resource?.id ?? null;
  reconciliationId.value = null; sourceDrafts.clear();
  Object.assign(draft, draftFromResource(resource));
  nameEdited.value = Boolean(resource);
  sourceEdited.value = Boolean(resource);
  search.value = "";
  scopeError.value = false;
  if (!resource) syncName();
  savedSignature.value = draftSignature.value;
  if (form.value) clearFormValidation(form.value);
  if (!dialog.value?.open) dialog.value?.showModal();
  void nextTick(() => {
    if (collection.value === "defines") {
      const content = dialog.value?.querySelector<HTMLElement>(".policy-editor-content");
      if (content) content.scrollTop = 0;
    }
    document.querySelector<HTMLInputElement>("#policyResourceLabel")?.focus({ preventScroll: collection.value === "defines" });
  });
  void loadContext();
}

function close(): void {
  if (pending.value) return;
  if (dirty.value && !window.confirm(`放弃尚未保存的 ${kindLabel.value} 修改？`)) return;
  editorGeneration++; invalidatePreview(); dialog.value?.close();
  resolveGeneration += 1;
  resolveController?.abort();
  resolveController = null;
  resolving.value = false;
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
  if (pending.value || previewPending.value) return;
  {
    if (!definePreview.value?.valid) { await inspectDefine(); return; }
    if (!window.confirm(`确认将此 ${kindLabel.value} 变更应用到 ${definePreview.value.configs.length} 个节点？`)) return;
  }
  scopeError.value = draft.nodeIds !== null && draft.nodeIds.length === 0;
  if (scopeError.value) {
    document.querySelector<HTMLElement>("#policyResourceNodeScope")?.focus();
    dispatchToast("请至少选择一个可用节点", "error");
    return;
  }
  if (!form.value || !validateForm(form.value)) return;
  pending.value = true;
  const id = editingId.value;
  const candidateId = definePreview.value!.resource.id;
  const body = { ...definePreview.value!.resource, mode: "apply", previewId: definePreview.value!.previewId, candidateHash: definePreview.value!.candidateHash, inventoryRevision: definePreview.value!.inventoryRevision };
  try {
    const result = await api<ResourceMutationResponse<PolicyResource>>(id ? `/api/${collection.value}/${encodeURIComponent(id)}` : `/api/${collection.value}`, {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    const selectedNodeId = draft.nodeIds?.[0] ?? dashboard.value?.node?.id ?? null;
    await loadDashboard(selectedNodeId, dashboard.value?.selectedPeer?.id ?? null).catch(() => dispatchToast("操作已成功，请刷新资源列表", "error"));
    window.dispatchEvent(new CustomEvent("birdbox:resource-tab-select", { detail: { target: collection.value } }));
    dialog.value?.close();
    dispatchToast(`${kindLabel.value} 已${id ? "更新" : "添加"}，${deploymentSummary(result.deployment)}`, "success");
  } catch (error) {
    {
      invalidatePreview(); editorError.value = error instanceof Error ? error.message : "应用失败，草稿已保留";
      if (error instanceof ApiError && (error.code === "STATE_CONFLICT" || error.unknownOutcome)) {
        conflict.value = true;
        if (error.unknownOutcome) {
          reconciliationId.value = candidateId;
          editorError.value = "尚未收到应用结果，配置可能已生效。请加载最新版本核对结果，再决定采用已保存配置或保留草稿重新预检。";
        }
      }
    }
    presentFormError(form.value, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

async function resolvePreview(): Promise<void> {
  if (!form.value || !validateForm(form.value)) return;
  resolveController?.abort();
  const controller = new AbortController();
  resolveController = controller;
  const generation = ++resolveGeneration;
  const requestSignature = JSON.stringify({
    type: draft.type,
    asSet: draft.asSet,
    server: draft.server,
    databases: draft.databases,
    prefixLimit: draft.prefixLimit,
    allowMoreSpecific: draft.allowMoreSpecific,
    entrySourceKind: draft.entrySourceKind,
  });
  resolving.value = true;
  try {
    const result = await api<{ entries: string[]; count: number }>("/api/defines/irr/resolve", {
      method: "POST",
      mutationWait: false,
      signal: controller.signal,
      body: JSON.stringify({
        type: draft.type,
        entrySource: {
          kind: "irr-as-set", asSet: draft.asSet, server: draft.server,
          databases: draft.databases.split(",").map((item) => item.trim()).filter(Boolean),
          prefixLimit: draft.prefixLimit, allowMoreSpecific: draft.allowMoreSpecific,
        },
      }),
    });
    const currentSignature = JSON.stringify({
      type: draft.type,
      asSet: draft.asSet,
      server: draft.server,
      databases: draft.databases,
      prefixLimit: draft.prefixLimit,
      allowMoreSpecific: draft.allowMoreSpecific,
      entrySourceKind: draft.entrySourceKind,
    });
    if (generation !== resolveGeneration || controller.signal.aborted || currentSignature !== requestSignature) return;
    draft.source = result.entries.join("\n"); expandedSnapshot.value = true;
    dispatchToast(`测试展开成功，共 ${result.count} 条前缀`, "success");
  } catch (error) {
    if (generation === resolveGeneration && !controller.signal.aborted) presentFormError(form.value, error, fieldMappings);
  } finally {
    if (generation === resolveGeneration) {
      resolving.value = false;
      resolveController = null;
    }
  }
}

async function syncNow(): Promise<void> {
  if (!editingId.value || dirty.value || conflict.value) return;
  await inspectDefine(true);
}

async function remove(): Promise<void> {
  const id = editingId.value;
  const resource = id ? dashboard.value?.inventory[collection.value].find((item) => item.id === id) : null;
  if (!resource) return;
  if (references.value.length) { editorError.value = `此 ${kindLabel.value} 仍被引用，请先在下方引用与影响中查看并解除引用后再删除。`; dialog.value?.querySelector<HTMLDetailsElement>(".define-references")?.setAttribute("open", ""); return; }
  if (!window.confirm(`删除 ${kindLabel.value} ${resource.name}？${collection.value === "defines" ? `将影响 ${affectedNodeIds.value.length} 个节点，未保存修改会被放弃。` : ""}`)) return;
  pending.value = true;
  try {
    await api(`/api/${collection.value}/${encodeURIComponent(resource.id)}`, { method: "DELETE", body: JSON.stringify({ inventoryRevision: inventoryRevision.value }) });
    const selectedNodeId = resource.nodeIds?.[0] ?? dashboard.value?.node?.id ?? null;
    await loadDashboard(selectedNodeId, dashboard.value?.selectedPeer?.id ?? null).catch(() => dispatchToast("操作已成功，请刷新资源列表", "error"));
    window.dispatchEvent(new CustomEvent("birdbox:resource-tab-select", { detail: { target: collection.value } }));
    dialog.value?.close();
    dispatchToast(`${kindLabel.value} 已删除`, "success");
  } catch (error) {
    {
      editorError.value = error instanceof Error ? error.message : "操作失败，编辑内容已保留";
      if (error instanceof ApiError && error.code === "STATE_CONFLICT") conflict.value = true;
    }
    presentFormError(form.value!, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (dialog.value?.open && dirty.value) { event.preventDefault(); event.returnValue = ""; }
}
function canSwitch(): boolean {
  return !pending.value && !(dialog.value?.open && dirty.value && !window.confirm(`放弃尚未保存的 ${kindLabel.value} 修改并切换资源？`));
}
function handleCreate(event: CustomEvent<{ kind: string }>): void {
  if (!["defines", "functions", "filters"].includes(event.detail.kind) || !canSwitch()) return;
  if (event.detail.kind === "defines" || event.detail.kind === "functions" || event.detail.kind === "filters") open(event.detail.kind, null);
}

function handleEdit(event: CustomEvent<{ kind: string; id: string }>): void {
  const kind = event.detail.kind;
  if (!["defines", "functions", "filters"].includes(kind) || !canSwitch()) return;
  if (kind !== "defines" && kind !== "functions" && kind !== "filters") return;
  const resource = dashboard.value?.inventory[kind].find((item) => item.id === event.detail.id) ?? null;
  if (resource) open(kind, resource);
}

onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("birdbox:resource-create", handleCreate);
  window.addEventListener("birdbox:resource-edit", handleEdit);
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", beforeUnload);
  editorGeneration++; invalidatePreview();
  resolveGeneration += 1;
  resolveController?.abort();
  resolveController = null;
  window.removeEventListener("birdbox:resource-create", handleCreate);
  window.removeEventListener("birdbox:resource-edit", handleEdit);
});
</script>

<template>
  <dialog id="policyResourceDialog" ref="dialog" class="editor-dialog policy-editor-dialog define-editor-dialog" aria-labelledby="policyResourceDialogTitle" @cancel.prevent="close">
    <form id="policyResourceForm" ref="form" novalidate :aria-busy="pending" @submit.prevent="save">
      <div class="dialog-head"><span id="policyResourceIcon" class="dialog-icon">{{ icon }}</span><div><p class="eyebrow">BIRD Policy</p><h2 id="policyResourceDialogTitle">{{ editing ? "编辑" : "添加" }} {{ kindLabel }}</h2><p class="define-heading-status">{{ draft.name || `新 ${kindLabel}` }} · {{ !editing ? '新建草稿' : dirty ? '未保存修改' : '已保存配置' }} · 影响 {{ affectedNodeIds.length }} 个节点</p></div></div>
      <div class="policy-editor-content">
      <section class="define-intro">
        <p>{{ collection === "defines" ? "把可复用的前缀或常量定义一次，再供协议和策略引用。" : collection === "functions" ? "把重复的策略逻辑写成 Function，在协议或 Filter 中复用。" : "编写完整 Filter，分别绑定到协议的导入或导出方向。" }}编辑不会立即影响节点。</p>
        <div class="define-status"><span>{{ !editing ? '新建草稿，尚未应用' : dirty ? '有未保存修改' : '与已保存配置一致' }}</span><span>影响 {{ affectedNodeIds.length }} 个节点</span><span>{{ references.length }} 个引用资源</span></div>
        <p v-if="collection === 'defines'" class="protocol-help">{{ draft.type === 'expression' ? '表达式适合整数、布尔值和集合等 BIRD 常量。' : '前缀集适合路由匹配；带 +、- 或长度范围的条目不能直接生成 Static 路由。' }}</p>
      </section>
      <fieldset class="dialog-grid policy-editor-fields" :disabled="pending">
        <MultiNodeScopeField id="policyResourceNodeScope" v-model="draft.nodeIds" :nodes="nodes" :invalid="scopeError" @change="scopeError = false" />
        <div v-if="collection === 'defines'" id="policyResourceTypeField" class="field"><label for="policyResourceType">Define 类型</label><select id="policyResourceType" :value="draft.type" @change="changeType"><option value="cidr4">IPv4 CIDR 列表</option><option value="cidr6">IPv6 CIDR 列表</option><option value="expression">表达式</option></select><p class="protocol-help">不同类型分别保留输入，切换回来可继续编辑。</p></div>
        <div v-if="isCidrDefine" class="field"><label for="policyResourceEntrySource">条目来源</label><select id="policyResourceEntrySource" :value="draft.entrySourceKind" @change="changeEntrySource"><option value="manual">手工填写</option><option value="irr-as-set">AS-SET 自动展开</option></select></div>
        <div id="policyResourceLabelField" class="field"><label for="policyResourceLabel">显示名称 / 备注</label><input id="policyResourceLabel" v-model.trim="draft.label" maxlength="80" required placeholder="例如：上游导入优先级" @input="syncName"></div>
        <div class="field full-width"><label for="policyResourceName">BIRD 名称（自动，可编辑）</label><input id="policyResourceName" v-model.trim="draft.name" pattern="[A-Za-z_][A-Za-z0-9_]*" required @input="nameEdited = true"></div>
        <template v-if="isIrrDefine">
          <div class="field"><label for="policyResourceAsSet">AS-SET</label><input id="policyResourceAsSet" v-model.trim="draft.asSet" required placeholder="AS219332:AS-PMMAN"></div>
          <div class="field"><label for="policyResourceIrrServer">IRR Server</label><input id="policyResourceIrrServer" v-model.trim="draft.server" required placeholder="rr.ntt.net"></div>
          <div class="field full-width"><label for="policyResourceIrrDatabases">IRR Databases（逗号分隔，留空使用服务器默认）</label><input id="policyResourceIrrDatabases" v-model.trim="draft.databases" placeholder="RIPE,ARIN,APNIC"></div>
          <div class="field"><label for="policyResourceRefreshInterval">刷新间隔（秒）</label><input id="policyResourceRefreshInterval" v-model.number="draft.refreshIntervalSeconds" type="number" min="900" max="2592000" required></div>
          <div class="field"><label for="policyResourcePrefixLimit">前缀上限</label><input id="policyResourcePrefixLimit" v-model.number="draft.prefixLimit" type="number" min="1" max="100000" required></div>
          <label class="toggle-row full-width" for="policyResourceMoreSpecific"><span><strong>允许匹配更具体前缀</strong></span><input id="policyResourceMoreSpecific" v-model="draft.allowMoreSpecific" type="checkbox"><i aria-hidden="true"></i></label>
          <p class="protocol-help full-width">测试展开仅查看当前输入的结果；立即同步使用已保存来源，先预检增删，再确认应用。普通保存会复用已保存快照。</p><div class="irr-actions full-width"><button class="secondary-button" type="button" :disabled="pending || resolving" @click="resolvePreview">{{ resolving ? "正在展开" : "测试展开" }}</button><button v-if="editing" class="secondary-button" type="button" :disabled="pending || resolving || previewPending || dirty || conflict || !contextReady" :title="dirty ? '请先预检并应用当前修改，再同步已保存配置' : '同步已保存的来源'" @click="syncNow">立即同步并应用</button><span>{{ draft.source ? `${draft.source.split('\n').filter(Boolean).length} 条前缀` : "尚无快照" }}</span></div>
          <div v-if="draft.sync" class="irr-sync-status full-width" :class="String(draft.sync.status)"><strong>{{ draft.sync.status === 'error' ? '最近同步失败，节点继续使用旧快照' : '动态快照状态' }}</strong><span v-if="draft.sync.lastSuccessAt">最近成功：{{ new Date(String(draft.sync.lastSuccessAt)).toLocaleString() }}</span><span v-if="draft.sync.nextRefreshAt">下次刷新：{{ new Date(String(draft.sync.nextRefreshAt)).toLocaleString() }}</span><span v-if="draft.sync.error">{{ draft.sync.error }}</span></div>
        </template>
        <div id="policyResourceSourceField" class="field full-width">
          <div v-if="isCidrDefine" class="define-prefix-toolbar">
            <span>{{ prefixEntries.length }} 条 · {{ duplicatePrefixCount }} 条重复{{ !isIrrDefine ? ' · 手工最多 256 条' : '' }}</span>
            <div><label v-if="!isIrrDefine" class="secondary-button define-import">导入文本<input type="file" accept=".txt,.csv,text/plain,text/csv" aria-label="导入前缀文本" @change="importPrefixes"></label><button v-if="!isIrrDefine" type="button" class="secondary-button" @click="deduplicatePrefixes">去重并整理</button><button type="button" class="secondary-button" :disabled="!prefixEntries.length" @click="exportPrefixes">导出前缀</button></div>
          </div>
          <label v-if="collection === 'defines' && draft.type === 'expression'" class="define-template">从模板开始<select aria-label="表达式模板" @change="applyTemplate"><option value="">选择模板（可选）</option><option value="150">整数 / Local Preference</option><option value="true">布尔值</option><option value="[64512, 64513]">ASN 集合</option><option value="[(64512, 100), (64512, 200)]">Community 集合</option></select></label>
          <label id="policyResourceSourceLabel" for="policyResourceSource">{{ sourceLabel }}</label>
          <p v-if="isCidrDefine && !isIrrDefine" class="protocol-help">每行一个前缀，也支持逗号分隔。示例：/24 精确匹配、/24+ 含更具体前缀、/24{24,28} 限制长度。</p>
          <div v-if="!isIrrDefine" class="code-input">
            <pre id="policySourceLines" class="code-input-lines" aria-hidden="true">{{ lineNumbers }}</pre>
            <textarea id="policyResourceSource" ref="editor" v-model="draft.source" class="policy-source-editor" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off" :required="!isIrrDefine" :readonly="isIrrDefine" :placeholder="isIrrDefine ? '点击测试展开查看前缀快照' : sourcePlaceholder" @input="sourceEdited = true; updateCursor()" @keydown="handleEditorKeydown" @click="updateCursor" @keyup="updateCursor"></textarea>
            <div class="code-input-status"><span>BIRD</span><span id="policySourcePosition">Ln {{ line }}, Col {{ column }}</span></div>
          </div>
          <div v-if="isIrrDefine" class="define-snapshot">
            <strong>{{ expandedSnapshot ? '测试展开结果 · 尚未应用，以服务端预检为准' : prefixEntries.length ? '已保存前缀快照' : '尚未生成快照' }}</strong>
            <input v-model="prefixSearch" type="search" placeholder="搜索快照前缀" aria-label="搜索快照前缀">
            <p class="protocol-help">匹配 {{ matchingPrefixes.length }} 条，最多展示前 200 条。完整快照可导出。</p>
            <pre tabindex="0">{{ matchingPrefixes.slice(0, 200).join('\n') || (prefixEntries.length ? '没有匹配的前缀，请调整搜索条件' : '尚无快照，点击测试展开查看当前来源') }}</pre>
          </div>
          <div v-if="!isCidrDefine" id="policySourceReferencePanel" class="code-references">
            <div class="code-reference-toolbar"><div class="code-reference-heading"><strong>可用资源</strong><span id="policySourceReferenceCount">{{ search ? `${referenceShown} / ${referenceTotal} 项` : `${referenceTotal} 项` }}</span></div><input id="policySourceReferenceSearch" v-model.trim="search" type="search" autocomplete="off" aria-label="搜索可用策略资源" placeholder="搜索名称、标识符或类型"></div>
            <div id="policySourceReferences" class="code-reference-groups" aria-live="polite">
              <section v-for="group in referenceGroups" :key="group.kind" class="code-reference-group" :aria-label="`可用 ${group.label}`">
                <div class="code-reference-group-heading"><span class="code-reference-kind" :class="group.kind" aria-hidden="true">{{ group.kind === "function" ? "ƒ" : "D" }}</span><strong>{{ group.label }}</strong><span>{{ group.resources.length }}</span></div>
                <div class="code-reference-list"><button v-for="resource in group.resources" :key="resource.id" class="code-reference-button" type="button" :title="`插入 ${policySourceReferenceInsertion(resource, group.kind)}`" @click="insertReference(resource, group.kind)"><span class="code-reference-copy"><strong>{{ dashboard?.inventory[group.kind === "function" ? "functions" : "defines"].find((item) => item.id === resource.id)?.label ?? resource.name }}</strong><code>{{ referenceSymbol(resource, group.kind) }}</code></span><span class="code-reference-meta"><span>{{ referenceLabel(resource, group.kind) }}</span><span>{{ resourceScopeShortLabel(resource) }}</span></span></button></div>
              </section>
              <span v-if="!referenceGroups.length" class="code-reference-empty">{{ referenceTotal ? "没有匹配的资源" : "当前作用域没有可用资源" }}</span>
            </div>
          </div>
        </div>
        <label class="toggle-row full-width" for="policyResourceEnabled"><span><strong>启用资源</strong></span><input id="policyResourceEnabled" v-model="draft.enabled" type="checkbox"><i aria-hidden="true"></i></label>
      </fieldset>
      <div class="policy-review-panels">
        <details class="define-references protocol-disclosure"><summary>引用与影响 · {{ references.length }} 个资源 / {{ affectedNodeIds.length }} 个节点</summary>
          <p class="protocol-help">{{ affectedNodeIds.map(id => nodeNames.get(id) ?? id).join('、') || '尚未选择节点' }}</p>
          <ul v-if="references.length"><li v-for="item in references" :key="`${item.kind}:${item.id}`"><strong>{{ referenceTitle(item.kind) }} · {{ item.label }}</strong><button v-if="item.kind !== 'sessions' && item.kind !== 'ospf'" type="button" class="secondary-button" :disabled="pending" @click="openReference(item)">查看配置</button><span>{{ item.via.length ? `经 ${item.via.join(' → ')}` : '直接引用' }}</span><small>{{ item.nodeIds?.map(id => nodeNames.get(id) ?? id).join('、') ?? '所有节点' }}</small></li></ul>
          <p v-else class="protocol-help">尚未被其它资源引用。创建后可在协议和策略中使用此 {{ kindLabel }}。</p>
        </details>
        <p v-if="editorError" role="alert" tabindex="-1" class="protocol-notice protocol-error">{{ editorError }}</p>
        <div v-if="conflict || (!contextReady && !contextPending)" class="define-conflict-actions"><button type="button" class="secondary-button" :disabled="contextPending" @click="loadContext(conflict)">{{ contextPending ? '正在读取' : '加载最新版本并对比' }}</button></div>
        <section v-if="comparison" class="define-comparison"><h3>版本对比 · 本地草稿仍保留</h3><p v-if="editing && !comparison.resource" class="protocol-help">此 {{ kindLabel }} 已在服务端删除。可保留本地内容，作为新 {{ kindLabel }} 重新预检并确认应用。</p><div><details><summary>打开时的配置</summary><pre>{{ snapshotSummary(initialResource) }}</pre></details><details open><summary>服务端最新配置</summary><pre>{{ comparison.resource ? snapshotSummary(comparison.resource) : editing ? `此 ${kindLabel} 已删除` : '尚未创建' }}</pre></details><details><summary>我的草稿</summary><pre>{{ localSummary() }}</pre></details></div><div class="define-conflict-actions"><button v-if="comparison.resource" type="button" class="secondary-button" @click="adoptRemote">采用最新配置</button><button type="button" class="secondary-button" @click="keepDraft">{{ editing && !comparison.resource ? `保留草稿并作为新 ${kindLabel} 预检` : '保留草稿并重新预检' }}</button></div></section>
        <section v-if="definePreview" id="definePreview" class="protocol-preview" aria-live="polite">
          <h3>{{ definePreview.valid ? '预检通过 · 请确认变更后应用' : '预检未通过 · 请修正后重试' }}</h3>
          <p>影响 {{ definePreview.configs.length }} 个节点 · {{ definePreview.references.length }} 个引用资源<span v-if="'type' in definePreview.resource && definePreview.resource.type !== 'expression'"> · 新增 {{ definePreview.changes.addedCount }} / 移除 {{ definePreview.changes.removedCount }} 条前缀</span></p>
          <details v-if="definePreview.changes.addedCount || definePreview.changes.removedCount"><summary>前缀增删明细（各最多 200 条）</summary><pre>{{ definePreview.changes.removed.map(entry => `- ${entry}`).concat(definePreview.changes.added.map(entry => `+ ${entry}`)).join('\n') }}</pre></details>
          <details v-for="item in definePreview.configs" :key="item.nodeId" :open="!item.validation.ok"><summary>{{ nodeNames.get(item.nodeId) ?? item.nodeId }} · {{ item.validation.ok ? '通过' : '失败' }}</summary><pre v-if="!item.validation.ok" role="alert">{{ item.validation.stderr || item.validation.stdout }}</pre><pre>{{ item.diff }}</pre><details><summary>完整候选配置（含资源片段）</summary><pre>{{ item.config }}</pre></details></details>
        </section>
      </div>
      </div>
      <div class="dialog-actions split-actions define-actions"><button v-if="editing" id="deletePolicyResourceButton" class="text-danger-button" type="button" :disabled="pending || !contextReady || conflict" @click="remove">删除资源</button><button v-if="editorError && !pending && !previewPending && !contextPending" type="button" class="protocol-save-hint define-feedback-link" @click="revealFeedback">{{ reconciliationId ? '应用结果待确认 · 核对已保存配置' : conflict ? '版本冲突 · 查看处理方式' : '操作未完成 · 查看错误详情' }}</button><span v-else class="protocol-save-hint">{{ pending ? '正在预检并应用，请稍候' : previewPending ? '正在预检，可继续修改或取消' : contextPending ? '正在读取版本' : definePreview?.valid ? '当前草稿预检通过' : '先预检查看变更，再确认应用' }}</span><button class="secondary-button" type="button" data-close="policyResourceDialog" :disabled="pending" @click="close">取消</button><button v-if="definePreview?.valid" type="button" class="secondary-button" :disabled="pending || previewPending || !contextReady || conflict" @click="inspectDefine()">重新预检</button><button id="savePolicyResourceButton" class="primary-button" type="submit" :disabled="pending || previewPending || !contextReady || conflict">{{ pending ? '正在应用…' : previewPending ? '预检中…' : definePreview?.valid ? '确认应用' : '预检并查看变更' }}</button></div>
    </form>
  </dialog>
</template>

<style scoped>
.policy-editor-fields { border: 0; padding: 0; margin: 0; min-width: 0; }
.define-editor-dialog { padding: 0; max-width: calc(100vw - 24px); max-height: 92dvh; overflow: clip; }
.define-editor-dialog[open] { display: flex; flex-direction: column; }
.define-editor-dialog form { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: clip; width: 100%; padding: 0; }
.define-editor-dialog .dialog-head { flex-shrink: 0; margin: 0; padding: 20px 24px; border-bottom: 1px solid var(--line); }
.define-editor-dialog .policy-editor-content { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px 24px; }
.define-editor-dialog .define-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex-shrink: 0; margin: 0; padding: 14px 24px; border-top: 1px solid var(--line); background: var(--surface); }
.define-actions .protocol-save-hint { display: block; flex: 1; min-width: 130px; }
.define-actions .define-feedback-link { border: 0; background: transparent; padding: 0; color: var(--red); text-align: left; text-decoration: underline; cursor: pointer; line-height: 1.6; }
.define-heading-status { margin: 6px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.define-intro { margin-bottom: 20px; padding: 14px; background: var(--surface-soft); border: 1px solid var(--line); border-radius: 6px; }
.define-intro p { margin: 0 0 10px; line-height: 1.6; font-size: 12px; }
.define-intro p:last-child { margin: 10px 0 0; }
.define-status { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 11px; color: var(--green-dark); }
.define-prefix-toolbar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 11px; color: var(--muted); }
.define-prefix-toolbar > div, .define-conflict-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.define-prefix-toolbar .secondary-button { font-size: 11px; min-height: 32px; padding: 6px 9px; }
.define-import { position: relative; display: inline-flex; align-items: center; cursor: pointer; overflow: hidden; }
.define-import input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.define-template { display: grid; gap: 8px; margin-bottom: 14px; }
.define-snapshot { display: grid; gap: 10px; }
.define-snapshot pre { max-height: 260px; min-height: 120px; padding: 12px; background: var(--surface-soft); border: 1px solid var(--line); border-radius: 4px; }
.define-references { margin-top: 18px; }
.define-references ul { list-style: none; padding: 0; margin: 8px 0; max-height: 250px; overflow: auto; }
.define-references li { display: grid; gap: 4px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 12px; }
.define-references li span, .define-references li small { color: var(--muted); }
.define-comparison { margin: 16px 0; }
.define-comparison details { padding: 8px; border: 1px solid var(--line); margin-bottom: 8px; }
.define-editor-dialog pre { max-width: 100%; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; line-height: 1.65; }
.define-editor-dialog .protocol-preview { margin-top: 18px; }
.define-editor-dialog .protocol-preview details { margin-top: 12px; }
.define-editor-dialog .protocol-preview summary { cursor: pointer; line-height: 1.6; }
@media (max-width: 600px) {
  .define-editor-dialog .dialog-head, .define-editor-dialog .policy-editor-content { padding: 14px; }
  .define-editor-dialog .dialog-grid { grid-template-columns: minmax(0, 1fr); }
  .define-editor-dialog .define-actions { padding: 10px 12px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .define-actions .protocol-save-hint { grid-column: 1 / -1; grid-row: 1; min-width: 0; }
  .define-actions .primary-button, .define-actions #deletePolicyResourceButton { grid-column: 1 / -1; }
  .define-actions #deletePolicyResourceButton { padding: 3px 0; justify-self: start; width: auto; }
  .define-actions button { width: 100%; min-width: 0; white-space: normal; padding: 9px 6px; }
  .define-editor-dialog .irr-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .define-editor-dialog .code-reference-groups { grid-template-columns: minmax(0, 1fr); }
}
</style>
