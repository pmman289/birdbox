<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import type {
  AddressFamily,
  ChannelPolicy,
  PolicyFunction,
} from "@birdbox/contracts/inventory";
import type {
  ChangeEvent,
  SessionMutationRequest,
  SessionApplyResponse,
  SessionDeleteResponse,
  SessionPreviewResponse,
} from "@birdbox/contracts/api";
import type { BgpSession } from "@birdbox/contracts/inventory";

import { loadDashboard, refreshDashboardRuntime, setDashboardSnapshot, useDashboardStore } from "../dashboard/dashboard-store";
import { isEbgpDashboardPeer } from "../dashboard/peer-kind";
import NullableNumberInput from "../shared/NullableNumberInput.vue";
import OptionalTextInput from "../shared/OptionalTextInput.vue";
import ProtocolWorkflow from "../shared/ProtocolWorkflow.vue";
import { api, ApiError } from "../shared/api-client";
import { dispatchToast } from "../shared/events";
import BgpOptionsEditor from "./BgpOptionsEditor.vue";
import ChannelEditor from "./ChannelEditor.vue";
import PolicyActionDialog from "./PolicyActionDialog.vue";
import { channelRequiresExtendedNextHop } from "./session-draft";
import { useSessionStore } from "./session-store";
import { extractBgpProtocolConfig } from "./session-config";

interface SessionErrorData {
  config?: string;
  sessionConfig?: string;
  events?: ChangeEvent[];
}

const families: AddressFamily[] = ["ipv4", "ipv6"];
const { dashboard, loading: dashboardLoading } = useDashboardStore();
const {
  draft,
  dirty,
  remoteChanged,
  previewPending,
  applyPending,
  setPreviewConfig,
  contextKey,
  lastPreviewSignature,
  lastPreviewFailureSignature,
  draftSignature,
  resetDraft,
  rebaseDraft,
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
const inventoryRevision = ref<number | null>(null);
const contextPending = ref(false);
const stateConflict = ref(false);
const comparisonOpen = ref(false);
const reviewedPreview = ref<SessionPreviewResponse | null>(null);
let contextGeneration = 0;
let autoPreviewTimer: number | null = null;
let autoPreviewQueued = false;
let previewTask: Promise<boolean> | null = null;

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
const hasConflict = computed(() => stateConflict.value || remoteChanged.value);
const currentPreview = computed(() => reviewedPreview.value && lastPreviewSignature.value === currentPayloadSignature() ? reviewedPreview.value : null);
const workflowSteps = computed(() => [
  { id: "basics", title: "基础连接", detail: "确认地址与 ASN" },
  { id: "channels", title: "路由策略", detail: families.filter(family => draft.value?.channels[family].enabled).map(family => family === "ipv4" ? "IPv4" : "IPv6").join(" / ") || "尚未启用通道" },
  { id: "review", title: "预检与应用", detail: currentPreview.value ? "当前草稿已通过预检" : "检查变更后确认应用" },
]);
function focusWorkflowStep(id: string): void {
  const target = form.value?.querySelector<HTMLElement>(`[data-workflow-section="${id}"]`);
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
  target?.focus({ preventScroll: true });
}
function comparisonSummary(value: BgpSession | typeof draft.value) {
  return value ? JSON.stringify({ protocolName: value.protocolName, enabled: value.enabled, localAddress: value.localAddress, localAsn: value.localAsn, localPort: value.localPort, channels: value.channels, bgp: { connectionMode: value.bgp.connectionMode, authentication: value.bgp.authentication, bfd: value.bgp.bfd } }, null, 2) : "会话尚未配置";
}

async function loadEditorContext(compare = false): Promise<void> {
  const key = contextKey.value, nodeId = node.value?.id, peerId = peer.value?.id;
  if (!key || !nodeId || !peerId) return;
  const request = ++contextGeneration;
  if (!compare) inventoryRevision.value = null;
  contextPending.value = true;
  try {
    if (compare) await loadDashboard(nodeId, peerId);
    const result = await api<{ inventoryRevision: number | null; session: BgpSession | null }>(`/api/sessions/editor-context?nodeId=${encodeURIComponent(nodeId)}&peerId=${encodeURIComponent(peerId)}`);
    if (request !== contextGeneration || key !== contextKey.value) return;
    inventoryRevision.value = result.inventoryRevision;
    if (compare && dashboard.value && isEbgpDashboardPeer(dashboard.value.selectedPeer)) {
      const current = dashboard.value;
      const sessions = current.inventory.sessions.filter(s => !(s.nodeId === nodeId && s.peerId === peerId));
      if (result.session) sessions.push(result.session);
      const peers = current.peers.map(p => p.id === peerId ? { ...p, session: result.session } : p);
      setDashboardSnapshot({ ...current, inventory: { ...current.inventory, sessions }, peers, selectedPeer: peers.find(p => p.id === peerId) ?? null });
      comparisonOpen.value = true;
    } else if (JSON.stringify(result.session) !== JSON.stringify(existingSession.value)) {
      stateConflict.value = true;
      await presentError("编辑期间服务端会话已变化，请加载最新版本并对比。", false);
    }
  } catch (error) {
    if (request === contextGeneration) await presentError(error instanceof Error ? error.message : "读取编辑版本失败", false);
  } finally {
    if (request === contextGeneration) { contextPending.value = false; if (!compare) scheduleAutoPreview(0, true); }
  }
}

function resolveConflict(keep: boolean): void {
  if (keep) rebaseDraft(); else resetDraft();
  stateConflict.value = false; comparisonOpen.value = false; reviewedPreview.value = null;
  clearError(); scheduleAutoPreview(0, true);
}

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
  revealField(target ?? null);
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
  target?.focus({ preventScroll: true });
}

function revealField(target: HTMLElement | null): void {
  for (let element = target?.parentElement; element; element = element.parentElement) {
    if (element instanceof HTMLDetailsElement) element.open = true;
    const panel = element.dataset.family;
    if (panel === "ipv4" || panel === "ipv6") activeFamily.value = panel;
  }
}

function validateDraft(report: boolean): boolean {
  clearError();
  if (!form.value || !draft.value || !peer.value) return false;
  if (!form.value.checkValidity()) {
    if (report) {
      const invalid = form.value.querySelector<HTMLElement>(":invalid");
      revealField(invalid);
      void presentError(invalid instanceof HTMLInputElement || invalid instanceof HTMLSelectElement || invalid instanceof HTMLTextAreaElement
        ? invalid.validationMessage
        : "请检查表单输入", true);
      if (invalid instanceof HTMLInputElement || invalid instanceof HTMLSelectElement || invalid instanceof HTMLTextAreaElement) {
        void nextTick(() => { invalid.scrollIntoView({ block: "center" }); invalid.reportValidity(); });
      }
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

function updateDashboardPreview(
  config: string | undefined,
  events: ChangeEvent[] | undefined,
  protocolName = draft.value?.protocolName,
  sessionConfig?: string,
): void {
  if (!dashboard.value || (!config && !events && sessionConfig === undefined)) return;
  const selectedConfig = sessionConfig || (config ? extractBgpProtocolConfig(config, protocolName) : null);
  if (config || sessionConfig !== undefined) setPreviewConfig(selectedConfig, contextKey.value);
  // A preview belongs to the draft; dashboard.config remains the saved config
  // so invalidating the draft cannot expose an older preview as active config.
  if (events) setDashboardSnapshot({ ...dashboard.value, events });
}

function currentPayloadSignature(): string | null {
  try {
    const payload = sessionPayload();
    return payload ? JSON.stringify(payload) : null;
  } catch {
    return null;
  }
}

function storedSessionSignature(session: BgpSession | null): string | null {
  if (!session) return null;
  const { id: _id, managedBy: _managedBy, ...payload } = session;
  return stableSignature(payload);
}

function stableSignature(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value));
}

async function reconcileAppliedSession(
  payload: SessionMutationRequest,
  nodeId: string,
  peerId: string,
): Promise<boolean> {
  const expected = stableSignature(payload);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    try {
      const snapshot = await refreshDashboardRuntime();
      if (snapshot?.node?.id === nodeId
        && snapshot.selectedPeer?.id === peerId
        && storedSessionSignature(snapshot.selectedPeer.session) === expected) return true;
    } catch {
      // Retry while the controller or reverse proxy recovers.
    }
  }
  return false;
}

function commitAppliedSession(result: SessionApplyResponse): void {
  const current = dashboard.value;
  if (!current) return;
  const sessions = current.inventory.sessions.some((session) => session.id === result.session.id)
    ? current.inventory.sessions.map((session) => session.id === result.session.id ? result.session : session)
    : [...current.inventory.sessions, result.session];
  const peers = current.peers.map((item) => item.id === result.session.peerId
    ? {
        ...item,
        session: result.session,
        protocol: result.session.enabled ? {
          name: result.session.protocolName,
          configured: true,
          disabled: false,
          state: "Starting",
          established: false,
          neighbor: item.address,
          neighborAs: item.asn,
          imported: null,
          exported: null,
        } : null,
      }
    : item);
  const selectedPeer = peers.find((item) => item.id === current.selectedPeer?.id) ?? null;
  const activeSessions = sessions.filter((session) => session.enabled).length;
  const wasEstablished = current.peers.find((item) => item.id === result.session.peerId)?.protocol?.established === true;
  const normalSessions = Math.min(
    Math.max(0, current.health.normalSessions - (wasEstablished ? 1 : 0)),
    activeSessions,
  );
  setDashboardSnapshot({
    ...current,
    inventory: { ...current.inventory, sessions },
    peers,
    selectedPeer,
    config: result.config,
    events: result.events,
    health: {
      ...current.health,
      activeSessions,
      normalSessions,
      abnormalSessions: activeSessions - normalSessions,
      status: current.health.onlineNodes < current.health.totalNodes
        ? "error"
        : activeSessions > normalSessions ? "warning" : "ready",
    },
  });
  resetDraft(false);
}

async function preview(silent = false): Promise<boolean> {
  // Explicit actions must wait for an in-flight background check instead of
  // losing the user's Apply click when a debounce fires at the same time.
  if (previewTask) return previewTask;
  const task = performPreview(silent);
  previewTask = task;
  try { return await task; }
  finally { if (previewTask === task) previewTask = null; }
}

async function performPreview(silent = false): Promise<boolean> {
  if (previewPending.value) {
    autoPreviewQueued = true;
    return false;
  }
  if (applyPending.value || contextPending.value || hasConflict.value || inventoryRevision.value === null || !validateDraft(!silent)) return false;
  let payload;
  try {
    payload = sessionPayload();
  } catch (error) {
    if (!silent) await presentError(error instanceof Error ? error.message : "会话参数不完整");
    return false;
  }
  if (!payload) return false;
  const signature = JSON.stringify(payload);
  reviewedPreview.value = null;
  previewController.value?.abort();
  const controller = new AbortController();
  previewController.value = controller;
  previewPending.value = true;
  if (!silent) clearError();
  try {
    const result = await api<SessionPreviewResponse>("/api/sessions/preview", {
      method: "POST",
      body: JSON.stringify({ ...payload, inventoryRevision: inventoryRevision.value }),
      signal: controller.signal,
      mutationWait: !silent,
    });
    if (controller.signal.aborted || previewController.value !== controller) return false;
    if (signature !== currentPayloadSignature()) {
      autoPreviewQueued = true;
      return false;
    }
    updateDashboardPreview(result.config, result.events, result.session.protocolName, result.sessionConfig);
    lastPreviewSignature.value = signature;
    reviewedPreview.value = result;
    lastPreviewFailureSignature.value = null;
    if (!silent) dispatchToast("配置预检通过", "success");
    return true;
  } catch (error) {
    if (controller.signal.aborted) return false;
    if (signature !== currentPayloadSignature()) {
      autoPreviewQueued = true;
      return false;
    }
    const data = error instanceof ApiError ? error.data as SessionErrorData : undefined;
    if (error instanceof ApiError && error.code === "STATE_CONFLICT") stateConflict.value = true;
    updateDashboardPreview(data?.config, data?.events, draft.value?.protocolName, data?.sessionConfig);
    lastPreviewFailureSignature.value = signature;
    if (!silent) await presentError(error instanceof Error ? error.message : "配置预检失败");
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

function scheduleAutoPreview(delay = 500, force = false): void {
  if (autoPreviewTimer !== null) window.clearTimeout(autoPreviewTimer);
  autoPreviewTimer = window.setTimeout(() => {
    autoPreviewTimer = null;
    const signature = currentPayloadSignature();
    if (!signature || (!force && (signature === lastPreviewSignature.value || signature === lastPreviewFailureSignature.value))) return;
    if (dashboardLoading.value || applyPending.value || !validateDraft(false)) return;
    void preview(true);
  }, delay);
}

async function openApplyDialog(): Promise<void> {
  if (hasConflict.value) {
    void presentError("服务端会话已变化，请先对比最新配置并确认保留或重新加载草稿。", false);
    return;
  }
  if (!validateDraft(true)) return;
  if (autoPreviewTimer !== null) { window.clearTimeout(autoPreviewTimer); autoPreviewTimer = null; }
  const key = contextKey.value;
  const signature = currentPayloadSignature();
  if (!currentPreview.value?.valid) {
    const joinedBackgroundCheck = previewTask !== null;
    await preview(false);
    // A draft edit or refresh may invalidate the background result. Complete
    // one explicit check of the current candidate, with visible errors.
    if (joinedBackgroundCheck && key === contextKey.value && signature === currentPayloadSignature() && !currentPreview.value?.valid && !hasConflict.value) await preview(false);
  }
  if (key === contextKey.value && signature === currentPayloadSignature() && currentPreview.value?.valid && !hasConflict.value) applyDialog.value?.showModal();
}

function reloadSavedSession(): void {
  if (dirty.value && !window.confirm("重新加载将放弃当前 eBGP 草稿，是否继续？")) return;
  resetDraft(); clearError(); stateConflict.value = false; comparisonOpen.value = false; void loadEditorContext();
}

function closeApplyDialog(): void {
  if (!applyPending.value) applyDialog.value?.close();
}

async function applySession(): Promise<void> {
  if (applyPending.value || hasConflict.value || !validateDraft(true)) return;
  const reviewed = currentPreview.value;
  if (!reviewed?.valid) { closeApplyDialog(); await preview(false); return; }
  const payload = sessionPayload();
  if (!payload || !node.value || !peer.value) return;
  previewController.value?.abort();
  applyDialog.value?.close();
  applyPending.value = true;
  clearError();
  const nodeId = node.value.id;
  const peerId = peer.value.id;
  try {
    const result = await api<SessionApplyResponse>("/api/sessions/apply", { method: "POST", body: JSON.stringify({ ...reviewed.session, mode: "apply", inventoryRevision: reviewed.inventoryRevision, previewId: reviewed.previewId, candidateHash: reviewed.candidateHash }) });
    commitAppliedSession(result);
    reviewedPreview.value = null;
    await loadEditorContext();
    dispatchToast(result.enabled === false
      ? "会话已停用"
      : result.established ? "BGP 会话已建立" : "配置已应用，正在等待远端 Peer", result.enabled === false || result.established ? "success" : "");
    void refreshDashboardRuntime();
  } catch (error) {
    if (error instanceof ApiError && error.unknownOutcome) {
      dispatchToast(error.message);
      if (await reconcileAppliedSession(payload, nodeId, peerId)) {
        resetDraft();
        reviewedPreview.value = null; await loadEditorContext();
        dispatchToast("会话变更已生效，最新运行状态已同步", "success");
      } else {
        await presentError("连接中断，暂时无法确认会话变更结果；后台状态刷新仍会继续", false);
      }
      return;
    }
    reviewedPreview.value = null;
    if (error instanceof ApiError && error.code === "STATE_CONFLICT") stateConflict.value = true;
    await loadDashboard(nodeId, peerId).catch(() => {});
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
    await api<SessionDeleteResponse>(`/api/sessions/${existingSession.value.id}`, { method: "DELETE", body: JSON.stringify({ inventoryRevision: inventoryRevision.value }) });
    dispatchToast("会话已移除", "success");
    await loadDashboard(node.value.id, peer.value.id);
    resetDraft();
    await loadEditorContext();
  } catch (error) {
    if (error instanceof ApiError && error.code === "STATE_CONFLICT") stateConflict.value = true;
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

watch(draftSignature, () => {
  reviewedPreview.value = null;
  setPreviewConfig(null);
  lastPreviewFailureSignature.value = null;
  scheduleAutoPreview();
});

// A newly selected Peer starts with an already initialized draft signature. Force
// one preview so a new session gets a visible block before it is saved.
watch(contextKey, () => {
  contextGeneration++; inventoryRevision.value = null; stateConflict.value = false; comparisonOpen.value = false; reviewedPreview.value = null;
  previewController.value?.abort();
  previewController.value = null; previewPending.value = false;
  previewTask = null;
  autoPreviewQueued = false; clearError(); applyDialog.value?.close();
  void loadEditorContext();
}, { immediate: true });

function protectUnload(event: BeforeUnloadEvent): void {
  if (dirty.value || applyPending.value) { event.preventDefault(); event.returnValue = ""; }
}
window.addEventListener("beforeunload", protectUnload);

onBeforeUnmount(() => {
  contextGeneration++;
  window.removeEventListener("beforeunload", protectUnload);
  if (autoPreviewTimer !== null) window.clearTimeout(autoPreviewTimer);
  autoPreviewQueued = false;
  previewController.value?.abort();
});
</script>

<template>
  <section class="session-section" aria-labelledby="sessionTitle">
    <div class="section-heading compact"><div><p class="eyebrow">会话</p><h2 id="sessionTitle">会话配置</h2></div><span v-if="draft" class="compatibility-badge" role="status" data-testid="session-draft-state">{{ dirty ? '有未应用修改' : '已保存配置' }}</span></div>
    <div v-if="hasConflict" class="protocol-notice" role="alert">服务端配置已变化，本地草稿已保留。<button class="secondary-button" type="button" :disabled="contextPending || applyPending" @click="loadEditorContext(true)">加载最新版本并对比</button></div>
    <div v-else-if="draft && inventoryRevision === null && !contextPending" class="protocol-notice" role="alert">暂时无法读取编辑版本，草稿已保留。<button class="secondary-button" type="button" @click="loadEditorContext()">重试读取编辑版本</button></div>
    <section v-if="comparisonOpen" class="protocol-preview session-conflict-comparison" role="region" aria-label="eBGP 冲突对比"><h3>最新配置与本地草稿</h3><details><summary>服务端最新会话</summary><pre>{{ comparisonSummary(existingSession) }}</pre></details><details><summary>本地草稿</summary><pre>{{ comparisonSummary(draft) }}</pre></details><p>认证字段不在此处展示。保留草稿后需重新预检并确认应用。</p><div class="form-actions"><button class="secondary-button" type="button" @click="resolveConflict(false)">采用最新配置</button><button class="secondary-button" type="button" @click="resolveConflict(true)">保留草稿，重新预检</button></div></section>
    <div class="session-preview-overlay" role="status" aria-live="polite" aria-atomic="true" :hidden="!previewPending">
      <div class="session-preview-notice"><span class="session-preview-spinner" aria-hidden="true"></span><div><strong>正在预检会话配置</strong><span>等待节点返回检查结果</span></div></div>
    </div>

    <div v-if="unavailable" class="empty-state"><strong>{{ unavailableTitle }}</strong><button class="secondary-button" type="button" @click="openPeerResources">前往资源管理</button></div>

    <form v-else-if="draft && peer" ref="form" novalidate :aria-busy="applyPending" :inert="applyPending" @submit.prevent="preview(false)">
      <ProtocolWorkflow label="eBGP 配置步骤" :steps="workflowSteps" @select="focusWorkflowStep" />
      <section class="protocol-config-section" data-workflow-section="basics" tabindex="-1" aria-label="eBGP 基础连接">
      <div class="protocol-section-title"><span>1</span><div><h3>基础连接</h3><p>确认本机与远端，再设置本地连接参数。</p></div></div>
      <div class="pair-summary"><div><span>本机</span><strong>{{ pairLocal }}</strong></div><i aria-hidden="true"></i><div><span>远端</span><strong>{{ pairRemote }}</strong></div></div>
      <div class="field" data-field="protocolName" :class="{ 'field-invalid': errorField === 'protocolName' }"><label for="protocolName">BIRD 协议名称（自动，可编辑）</label><input id="protocolName" v-model.trim="draft.protocolName" required pattern="[A-Za-z_][A-Za-z0-9_]*" maxlength="64" autocomplete="off" :aria-invalid="errorField === 'protocolName'"></div>
      <label class="toggle-row full-width session-enabled-row"><span><strong>启用会话</strong><small>关闭后不生成该会话的 BGP 配置</small></span><input v-model="draft.enabled" type="checkbox"><i aria-hidden="true"></i></label>
      <div class="field" data-field="localAddress" :class="{ 'field-invalid': errorField === 'localAddress' }"><label for="session-localAddress">本地地址（可选）</label><OptionalTextInput id="session-localAddress" v-model="draft.localAddress" placeholder="自动选择" autocomplete="off" :aria-invalid="errorField === 'localAddress'" /></div>
      <div class="field" data-field="localAsn" :class="{ 'field-invalid': errorField === 'localAsn' }"><label for="session-localAsn">本地 ASN</label><NullableNumberInput id="session-localAsn" v-model="draft.localAsn" min="1" max="4294967295" required :aria-invalid="errorField === 'localAsn'" /></div>
      <div class="field" data-field="localPort" :class="{ 'field-invalid': errorField === 'localPort' }"><label for="session-localPort">本地端口</label><NullableNumberInput id="session-localPort" v-model="draft.localPort" min="1" max="65535" required :aria-invalid="errorField === 'localPort'" /></div>
      </section>

      <div class="channel-editors protocol-config-section" data-field="channels" data-workflow-section="channels" tabindex="-1" :class="{ 'field-invalid': errorField === 'channels' }">
        <div class="protocol-section-title"><span>2</span><div><h3>地址族与路由策略</h3><p>IPv4 / IPv6 独立配置。导入是从远端接收，导出是向远端发布。</p></div></div>
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
          compact-policies
          @open-policy-action="openPolicyAction(family, $event)"
        />
      </div>

      <div class="protocol-config-section" data-field="connectionMode"><BgpOptionsEditor v-model="draft.bgp" /></div>
      <section class="protocol-config-section" data-workflow-section="review" tabindex="-1" aria-label="eBGP 变更确认">
      <div class="protocol-section-title"><span>3</span><div><h3>预检与应用</h3><p>影响节点：{{ node?.name }}。预检只检查配置，确认应用后才会部署。</p></div></div>
      <p class="auth-error session-form-error" role="alert" :hidden="!errorMessage">{{ errorMessage }}</p>
      <p v-if="currentPreview" class="protocol-help" role="status">预检通过 · {{ dirty ? '尚未应用' : '与已保存配置一致' }}</p>
      <details v-if="currentPreview" class="session-change-summary"><summary>查看待应用配置差异</summary><pre>{{ currentPreview.diff || '配置无变化' }}</pre></details>
      </section>
      <div class="protocol-action-bar" role="region" aria-label="eBGP 配置操作"><span class="protocol-action-state">{{ dirty ? '有待应用修改' : '与已保存配置一致' }} · {{ currentPreview ? '预检通过' : '应用前将预检' }}</span><div class="form-actions"><button class="secondary-button" type="submit" :disabled="previewPending || applyPending || contextPending || hasConflict || inventoryRevision === null">{{ previewPending ? "正在预检" : "预检配置" }}</button><button class="primary-button" type="button" :disabled="previewPending || applyPending || contextPending || hasConflict || inventoryRevision === null" @click="openApplyDialog">应用会话变更</button></div></div>
      <div class="form-actions protocol-maintenance-actions"><button class="secondary-button" type="button" :disabled="applyPending" @click="reloadSavedSession">重新加载已保存配置</button></div>
      <button v-if="existingSession" class="text-danger-button" type="button" :disabled="applyPending" @click="removeSession">移除当前会话</button>
    </form>
  </section>

  <dialog ref="applyDialog" aria-labelledby="applyDialogTitle" @cancel.prevent="closeApplyDialog">
    <form method="dialog" @submit.prevent="applySession">
      <div class="dialog-head"><span class="dialog-icon">⇄</span><div><p class="eyebrow">节点部署</p><h2 id="applyDialogTitle">应用节点会话配置</h2></div></div>
      <div class="dialog-route"><span>{{ pairLocal }}</span><i></i><span>{{ peer?.name ?? "远端" }} · AS{{ peer?.asn ?? "-" }}</span></div>
      <p class="dialog-note">将合并此节点的全部已启用会话，重新预检后更新该节点。仅应用当前已预检草稿。</p>
      <details v-if="currentPreview" class="session-apply-diff"><summary>查看配置差异</summary><pre>{{ currentPreview.diff || '配置无变化' }}</pre></details>
      <div class="dialog-actions"><button class="secondary-button" type="button" @click="closeApplyDialog">取消</button><button class="primary-button" type="submit">确认应用</button></div>
    </form>
  </dialog>
  <PolicyActionDialog ref="policyActionDialog" :local-asn="draft?.localAsn ?? null" @saved="insertPolicyFunction" />
</template>
