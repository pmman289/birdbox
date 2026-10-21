<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import type { ResourceMutationResponse, RpkiEditorContext, RpkiPreviewResponse } from "@birdbox/contracts/api";
import type { RpkiSource, SwitchSetting } from "@birdbox/contracts/inventory";

import { loadDashboard, useDashboardStore } from "../dashboard/dashboard-store";
import MultiNodeScopeField from "../shared/MultiNodeScopeField.vue";
import NullableNumberInput from "../shared/NullableNumberInput.vue";
import OptionalTextInput from "../shared/OptionalTextInput.vue";
import { api, ApiError } from "../shared/api-client";
import { deploymentSummary } from "../shared/deployment";
import { dispatchToast } from "../shared/events";
import { clearFormValidation, presentFormError, validateForm } from "../shared/form-validation";
import { uniqueBirdName } from "../shared/resource-names";

interface RpkiDraft {
  nodeIds: string[] | null;
  label: string;
  name: string;
  sourceType: "file" | "server";
  roa4Table: string | null;
  roa6Table: string | null;
  file4: string | null;
  file6: string | null;
  remote: string;
  port: number;
  localAddress: string | null;
  transport: "tcp" | "ssh";
  authentication: "none" | "md5";
  refresh: number | null;
  retry: number | null;
  expire: number | null;
  minVersion: number | null;
  maxVersion: number | null;
  ignoreMaxLength: SwitchSetting;
  keepRefresh: boolean;
  keepRetry: boolean;
  keepExpire: boolean;
  birdPrivateKey: string | null;
  remotePublicKey: string | null;
  user: string | null;
  enabled: boolean;
}

const dialog = ref<HTMLDialogElement | null>(null);
const form = ref<HTMLFormElement | null>(null);
const editingId = ref<string | null>(null);
const pending = ref(false);
const password = ref("");
const existingPassword = ref(false);
const nameEdited = ref(false);
const roa4Edited = ref(false);
const roa6Edited = ref(false);
const scopeError = ref(false);
const { dashboard } = useDashboardStore();

const draft = reactive<RpkiDraft>({
  nodeIds: null,
  label: "",
  name: "",
  sourceType: "file",
  roa4Table: null,
  roa6Table: null,
  file4: null,
  file6: null,
  remote: "",
  port: 323,
  localAddress: null,
  transport: "tcp",
  authentication: "none",
  refresh: null,
  retry: null,
  expire: null,
  minVersion: null,
  maxVersion: null,
  ignoreMaxLength: "default",
  keepRefresh: false,
  keepRetry: false,
  keepExpire: false,
  birdPrivateKey: null,
  remotePublicKey: null,
  user: null,
  enabled: true,
});

const editing = computed(() => editingId.value !== null);
const inventory = computed(() => dashboard.value?.inventory ?? null);
const nodes = computed(() => inventory.value?.nodes ?? []);
const isServer = computed(() => draft.sourceType === "server");
const isSsh = computed(() => isServer.value && draft.transport === "ssh");
const usesMd5 = computed(() => isServer.value && !isSsh.value && draft.authentication === "md5");

const fieldMappings = [
  [/可用范围|不存在的节点|作用域不兼容/, "rpkiNodeScope"],
  [/RPKI 资源名称/, "rpkiLabel"],
  [/RPKI 协议名称|本地 ROA 资源名称|BIRD 全局标识符冲突/, "rpkiName"],
  [/ROA Table/, "rpkiRoa4Table"],
  [/IPv4 ROA 文件/, "rpkiFile4"],
  [/IPv6 ROA 文件/, "rpkiFile6"],
  [/RPKI 服务器/, "rpkiRemote"],
  [/RPKI 本地地址/, "rpkiLocalAddress"],
  [/RPKI TCP-MD5.*密码/, "rpkiPassword"],
  [/RPKI 版本范围|最低版本/, "rpkiMinVersion"],
  [/最高版本/, "rpkiMaxVersion"],
  [/RPKI SSH.*私钥/, "rpkiBirdPrivateKey"],
  [/RPKI SSH.*公钥/, "rpkiRemotePublicKey"],
  [/RPKI SSH.*用户名|RPKI SSH/, "rpkiUser"],
] as const;

function syncNames(): void {
  if (editing.value || !draft.label || !inventory.value) return;
  if (!nameEdited.value) draft.name = uniqueBirdName(inventory.value, "rpki", draft.label, [], 60);
  if (!roa4Edited.value) draft.roa4Table = uniqueBirdName(inventory.value, "roa4", draft.label);
  if (!roa6Edited.value) draft.roa6Table = uniqueBirdName(inventory.value, "roa6", draft.label);
}


let ports = { tcp: 323, ssh: 22 }, previousTransport: "tcp" | "ssh" = "tcp";
function changeTransport(): void {
  ports[previousTransport] = draft.port;
  draft.port = ports[draft.transport];
  previousTransport = draft.transport;
}

function open(resource: RpkiSource | null, replace = false): void {
  if (pending.value || (!replace && !canSwitch())) return;
  invalidate(); contextGeneration++;
  contextPending.value = false; revision.value = null; conflict.value = false; comparison.value = null; editorError.value = "";
  initial.value = resource ? JSON.parse(JSON.stringify(resource)) as RpkiSource : null;
  editingId.value = resource?.id ?? null;
  Object.assign(draft, {
    nodeIds: resource ? resource.nodeIds === null ? null : [...resource.nodeIds] : [dashboard.value?.node?.id ?? nodes.value[0]?.id].filter((id): id is string => Boolean(id)),
    label: resource?.label ?? "",
    name: resource?.name ?? "",
    sourceType: resource?.sourceType ?? "server",
    roa4Table: resource?.roa4Table ?? null,
    roa6Table: resource?.roa6Table ?? null,
    file4: resource?.sourceType === "file" ? resource.file4 : null,
    file6: resource?.sourceType === "file" ? resource.file6 : null,
    remote: resource?.sourceType === "server" ? resource.remote : "",
    port: resource?.sourceType === "server" ? resource.port : 323,
    localAddress: resource?.sourceType === "server" ? resource.localAddress : null,
    transport: resource?.sourceType === "server" ? resource.transport : "tcp",
    authentication: resource?.sourceType === "server" ? resource.authentication : "none",
    refresh: resource?.sourceType === "server" ? resource.refresh : null,
    retry: resource?.sourceType === "server" ? resource.retry : null,
    expire: resource?.sourceType === "server" ? resource.expire : null,
    minVersion: resource?.sourceType === "server" ? resource.minVersion : null,
    maxVersion: resource?.sourceType === "server" ? resource.maxVersion : null,
    ignoreMaxLength: resource?.sourceType === "server" ? resource.ignoreMaxLength : "default",
    keepRefresh: resource?.sourceType === "server" ? resource.keepRefresh : false,
    keepRetry: resource?.sourceType === "server" ? resource.keepRetry : false,
    keepExpire: resource?.sourceType === "server" ? resource.keepExpire : false,
    birdPrivateKey: resource?.sourceType === "server" ? resource.birdPrivateKey : null,
    remotePublicKey: resource?.sourceType === "server" ? resource.remotePublicKey : null,
    user: resource?.sourceType === "server" ? resource.user : null,
    enabled: resource?.enabled ?? true,
  });
  password.value = "";
  existingPassword.value = resource?.sourceType === "server" && Boolean(resource.password);
  nameEdited.value = Boolean(resource);
  roa4Edited.value = Boolean(resource);
  roa6Edited.value = Boolean(resource);
  scopeError.value = false;
  ipv4.value = resource ? Boolean(resource.roa4Table) : true;
  ipv6.value = resource ? Boolean(resource.roa6Table) : true;
  ports = { tcp: resource?.sourceType === "server" && resource.transport === "tcp" ? resource.port : 323, ssh: resource?.sourceType === "server" && resource.transport === "ssh" ? resource.port : 22 };
  previousTransport = draft.transport;
  baseline.value = signature.value;
  if (form.value) clearFormValidation(form.value);
  if (!dialog.value?.open) dialog.value?.showModal();
  void nextTick(() => {
    const content = dialog.value?.querySelector<HTMLElement>(".rpki-editor-content"); if (content) content.scrollTop = 0;
    document.querySelector<HTMLInputElement>("#rpkiLabel")?.focus({ preventScroll: true });
  });
  void loadContext();
}

function close(): void {
  if (!canSwitch()) return;
  contextGeneration++; invalidate(); dialog.value?.close();
}

function payload(): Record<string, unknown> {
  const base = {
    nodeIds: draft.nodeIds,
    label: draft.label,
    name: draft.name,
    sourceType: draft.sourceType,
    roa4Table: ipv4.value ? draft.roa4Table : null,
    roa6Table: ipv6.value ? draft.roa6Table : null,
    enabled: draft.enabled,
  };
  if (draft.sourceType === "file") return { ...base, file4: ipv4.value ? draft.file4 : null, file6: ipv6.value ? draft.file6 : null };
  const passwordPayload = isSsh.value || draft.authentication !== "md5" ? { password: null } : password.value
    ? { password: password.value }
    : existingPassword.value && draft.authentication === "md5"
      ? {}
      : { password: null };
  return {
    ...base,
    remote: draft.remote,
    port: draft.port,
    localAddress: draft.localAddress,
    transport: draft.transport,
    authentication: isSsh.value ? "none" : draft.authentication,
    ...passwordPayload,
    refresh: draft.refresh,
    retry: draft.retry,
    expire: draft.expire,
    minVersion: draft.minVersion,
    maxVersion: draft.maxVersion,
    ignoreMaxLength: draft.ignoreMaxLength,
    keepRefresh: draft.keepRefresh,
    keepRetry: draft.keepRetry,
    keepExpire: draft.keepExpire,
    birdPrivateKey: draft.transport === "ssh" ? draft.birdPrivateKey : null,
    remotePublicKey: draft.transport === "ssh" ? draft.remotePublicKey : null,
    user: draft.transport === "ssh" ? draft.user : null,
  };
}

const ipv4 = ref(true), ipv6 = ref(true), baseline = ref("");
const signature = computed(() => JSON.stringify({ draft, password: password.value, ipv4: ipv4.value, ipv6: ipv6.value }));
const dirty = computed(() => signature.value !== baseline.value);
const revision = ref<number | null>(null), contextPending = ref(false), previewPending = ref(false), editorError = ref(""), conflict = ref(false);
const preview = ref<RpkiPreviewResponse | null>(null), comparison = ref<RpkiEditorContext | null>(null), initial = ref<RpkiSource | null>(null);
const references = ref<RpkiEditorContext["references"]>([]);
const affectedIds = computed(() => [...new Set([...(initial.value ? initial.value.nodeIds ?? nodes.value.map(n => n.id) : []), ...(draft.nodeIds ?? nodes.value.map(n => n.id))])]);
let previewGeneration = 0, contextGeneration = 0;
let previewController: AbortController | null = null;
function invalidate() { previewGeneration++; previewController?.abort(); previewController = null; preview.value = null; previewPending.value = false; }
watch(signature, invalidate, { flush: "sync" });
function canSwitch() { return !pending.value && !(dialog.value?.open && dirty.value && !window.confirm("放弃尚未保存的 RPKI 修改？")); }
function safeSummary(value: unknown): string { return JSON.stringify(value, (key, v) => /^(password|birdPrivateKey|remotePublicKey)$/i.test(key) && v ? "********" : v, 2); }
async function loadContext(compare = false) {
  const request = ++contextGeneration; contextPending.value = true; editorError.value = "";
  try {
    const result = await api<RpkiEditorContext>(`/api/rpki/editor-context${editingId.value ? `?id=${encodeURIComponent(editingId.value)}` : ""}`);
    if (request !== contextGeneration || !dialog.value?.open) return;
    references.value = result.references;
    if (compare || JSON.stringify(result.resource) !== JSON.stringify(initial.value)) { comparison.value = result; conflict.value = true; editorError.value = "服务端配置已变化，请对比后继续。本地内容已保留。"; }
    else revision.value = result.inventoryRevision;
  } catch (error) { if (request === contextGeneration) editorError.value = error instanceof Error ? error.message : "读取编辑版本失败"; }
  finally { if (request === contextGeneration) contextPending.value = false; }
}
function resolveConflict(keep: boolean) {
  const latest = comparison.value; if (!latest) return;
  if (!keep && latest.resource) { open(latest.resource, true); return; }
  revision.value = latest.inventoryRevision;
  initial.value = latest.resource;
  if (!latest.resource) {
    editingId.value = null; baseline.value = ""; existingPassword.value = false;
    // Deleted resources no longer have server-side credentials to restore.
    if (draft.birdPrivateKey === "********") draft.birdPrivateKey = null;
    if (draft.remotePublicKey === "********") draft.remotePublicKey = null;
  }
  conflict.value = false; comparison.value = null; editorError.value = ""; invalidate();
}
function validate(): boolean {
  scopeError.value = draft.nodeIds !== null && draft.nodeIds.length === 0;
  if (scopeError.value || !affectedIds.value.length) { editorError.value = "请至少选择一个下发节点"; return false; }
  if (!ipv4.value && !ipv6.value) { editorError.value = "请至少启用 IPv4 或 IPv6 一个地址族"; return false; }
  return Boolean(form.value && validateForm(form.value));
}
async function inspect() {
  if (pending.value || contextPending.value || revision.value === null || conflict.value || !validate()) return;
  invalidate(); const request = previewGeneration; previewController = new AbortController(); const signal = previewController.signal;
  previewPending.value = true; editorError.value = "";
  try {
    const result = await api<RpkiPreviewResponse>("/api/rpki/preview", { method: "POST", body: JSON.stringify({ ...payload(), ...(editingId.value ? { id: editingId.value } : {}), inventoryRevision: revision.value }), signal, mutationWait: false, timeoutMs: 120_000 });
    if (request !== previewGeneration || signal.aborted) return;
    preview.value = result;
    await nextTick(); dialog.value?.querySelector("#rpkiPreview")?.scrollIntoView({ block: "start" });
  } catch (error) { if (request === previewGeneration && !signal.aborted) showError(error); }
  finally { if (request === previewGeneration) previewPending.value = false; }
}
function showError(error: unknown) {
  editorError.value = error instanceof Error ? error.message : "操作失败，草稿已保留";
  if (error instanceof ApiError && error.code === "STATE_CONFLICT") conflict.value = true;
  if (form.value) presentFormError(form.value, error, fieldMappings);
}
async function save(): Promise<void> {
  if (pending.value || previewPending.value || contextPending.value || conflict.value || revision.value === null) return;
  if (!preview.value?.valid) { await inspect(); return; }
  if (!window.confirm(`确认将 RPKI 变更应用到 ${preview.value.configs.length} 个节点？`)) return;
  pending.value = true;
  try {
    const result = await api<ResourceMutationResponse<RpkiSource>>(editingId.value ? `/api/rpki/${encodeURIComponent(editingId.value)}` : "/api/rpki", {
      method: editingId.value ? "PUT" : "POST", body: JSON.stringify({ ...preview.value.resource, mode: "apply", inventoryRevision: preview.value.inventoryRevision, previewId: preview.value.previewId, candidateHash: preview.value.candidateHash }),
    });
    await loadDashboard(draft.nodeIds?.[0] ?? dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null).catch(() => dispatchToast("应用成功，请刷新资源列表", "error"));
    dialog.value?.close(); contextGeneration++; invalidate();
    dispatchToast(`RPKI 已保存，${deploymentSummary(result.deployment)}`, "success");
  } catch (error) { invalidate(); showError(error); }
  finally { pending.value = false; }
}
async function remove(): Promise<void> {
  if (pending.value || !editingId.value || revision.value === null || conflict.value) return;
  if (!window.confirm(`删除 RPKI ${draft.name}？将从关联节点移除此来源，未保存修改会被放弃。`)) return;
  pending.value = true;
  try {
    await api(`/api/rpki/${encodeURIComponent(editingId.value)}`, { method: "DELETE", body: JSON.stringify({ inventoryRevision: revision.value }) });
    await loadDashboard(dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null).catch(() => dispatchToast("删除成功，请刷新资源列表", "error"));
    dialog.value?.close(); contextGeneration++; invalidate(); dispatchToast("RPKI 已删除", "success");
  } catch (error) { showError(error); }
  finally { pending.value = false; }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dialog.value?.open && dirty.value) { event.preventDefault(); event.returnValue = ""; } }

function handleCreate(event: CustomEvent<{ kind: string }>): void {
  if (event.detail.kind === "rpki") open(null);
}

function handleEdit(event: CustomEvent<{ kind: string; id: string }>): void {
  if (event.detail.kind !== "rpki") return;
  const resource = inventory.value?.rpki.find((item) => item.id === event.detail.id) ?? null;
  if (resource) open(resource);
}

onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("birdbox:resource-create", handleCreate);
  window.addEventListener("birdbox:resource-edit", handleEdit);
});
onBeforeUnmount(() => {
  contextGeneration++; invalidate();
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("birdbox:resource-create", handleCreate);
  window.removeEventListener("birdbox:resource-edit", handleEdit);
});
</script>

<template>
  <dialog id="rpkiDialog" ref="dialog" class="editor-dialog protocol-editor rpki-editor-dialog" aria-labelledby="rpkiDialogTitle" @cancel.prevent="close">
    <header class="dialog-head protocol-dialog-head"><span class="dialog-icon">R</span><div><p class="eyebrow">BIRD RPKI</p><h2 id="rpkiDialogTitle">{{ editing ? '编辑 RPKI 资源' : '添加 RPKI 资源' }}</h2><p class="protocol-description">提供 ROA 数据供 Filter 的 roa_check() 使用；添加来源本身不会过滤 BGP 路由。</p><small class="rpki-edit-state">{{ editing ? dirty ? '有未保存修改' : '已保存' : '尚未创建' }} · 影响 {{ affectedIds.length }} 个节点 · {{ draft.name }}</small></div><button type="button" class="secondary-button compact-command protocol-close" :disabled="pending" @click="close">关闭</button></header>
    <form id="rpkiForm" ref="form" novalidate :aria-busy="pending" @submit.prevent="save">
      <div class="rpki-editor-content">
        <p v-if="contextPending" role="status">正在加载最新编辑版本…</p>
        <p v-if="editorError" class="protocol-notice protocol-error" role="alert">{{ editorError }}</p>
        <section v-if="conflict || (revision === null && !contextPending)" class="protocol-notice" aria-label="RPKI 库存冲突对比"><h3>草稿已保留</h3><button type="button" class="secondary-button" :disabled="contextPending || pending" @click="loadContext(true)">加载最新版本并对比</button><template v-if="comparison"><details><summary>打开时的配置</summary><pre>{{ safeSummary(initial) }}</pre></details><details open><summary>服务端最新配置</summary><pre>{{ comparison.resource ? safeSummary(comparison.resource) : '资源已被删除' }}</pre></details><details><summary>本地草稿</summary><pre>{{ safeSummary(payload()) }}</pre></details><button v-if="comparison.resource" class="secondary-button" type="button" @click="resolveConflict(false)">使用最新配置</button><button class="secondary-button" type="button" @click="resolveConflict(true)">{{ comparison.resource ? '保留草稿，重新预检' : '保留草稿，作为新资源预检' }}</button></template></section>
        <fieldset class="rpki-fields" :disabled="pending || contextPending || revision === null || conflict">
          <section class="protocol-section"><div class="protocol-section-title"><span>1</span><div><h3>来源与下发节点</h3><p>RPKI-RTR 自动获取验证缓存；本地文件适合已维护 ROA 文件的节点。</p></div></div><div class="dialog-grid">
            <div class="field"><label for="rpkiLabel">显示名称</label><input id="rpkiLabel" v-model.trim="draft.label" maxlength="80" required @input="syncNames"></div>
            <div class="field"><label for="rpkiName">BIRD 名称（自动，可编辑）</label><input id="rpkiName" v-model.trim="draft.name" pattern="[A-Za-z_][A-Za-z0-9_]*" :maxlength="isServer ? 64 : 60" required @input="nameEdited = true"></div>
            <MultiNodeScopeField id="rpkiNodeScope" v-model="draft.nodeIds" :nodes="nodes" :invalid="scopeError" @change="scopeError = false" />
            <div class="field full-width"><label for="rpkiSourceType">来源类型</label><select id="rpkiSourceType" v-model="draft.sourceType"><option value="server">RPKI-RTR 服务器</option><option value="file">本地 ROA 文件</option></select></div>
            <div class="full-width"><span class="field-label">接收的 ROA 地址族</span><div class="address-family-options" role="group" aria-label="RPKI 地址族"><label><input v-model="ipv4" type="checkbox" aria-label="启用 IPv4 ROA"><span>IPv4</span></label><label><input v-model="ipv6" type="checkbox" aria-label="启用 IPv6 ROA"><span>IPv6</span></label></div><p class="protocol-help">未勾选的地址族不会声明 ROA Table。切换不会丢失已填写的表名或文件路径。</p></div>
            <div v-if="ipv4" class="field"><label for="rpkiRoa4Table">IPv4 ROA Table（自动，可编辑）</label><OptionalTextInput id="rpkiRoa4Table" v-model="draft.roa4Table" required pattern="[A-Za-z_][A-Za-z0-9_]*" @input="roa4Edited = true" /></div>
            <div v-if="ipv6" class="field"><label for="rpkiRoa6Table">IPv6 ROA Table（自动，可编辑）</label><OptionalTextInput id="rpkiRoa6Table" v-model="draft.roa6Table" required pattern="[A-Za-z_][A-Za-z0-9_]*" @input="roa6Edited = true" /></div>
          </div><label class="toggle-row" for="rpkiEnabled"><span><strong>启用资源</strong><small>确认应用后{{ draft.enabled ? '加载来源' : '停用来源' }}；被策略引用时需先处理依赖。</small></span><input id="rpkiEnabled" v-model="draft.enabled" type="checkbox"><i aria-hidden="true"></i></label></section>
          <section class="protocol-section"><div class="protocol-section-title"><span>2</span><div><h3>{{ isServer ? '验证缓存连接' : '节点 ROA 文件' }}</h3><p>{{ isServer ? '填写节点可访问的缓存地址。默认 TCP 323，SSH 默认 22。' : '文件必须已存在于每个下发节点，内容为 BIRD ROA route 声明；控制器不上传该文件。' }}</p></div></div>
            <div v-if="!isServer" class="dialog-grid"><div v-if="ipv4" id="rpkiFileFields" class="field full-width"><label for="rpkiFile4">IPv4 ROA 文件</label><OptionalTextInput id="rpkiFile4" v-model="draft.file4" required placeholder="/etc/bird/roa4.conf" /><small class="field-help">例如：route 203.0.113.0/24 max 24 as 64512;</small></div><div v-if="ipv6" id="rpkiFile6Field" class="field full-width"><label for="rpkiFile6">IPv6 ROA 文件</label><OptionalTextInput id="rpkiFile6" v-model="draft.file6" required placeholder="/etc/bird/roa6.conf" /><small class="field-help">例如：route 2001:db8::/32 max 48 as 64512;</small></div></div>
            <div v-else id="rpkiServerFields" class="dialog-grid">
              <div class="field full-width"><label for="rpkiRemote">RPKI 服务器</label><input id="rpkiRemote" v-model.trim="draft.remote" placeholder="validator.example 或 192.0.2.10" required></div>
              <div class="field"><label for="rpkiTransport">传输</label><select id="rpkiTransport" v-model="draft.transport" @change="changeTransport"><option value="tcp">TCP</option><option value="ssh">SSH</option></select></div><div class="field"><label for="rpkiPort">端口</label><input id="rpkiPort" v-model.number="draft.port" type="number" min="1" max="65535" required></div>
              <div v-if="!isSsh" class="field"><label for="rpkiAuthentication">TCP 认证</label><select id="rpkiAuthentication" v-model="draft.authentication"><option value="none">无认证</option><option value="md5">TCP-MD5</option></select></div><div v-if="usesMd5" id="rpkiPasswordField" class="field"><label for="rpkiPassword">TCP-MD5 密码</label><input id="rpkiPassword" v-model="password" type="password" maxlength="80" autocomplete="new-password" :placeholder="existingPassword ? '留空保持不变' : 'TCP-MD5 密码'" :required="!existingPassword"></div>
              <div v-if="isSsh" id="rpkiSshFields" class="full-width dialog-grid"><div class="field full-width"><label for="rpkiBirdPrivateKey">SSH 私钥</label><OptionalTextInput id="rpkiBirdPrivateKey" v-model="draft.birdPrivateKey" required placeholder="/var/lib/bird/.ssh/id_rsa" /></div><div class="field full-width"><label for="rpkiRemotePublicKey">服务器公钥</label><OptionalTextInput id="rpkiRemotePublicKey" v-model="draft.remotePublicKey" required placeholder="/var/lib/bird/.ssh/validator.pub" /></div><div class="field"><label for="rpkiUser">SSH 用户</label><OptionalTextInput id="rpkiUser" v-model="draft.user" required /></div><p class="protocol-help full-width">路径指向受管节点上的密钥文件。已保存路径显示为掩码，留存掩码会保留原值。</p></div>
            </div>
          </section>
          <details v-if="isServer" class="protocol-disclosure rpki-advanced"><summary>高级连接与 RTR 参数<span class="protocol-policy-summary">本地地址、定时器、版本和 Max Length</span></summary><div class="dialog-grid">
            <div class="field full-width"><label for="rpkiLocalAddress">本地地址</label><OptionalTextInput id="rpkiLocalAddress" v-model="draft.localAddress" placeholder="留空由节点选择源地址" /></div>
            <div v-for="setting in (['refresh', 'retry', 'expire'] as const)" :key="setting" class="field"><label :for="`rpki${setting[0]!.toUpperCase()}${setting.slice(1)}`">{{ setting }}（秒）</label><NullableNumberInput :id="`rpki${setting[0]!.toUpperCase()}${setting.slice(1)}`" v-model="draft[setting]" :min="setting === 'expire' ? 600 : 1" :max="setting === 'refresh' ? 86400 : setting === 'retry' ? 7200 : 172800" placeholder="使用 BIRD 默认值" /><label class="protocol-checkbox"><input v-if="setting === 'refresh'" id="rpkiKeepRefresh" v-model="draft.keepRefresh" type="checkbox" :disabled="draft.refresh === null"><input v-else-if="setting === 'retry'" id="rpkiKeepRetry" v-model="draft.keepRetry" type="checkbox" :disabled="draft.retry === null"><input v-else id="rpkiKeepExpire" v-model="draft.keepExpire" type="checkbox" :disabled="draft.expire === null">保持本地值（keep）</label></div>
            <div class="field"><label for="rpkiMinVersion">最低 RTR 版本</label><NullableNumberInput id="rpkiMinVersion" v-model="draft.minVersion" min="0" max="2" placeholder="默认 0" /></div><div class="field"><label for="rpkiMaxVersion">最高 RTR 版本</label><NullableNumberInput id="rpkiMaxVersion" v-model="draft.maxVersion" min="0" max="2" placeholder="默认 2" /></div>
            <div class="field"><label for="rpkiIgnoreMaxLength">Max Length</label><select id="rpkiIgnoreMaxLength" v-model="draft.ignoreMaxLength"><option value="default">遵循 ROA</option><option value="on">忽略</option><option value="off">不忽略</option></select></div>
          </div><p class="protocol-help">版本和传输能力以每个节点的 BIRD 构建为准，预检失败不会保存配置。</p></details>
        </fieldset>
        <details v-if="references.length" class="protocol-disclosure"><summary>引用此来源的资源 · {{ references.length }} 项</summary><p v-for="item in references" :key="`${item.kind}:${item.id}`" class="protocol-help">{{ item.kind }} · {{ item.label }} · {{ item.symbols.join('、') }}</p></details>
        <section v-if="preview" id="rpkiPreview" class="protocol-preview" aria-live="polite"><h3>{{ preview.valid ? '预检通过 · 确认后应用' : '预检未通过 · 修正后重试' }}</h3><p>影响 {{ preview.configs.length }} 个节点 · {{ preview.references.length }} 个直接引用资源</p><article v-for="item in preview.configs" :key="item.nodeId"><h4>{{ nodes.find(n => n.id === item.nodeId)?.name ?? item.nodeId }} · {{ item.validation.ok ? '通过' : '失败' }}</h4><p v-if="!item.validation.ok" class="protocol-error" role="alert">{{ item.validation.stderr || item.validation.stdout }}</p><details open><summary>配置差异</summary><pre>{{ item.diff }}</pre></details><details><summary>完整候选配置</summary><pre>{{ item.config }}</pre></details></article></section>
      </div>
      <footer class="dialog-actions protocol-editor-actions"><button v-if="editing" id="deleteRPKIButton" class="text-danger-button" type="button" :disabled="pending || contextPending || conflict || revision === null" @click="remove">删除 RPKI</button><span class="protocol-save-hint">{{ pending ? '正在预检并应用，请等待结果' : previewPending ? '正在预检，可继续修改或取消' : preview?.valid ? '确认后才下发远端配置' : '先查看差异，再确认应用' }}</span><button class="secondary-button" type="button" data-close="rpkiDialog" :disabled="pending" @click="close">取消</button><button v-if="preview?.valid" class="secondary-button" type="button" :disabled="pending || previewPending" @click="inspect">重新预检</button><button id="saveRpkiButton" class="primary-button" type="submit" :disabled="pending || previewPending || contextPending || revision === null || conflict">{{ pending ? '正在应用…' : previewPending ? '预检中…' : preview?.valid ? '确认应用' : '预检并查看变更' }}</button></footer>
    </form>
  </dialog>
</template>
<style scoped>
.rpki-editor-dialog { width: min(920px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: clip; padding: 0; }
.rpki-editor-dialog[open], .rpki-editor-dialog form { display: flex; flex-direction: column; min-height: 0; }
.rpki-editor-dialog form { flex: 1; overflow: clip; padding: 0; }
.rpki-editor-content { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px 24px; }
.rpki-fields { display: grid; gap: 18px; margin: 0; padding: 0; border: 0; min-width: 0; }
.rpki-edit-state { display: block; margin-top: 8px; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.rpki-editor-content pre { white-space: pre-wrap; overflow-wrap: anywhere; overflow: auto; max-height: 360px; font-size: 11px; }
.rpki-editor-content > details, .rpki-editor-content > section { margin-top: 18px; }
.rpki-editor-content .dialog-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 600px) { .rpki-editor-dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); } .rpki-editor-content { padding: 14px; } .rpki-editor-content .dialog-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
