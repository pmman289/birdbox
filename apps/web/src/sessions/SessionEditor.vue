<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import type {
  AddressFamily,
  ChannelPolicy,
  PolicyFunction,
} from "@birdbox/contracts/inventory";
import type {
  ChangeEvent,
  SessionApplyResponse,
  SessionDeleteResponse,
  SessionPreviewResponse,
} from "@birdbox/contracts/api";

import { loadDashboard, setDashboardSnapshot, useDashboardStore } from "../dashboard/dashboard-store";
import { isEbgpDashboardPeer } from "../dashboard/peer-kind";
import NullableNumberInput from "../shared/NullableNumberInput.vue";
import OptionalTextInput from "../shared/OptionalTextInput.vue";
import { api, ApiError } from "../shared/api-client";
import { dispatchToast } from "../shared/events";
import BgpOptionsEditor from "./BgpOptionsEditor.vue";
import ChannelEditor from "./ChannelEditor.vue";
import PolicyActionDialog from "./PolicyActionDialog.vue";
import { channelRequiresExtendedNextHop } from "./session-draft";
import { useSessionStore } from "./session-store";

interface SessionErrorData {
  config?: string;
  events?: ChangeEvent[];
}

const families: AddressFamily[] = ["ipv4", "ipv6"];
const { dashboard, loading: dashboardLoading } = useDashboardStore();
const {
  draft,
  dirty,
  previewPending,
  applyPending,
  lastPreviewSignature,
  lastPreviewFailureSignature,
  draftSignature,
  sessionPayload,
} = useSessionStore();
const form = ref<HTMLFormElement | null>(null);
const activeFamily = ref<AddressFamily>("ipv4");
const previewController = ref<AbortController | null>(null);
const applyDialog = ref<HTMLDialogElement | null>(null);
const policyActionDialog = ref<InstanceType<typeof PolicyActionDialog> | null>(null);
const policyActionContext = ref<{ family: AddressFamily; direction: "import" | "export" } | null>(null);
const errorMessage = ref("");
const errorField = ref<string | null>(null);
let autoPreviewTimer: number | null = null;
let autoPreviewQueued = false;

const node = computed(() => dashboard.value?.node ?? null);
const peer = computed(() => {
  const selected = dashboard.value?.selectedPeer;
  return isEbgpDashboardPeer(selected) ? selected : null;
});
const existingSession = computed(() => peer.value?.session ?? null);
const unavailable = computed(() => !node.value || !peer.value || !draft.value);
const unavailableTitle = computed(() => !node.value ? "尚未选择受管节点" : "请选择或创建 eBGP 远端");
const pairLocal = computed(() => draft.value
  ? `${draft.value.localAddress || "自动选择"} · ${draft.value.localAsn ? `AS${draft.value.localAsn}` : "ASN 未设置"}`
  : "-");
const pairRemote = computed(() => peer.value ? `${peer.value.address} · AS${peer.value.asn}` : "-");
const currentConfig = computed(() => dashboard.value?.config ?? "# 尚无配置");

function visibleDefines(family: AddressFamily) {
  return dashboard.value?.cidrDefines[family] ?? [];
}

function clearError(): void {
  errorMessage.value = "";
  errorField.value = null;
}

function fieldForMessage(message: string): string | null {
  const mappings: Array<[RegExp, string]> = [
    [/协议名称/, "protocolName"],
    [/本地地址|两端地址|地址族/, "localAddress"],
    [/本地 ASN|两端 ASN/, "localAsn"],
    [/本地端口/, "localPort"],
    [/IPv4 与 IPv6 Channel|至少启用/, "channels"],
    [/Hold Time/, "holdTime"],
    [/Keepalive/, "keepaliveTime"],
    [/Multihop|连接方式/, "connectionMode"],
    [/接口|Interface/, "interface"],
    [/TCP MD5/, "password"],
    [/TCP-AO/, "aoKeys"],
    [/Capabilities|跨地址族/, "capabilities"],
    [/Function|Filter|导入策略|导出策略/, "channels"],
  ];
  return mappings.find(([pattern]) => pattern.test(message))?.[1] ?? null;
}

async function presentError(message: string, focus = true): Promise<void> {
  errorMessage.value = message;
  errorField.value = fieldForMessage(message);
  if (!focus || !errorField.value) return;
  await nextTick();
  const target = form.value?.querySelector<HTMLElement>(`[data-field="${errorField.value}"] input, [data-field="${errorField.value}"] select, [data-field="${errorField.value}"] textarea, [data-field="${errorField.value}"]`);
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
  target?.focus({ preventScroll: true });
}

function validateDraft(report: boolean): boolean {
  clearError();
  if (!form.value || !draft.value || !peer.value) return false;
  if (!form.value.checkValidity()) {
    if (report) {
      const invalid = form.value.querySelector<HTMLElement>(":invalid");
      void presentError(invalid instanceof HTMLInputElement || invalid instanceof HTMLSelectElement || invalid instanceof HTMLTextAreaElement
        ? invalid.validationMessage
        : "请检查表单输入", true);
      if (invalid instanceof HTMLInputElement || invalid instanceof HTMLSelectElement || invalid instanceof HTMLTextAreaElement) invalid.reportValidity();
    }
    return false;
  }
  const value = draft.value;
  const fail = (message: string, field: string): false => {
    errorMessage.value = message;
    errorField.value = field;
    if (report) void presentError(message, true);
    return false;
  };
  if (value.localAsn === null) return fail("本地 ASN 不能为空", "localAsn");
  if (value.localPort === null) return fail("本地端口不能为空", "localPort");
  if (!families.some((family) => value.channels[family].enabled)) return fail("请至少启用 IPv4 或 IPv6 Channel", "channels");
  const hold = value.bgp.holdTime ?? 240;
  const keepalive = value.bgp.keepaliveTime ?? Math.floor(hold / 3);
  if (value.bgp.holdTime !== null && value.bgp.holdTime !== 0 && value.bgp.holdTime < 3) return fail("Hold Time 必须为 0 或至少 3 秒", "holdTime");
  if (value.bgp.keepaliveTime !== null && value.bgp.keepaliveTime > hold) return fail("Keepalive 不能大于 Hold Time", "keepaliveTime");
  if (value.bgp.minHoldTime !== null && value.bgp.minHoldTime > hold) return fail("Min Hold 不能大于 Hold Time", "holdTime");
  if (value.bgp.minKeepaliveTime !== null && value.bgp.minKeepaliveTime > keepalive) return fail("Min Keepalive 不能大于 Keepalive", "keepaliveTime");
  if ((value.bgp.errorWaitMin === null) !== (value.bgp.errorWaitMax === null)) return fail("错误等待时间必须同时填写下限和上限", "holdTime");
  if (value.bgp.errorWaitMin !== null && value.bgp.errorWaitMax !== null && value.bgp.errorWaitMin > value.bgp.errorWaitMax) return fail("错误等待范围必须从小到大", "holdTime");
  if (value.bgp.connectionMode === "direct" && (isLinkLocal(peer.value.address) || isLinkLocal(value.localAddress))
    && !hasScope(peer.value.address) && !hasScope(value.localAddress) && !value.bgp.interface) {
    return fail("IPv6 Link-local 会话必须指定接口，或在地址中填写 %接口", "interface");
  }
  if (families.some((family) => value.channels[family].enabled && channelRequiresExtendedNextHop(peer.value!, family)) && value.bgp.capabilities === "off") {
    return fail("IPv4 Channel 通过 IPv6 邻居传输时需要 BGP Capabilities 协商", "capabilities");
  }
  for (const family of families) {
    const channel = value.channels[family];
    if (!channel.enabled) continue;
    if (channel.nextHopKeep !== "default" && channel.nextHopKeep !== "off" && channel.nextHopSelf !== "default" && channel.nextHopSelf !== "off") {
      return fail("Next Hop Keep 与 Next Hop Self 不能同时启用", "channels");
    }
    for (const policy of [channel.importPolicy, channel.exportPolicy]) {
      if (policy.mode === "custom" && !policy.filterId) return fail("自定义策略必须选择 Filter", "channels");
    }
    if (channel.exportPolicy.mode !== "custom" && channel.exportPolicy.formAction === "cidr" && !channel.exportDefineId) {
      return fail("导出指定 CIDR 模式必须选择 CIDR Define", "channels");
    }
  }
  return true;
}

function isLinkLocal(address: string | null): boolean {
  const first = String(address ?? "").trim().split("%", 1)[0]?.split(":", 1)[0];
  if (!first) return false;
  const hextet = Number.parseInt(first, 16);
  return Number.isInteger(hextet) && hextet >= 0xfe80 && hextet <= 0xfebf;
}

function hasScope(address: string | null): boolean {
  return String(address ?? "").includes("%");
}

function updateDashboardPreview(config: string | undefined, events: ChangeEvent[] | undefined): void {
  if (!dashboard.value || (!config && !events)) return;
  setDashboardSnapshot({
    ...dashboard.value,
    ...(config ? { config } : {}),
    ...(events ? { events } : {}),
  });
}

function currentPayloadSignature(): string | null {
  try {
    const payload = sessionPayload();
    return payload ? JSON.stringify(payload) : null;
  } catch {
    return null;
  }
}

async function preview(silent = false): Promise<boolean> {
  if (previewPending.value) {
    autoPreviewQueued = true;
    return false;
  }
  if (applyPending.value || !validateDraft(!silent)) return false;
  let payload;
  try {
    payload = sessionPayload();
  } catch (error) {
    if (!silent) await presentError(error instanceof Error ? error.message : "会话参数不完整");
    return false;
  }
  if (!payload) return false;
  const signature = JSON.stringify(payload);
  previewController.value?.abort();
  const controller = new AbortController();
  previewController.value = controller;
  previewPending.value = true;
  if (!silent) clearError();
  try {
    const result = await api<SessionPreviewResponse>("/api/sessions/preview", {
      method: "POST",
      body: JSON.stringify(payload),
      signal: controller.signal,
      mutationWait: !silent,
    });
    if (controller.signal.aborted || previewController.value !== controller) return false;
    if (signature !== currentPayloadSignature()) {
      autoPreviewQueued = true;
      return false;
    }
    updateDashboardPreview(result.config, result.events);
    lastPreviewSignature.value = signature;
    lastPreviewFailureSignature.value = null;
    dirty.value = false;
    if (!silent) dispatchToast("节点候选配置检查通过", "success");
    return true;
  } catch (error) {
    if (controller.signal.aborted) return false;
    if (signature !== currentPayloadSignature()) {
      autoPreviewQueued = true;
      return false;
    }
    const data = error instanceof ApiError ? error.data as SessionErrorData : undefined;
    updateDashboardPreview(data?.config, data?.events);
    lastPreviewFailureSignature.value = signature;
    if (!silent) await presentError(error instanceof Error ? error.message : "候选配置检查失败");
    return false;
  } finally {
    if (previewController.value === controller) {
      previewController.value = null;
      previewPending.value = false;
      if (autoPreviewQueued) {
        autoPreviewQueued = false;
        scheduleAutoPreview(0);
      }
    }
  }
}

function scheduleAutoPreview(delay = 500): void {
  if (autoPreviewTimer !== null) window.clearTimeout(autoPreviewTimer);
  autoPreviewTimer = window.setTimeout(() => {
    autoPreviewTimer = null;
    const signature = draftSignature.value;
    if (!signature || signature === lastPreviewSignature.value || signature === lastPreviewFailureSignature.value) return;
    if (dashboardLoading.value || applyPending.value || !validateDraft(false)) return;
    void preview(true);
  }, delay);
}

function openApplyDialog(): void {
  if (validateDraft(true)) applyDialog.value?.showModal();
}

async function applySession(): Promise<void> {
  if (applyPending.value || !validateDraft(true)) return;
  const payload = sessionPayload();
  if (!payload || !node.value || !peer.value) return;
  previewController.value?.abort();
  applyDialog.value?.close();
  applyPending.value = true;
  clearError();
  const nodeId = node.value.id;
  const peerId = peer.value.id;
  try {
    const result = await api<SessionApplyResponse>("/api/sessions/apply", { method: "POST", body: JSON.stringify(payload) });
    dispatchToast(result.enabled === false
      ? "会话已停用"
      : result.established ? "BGP 会话已建立" : "配置已应用，正在等待远端 Peer", result.enabled === false || result.established ? "success" : "");
    await loadDashboard(nodeId, peerId);
  } catch (error) {
    await loadDashboard(nodeId, peerId);
    await presentError(error instanceof Error ? error.message : "应用会话失败");
  } finally {
    applyPending.value = false;
  }
}

async function removeSession(): Promise<void> {
  if (!existingSession.value || !node.value || !peer.value || applyPending.value) return;
  if (!window.confirm(`移除会话 ${existingSession.value.protocolName}？`)) return;
  applyPending.value = true;
  try {
    await api<SessionDeleteResponse>(`/api/sessions/${existingSession.value.id}`, { method: "DELETE" });
    dispatchToast("会话已移除", "success");
    await loadDashboard(node.value.id, peer.value.id);
  } catch (error) {
    await presentError(error instanceof Error ? error.message : "移除会话失败");
  } finally {
    applyPending.value = false;
  }
}

function openPolicyAction(family: AddressFamily, direction: "import" | "export"): void {
  policyActionContext.value = { family, direction };
  policyActionDialog.value?.open(family, direction);
}

function openPeerResources(): void {
  window.dispatchEvent(new CustomEvent("birdbox:workspace-resource-open", { detail: { target: "peers" } }));
}

function insertPolicyFunction(resource: PolicyFunction): void {
  if (!draft.value || !policyActionContext.value) return;
  const { family, direction } = policyActionContext.value;
  const channel = draft.value.channels[family];
  const policyKey = direction === "import" ? "importPolicy" : "exportPolicy";
  const policy: ChannelPolicy = channel[policyKey];
  if (policy.steps.some((step) => step.type === "function" && step.functionId === resource.id)) return;
  const steps = [...policy.steps];
  const formIndex = steps.findIndex((step) => step.type === "form");
  steps.splice(formIndex < 0 ? steps.length : formIndex, 0, { type: "function", functionId: resource.id, action: "execute" });
  if (!steps.some((step) => step.type === "form")) steps.push({ type: "form" });
  channel[policyKey] = { ...policy, mode: "combined", steps, filterId: null };
  policyActionContext.value = null;
}

watch(draftSignature, (signature) => {
  dirty.value = signature !== null && signature !== lastPreviewSignature.value;
  scheduleAutoPreview();
});

onBeforeUnmount(() => {
  if (autoPreviewTimer !== null) window.clearTimeout(autoPreviewTimer);
  autoPreviewQueued = false;
  previewController.value?.abort();
});
</script>

<template>
  <section class="session-section" aria-labelledby="sessionTitle">
    <div class="section-heading compact"><div><p class="eyebrow">会话</p><h2 id="sessionTitle">会话配置</h2></div><span class="compatibility-badge">BIRD 2.19.1</span></div>
    <div class="session-preview-overlay" role="status" aria-live="polite" aria-atomic="true" :hidden="!previewPending">
      <div class="session-preview-notice"><span class="session-preview-spinner" aria-hidden="true"></span><div><strong>正在预检会话配置</strong><span>正在等待节点返回候选配置检查结果</span></div></div>
    </div>

    <div v-if="unavailable" class="empty-state"><strong>{{ unavailableTitle }}</strong><button class="secondary-button" type="button" @click="openPeerResources">前往资源管理</button></div>

    <form v-else-if="draft && peer" ref="form" novalidate :aria-busy="applyPending" :inert="applyPending" @submit.prevent="preview(false)">
      <div class="pair-summary"><div><span>本机</span><strong>{{ pairLocal }}</strong></div><i aria-hidden="true"></i><div><span>远端</span><strong>{{ pairRemote }}</strong></div></div>
      <div class="field" data-field="protocolName" :class="{ 'field-invalid': errorField === 'protocolName' }"><label for="protocolName">BIRD 协议名称（自动，可编辑）</label><input id="protocolName" v-model.trim="draft.protocolName" required pattern="[A-Za-z_][A-Za-z0-9_]*" maxlength="64" autocomplete="off" :aria-invalid="errorField === 'protocolName'"></div>
      <label class="toggle-row full-width session-enabled-row"><span><strong>启用会话</strong><small>关闭后不生成该会话的 BGP 配置</small></span><input v-model="draft.enabled" type="checkbox"><i aria-hidden="true"></i></label>
      <div class="field" data-field="localAddress" :class="{ 'field-invalid': errorField === 'localAddress' }"><label>本地地址（可选）</label><OptionalTextInput v-model="draft.localAddress" placeholder="自动选择" autocomplete="off" :aria-invalid="errorField === 'localAddress'" /></div>
      <div class="field" data-field="localAsn" :class="{ 'field-invalid': errorField === 'localAsn' }"><label>本地 ASN</label><NullableNumberInput v-model="draft.localAsn" min="1" max="4294967295" required :aria-invalid="errorField === 'localAsn'" /></div>
      <div class="field" data-field="localPort" :class="{ 'field-invalid': errorField === 'localPort' }"><label>本地端口</label><NullableNumberInput v-model="draft.localPort" min="1" max="65535" required :aria-invalid="errorField === 'localPort'" /></div>

      <div class="channel-editors" data-field="channels" :class="{ 'field-invalid': errorField === 'channels' }">
        <nav class="afi-tabs" role="tablist" aria-label="BGP Address Family">
          <button v-for="family in families" :key="family" class="afi-tab" :class="{ active: activeFamily === family, disabled: !draft.channels[family].enabled }" type="button" role="tab" :aria-selected="activeFamily === family" :tabindex="activeFamily === family ? 0 : -1" @click="activeFamily = family">{{ family === "ipv4" ? "IPv4" : "IPv6" }} <span>{{ draft.channels[family].enabled ? "开启" : "关闭" }}</span></button>
        </nav>
        <ChannelEditor
          v-for="family in families"
          :key="family"
          v-model="draft.channels[family]"
          :family="family"
          :peer="peer"
          :bgp="draft.bgp"
          :functions="dashboard?.functions ?? []"
          :filters="dashboard?.filters ?? []"
          :defines="visibleDefines(family)"
          :active="activeFamily === family"
          @open-policy-action="openPolicyAction(family, $event)"
        />
      </div>

      <div data-field="connectionMode"><BgpOptionsEditor v-model="draft.bgp" /></div>
      <p class="auth-error session-form-error" role="alert" :hidden="!errorMessage">{{ errorMessage }}</p>
      <div class="form-actions"><button class="secondary-button" type="submit" :disabled="previewPending || applyPending">{{ previewPending ? "正在预检" : "预检配置" }}</button><button class="primary-button" type="button" :disabled="previewPending || applyPending" @click="openApplyDialog">应用会话变更</button></div>
      <button v-if="existingSession" class="text-danger-button" type="button" :disabled="applyPending" @click="removeSession">移除当前会话</button>
    </form>
  </section>

  <dialog ref="applyDialog" aria-labelledby="applyDialogTitle">
    <form method="dialog" @submit.prevent="applySession">
      <div class="dialog-head"><span class="dialog-icon">⇄</span><div><p class="eyebrow">节点部署</p><h2 id="applyDialogTitle">应用节点会话配置</h2></div></div>
      <div class="dialog-route"><span>{{ pairLocal }}</span><i></i><span>{{ peer?.name ?? "远端" }} · AS{{ peer?.asn ?? "-" }}</span></div>
      <p class="dialog-note">将合并此节点的全部已启用会话，预检通过后更新该节点。</p>
      <div class="dialog-actions"><button class="secondary-button" type="button" @click="applyDialog?.close()">取消</button><button class="primary-button" type="submit">确认应用</button></div>
    </form>
  </dialog>
  <PolicyActionDialog ref="policyActionDialog" :local-asn="draft?.localAsn ?? null" @saved="insertPolicyFunction" />
</template>
