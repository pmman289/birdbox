<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";

import type { ResourceMutationResponse } from "@birdbox/contracts/api";
import type { RpkiSource, SwitchSetting } from "@birdbox/contracts/inventory";

import { loadDashboard, useDashboardStore } from "../dashboard/dashboard-store";
import MultiNodeScopeField from "../shared/MultiNodeScopeField.vue";
import NullableNumberInput from "../shared/NullableNumberInput.vue";
import OptionalTextInput from "../shared/OptionalTextInput.vue";
import { api } from "../shared/api-client";
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
  [/可用范围|不存在的节点/, "rpkiNodeScope"],
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

function changeSourceType(): void {
  if (draft.sourceType === "file") {
    draft.authentication = "none";
    password.value = "";
  }
}

function changeTransport(): void {
  if (draft.transport === "ssh") {
    draft.authentication = "none";
    password.value = "";
  } else {
    draft.birdPrivateKey = null;
    draft.remotePublicKey = null;
    draft.user = null;
  }
}

function open(resource: RpkiSource | null): void {
  editingId.value = resource?.id ?? null;
  Object.assign(draft, {
    nodeIds: resource?.nodeIds === null || !resource ? null : [...resource.nodeIds],
    label: resource?.label ?? "",
    name: resource?.name ?? "",
    sourceType: resource?.sourceType ?? "file",
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
  if (form.value) clearFormValidation(form.value);
  if (!dialog.value?.open) dialog.value?.showModal();
  void nextTick(() => document.querySelector<HTMLInputElement>("#rpkiLabel")?.focus());
}

function close(): void {
  if (!pending.value) dialog.value?.close();
}

function payload(): Record<string, unknown> {
  const base = {
    nodeIds: draft.nodeIds,
    label: draft.label,
    name: draft.name,
    sourceType: draft.sourceType,
    roa4Table: draft.roa4Table,
    roa6Table: draft.roa6Table,
    enabled: draft.enabled,
  };
  if (draft.sourceType === "file") return { ...base, file4: draft.file4, file6: draft.file6 };
  const passwordPayload = password.value
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
    authentication: draft.authentication,
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

async function save(): Promise<void> {
  scopeError.value = draft.nodeIds !== null && draft.nodeIds.length === 0;
  if (scopeError.value) {
    document.querySelector<HTMLElement>("#rpkiNodeScope")?.focus();
    dispatchToast("请至少选择一个可用节点", "error");
    return;
  }
  if (!form.value || !validateForm(form.value)) return;
  pending.value = true;
  const id = editingId.value;
  try {
    const result = await api<ResourceMutationResponse<RpkiSource>>(id ? `/api/rpki/${encodeURIComponent(id)}` : "/api/rpki", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload()),
    });
    await loadDashboard(draft.nodeIds?.[0] ?? dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null);
    window.dispatchEvent(new CustomEvent("birdbox:resource-tab-select", { detail: { target: "rpki" } }));
    dialog.value?.close();
    dispatchToast(`${id ? "RPKI 已更新" : "RPKI 已添加"}，${deploymentSummary(result.deployment)}`, "success");
  } catch (error) {
    presentFormError(form.value, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

async function remove(): Promise<void> {
  const resource = editingId.value ? inventory.value?.rpki.find((item) => item.id === editingId.value) : null;
  if (!resource || !window.confirm(`删除 RPKI ${resource.name}？`)) return;
  pending.value = true;
  try {
    await api(`/api/rpki/${encodeURIComponent(resource.id)}`, { method: "DELETE" });
    await loadDashboard(dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null);
    window.dispatchEvent(new CustomEvent("birdbox:resource-tab-select", { detail: { target: "rpki" } }));
    dialog.value?.close();
    dispatchToast("RPKI 已删除", "success");
  } catch (error) {
    presentFormError(form.value!, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

function handleCreate(event: CustomEvent<{ kind: string }>): void {
  if (event.detail.kind === "rpki") open(null);
}

function handleEdit(event: CustomEvent<{ kind: string; id: string }>): void {
  if (event.detail.kind !== "rpki") return;
  const resource = inventory.value?.rpki.find((item) => item.id === event.detail.id) ?? null;
  if (resource) open(resource);
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
  <dialog id="rpkiDialog" ref="dialog" class="editor-dialog" aria-labelledby="rpkiDialogTitle" @cancel.prevent="close">
    <form id="rpkiForm" ref="form" novalidate :aria-busy="pending" @submit.prevent="save">
      <div class="dialog-head"><span class="dialog-icon">R</span><div><p class="eyebrow">BIRD RPKI</p><h2 id="rpkiDialogTitle">{{ editing ? "编辑 RPKI 资源" : "添加 RPKI 资源" }}</h2></div></div>
      <div class="dialog-grid">
        <MultiNodeScopeField id="rpkiNodeScope" v-model="draft.nodeIds" :nodes="nodes" :invalid="scopeError" @change="scopeError = false" />
        <div class="field"><label for="rpkiLabel">显示名称</label><input id="rpkiLabel" v-model.trim="draft.label" maxlength="80" required @input="syncNames"></div>
        <div class="field"><label for="rpkiName">BIRD 名称（自动，可编辑）</label><input id="rpkiName" v-model.trim="draft.name" pattern="[A-Za-z_][A-Za-z0-9_]*" maxlength="64" required @input="nameEdited = true"></div>
        <div class="field full-width"><label for="rpkiSourceType">来源类型</label><select id="rpkiSourceType" v-model="draft.sourceType" @change="changeSourceType"><option value="file">本地 ROA 文件</option><option value="server">RPKI-RTR 服务器</option></select></div>
        <div class="field"><label for="rpkiRoa4Table">IPv4 ROA Table（自动，可编辑）</label><OptionalTextInput id="rpkiRoa4Table" v-model="draft.roa4Table" pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="可选" @input="roa4Edited = true" /></div>
        <div class="field"><label for="rpkiRoa6Table">IPv6 ROA Table（自动，可编辑）</label><OptionalTextInput id="rpkiRoa6Table" v-model="draft.roa6Table" pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="可选" @input="roa6Edited = true" /></div>
        <template v-if="!isServer">
          <div id="rpkiFileFields" class="field full-width"><label for="rpkiFile4">IPv4 ROA 文件</label><OptionalTextInput id="rpkiFile4" v-model="draft.file4" placeholder="/etc/bird/roa4.conf" /></div>
          <div id="rpkiFile6Field" class="field full-width"><label for="rpkiFile6">IPv6 ROA 文件</label><OptionalTextInput id="rpkiFile6" v-model="draft.file6" placeholder="/etc/bird/roa6.conf" /></div>
        </template>
        <div v-else id="rpkiServerFields" class="full-width">
          <div class="option-grid">
            <div class="field full-width"><label for="rpkiRemote">RPKI 服务器</label><input id="rpkiRemote" v-model.trim="draft.remote" placeholder="127.0.0.1 或 validator.example" required></div>
            <div class="field"><label for="rpkiPort">端口</label><input id="rpkiPort" v-model.number="draft.port" type="number" min="1" max="65535" required></div>
            <div class="field"><label for="rpkiLocalAddress">本地地址</label><OptionalTextInput id="rpkiLocalAddress" v-model="draft.localAddress" placeholder="可选" /></div>
            <div class="field"><label for="rpkiTransport">传输</label><select id="rpkiTransport" v-model="draft.transport" @change="changeTransport"><option value="tcp">TCP</option><option value="ssh">SSH</option></select></div>
            <div class="field"><label for="rpkiAuthentication">TCP 认证</label><select id="rpkiAuthentication" v-model="draft.authentication" :disabled="isSsh"><option value="none">无认证</option><option value="md5">TCP-MD5</option></select></div>
            <div v-if="usesMd5" id="rpkiPasswordField" class="field"><label for="rpkiPassword">TCP-MD5 密码</label><input id="rpkiPassword" v-model="password" type="password" maxlength="80" autocomplete="new-password" :placeholder="existingPassword ? '留空保持不变' : 'TCP-MD5 密码'" :required="!existingPassword"></div>
            <div class="field"><label for="rpkiRefresh">Refresh</label><NullableNumberInput id="rpkiRefresh" v-model="draft.refresh" min="1" max="86400" placeholder="默认 3600" /></div>
            <div class="field"><label for="rpkiRetry">Retry</label><NullableNumberInput id="rpkiRetry" v-model="draft.retry" min="1" max="7200" placeholder="默认 600" /></div>
            <div class="field"><label for="rpkiExpire">Expire</label><NullableNumberInput id="rpkiExpire" v-model="draft.expire" min="600" max="172800" placeholder="默认 7200" /></div>
            <div class="field"><label for="rpkiMinVersion">最低 RTR 版本</label><NullableNumberInput id="rpkiMinVersion" v-model="draft.minVersion" min="0" max="2" placeholder="默认 0" /></div>
            <div class="field"><label for="rpkiMaxVersion">最高 RTR 版本</label><NullableNumberInput id="rpkiMaxVersion" v-model="draft.maxVersion" min="0" max="2" placeholder="默认 2" /></div>
            <div class="field"><label for="rpkiIgnoreMaxLength">Max Length</label><select id="rpkiIgnoreMaxLength" v-model="draft.ignoreMaxLength"><option value="default">遵循 ROA</option><option value="on">忽略</option><option value="off">不忽略</option></select></div>
            <label class="compact-toggle" for="rpkiKeepRefresh"><span>Keep Refresh</span><input id="rpkiKeepRefresh" v-model="draft.keepRefresh" type="checkbox"><i aria-hidden="true"></i></label>
            <label class="compact-toggle" for="rpkiKeepRetry"><span>Keep Retry</span><input id="rpkiKeepRetry" v-model="draft.keepRetry" type="checkbox"><i aria-hidden="true"></i></label>
            <label class="compact-toggle" for="rpkiKeepExpire"><span>Keep Expire</span><input id="rpkiKeepExpire" v-model="draft.keepExpire" type="checkbox"><i aria-hidden="true"></i></label>
          </div>
        </div>
        <div v-if="isSsh" id="rpkiSshFields" class="full-width"><div class="option-grid"><div class="field full-width"><label for="rpkiBirdPrivateKey">SSH 私钥</label><OptionalTextInput id="rpkiBirdPrivateKey" v-model="draft.birdPrivateKey" placeholder="/var/lib/bird/.ssh/id_rsa" required /></div><div class="field full-width"><label for="rpkiRemotePublicKey">服务器公钥</label><OptionalTextInput id="rpkiRemotePublicKey" v-model="draft.remotePublicKey" placeholder="/var/lib/bird/.ssh/known_hosts" required /></div><div class="field"><label for="rpkiUser">SSH 用户</label><OptionalTextInput id="rpkiUser" v-model="draft.user" required /></div></div></div>
        <label class="toggle-row full-width" for="rpkiEnabled"><span><strong>启用资源</strong></span><input id="rpkiEnabled" v-model="draft.enabled" type="checkbox"><i aria-hidden="true"></i></label>
      </div>
      <div class="dialog-actions split-actions"><button v-if="editing" id="deleteRPKIButton" class="text-danger-button" type="button" :disabled="pending" @click="remove">删除 RPKI</button><span></span><button class="secondary-button" type="button" data-close="rpkiDialog" :disabled="pending" @click="close">取消</button><button class="primary-button" type="submit" :disabled="pending">{{ pending ? "正在预检" : "预检、保存并应用" }}</button></div>
    </form>
  </dialog>
</template>
