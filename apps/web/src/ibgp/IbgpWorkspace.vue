<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type {
  DeploymentReport,
  IbgpDomainPreviewResponse,
  IbgpPreviewSide,
} from "@birdbox/contracts/api";
import type {
  AddressFamily,
  BgpSession,
  ChannelPolicy,
  IbgpAdjacency,
  IbgpDomain,
  IbgpMember,
  Inventory,
  ManagedNode,
  Peer,
  PolicyFunction,
} from "@birdbox/contracts/inventory";
import type { NodeRuntime } from "@birdbox/contracts/api";

import { useDashboardStore } from "../dashboard/dashboard-store";
import { api, ApiError } from "../shared/api-client";
import { cloneReactive } from "../shared/clone-reactive";
import { uniqueBirdName } from "../shared/resource-names";
import ProtocolWorkflow from "../shared/ProtocolWorkflow.vue";
import PolicyActionDialog from "../sessions/PolicyActionDialog.vue";
import { defaultBgpOptions, defaultChannel } from "../sessions/session-draft";
import IbgpSessionSideEditor from "./IbgpSessionSideEditor.vue";

const { dashboard } = useDashboardStore();
const domains = ref<IbgpDomain[]>([]);
const selectedDomainId = ref<string | null>(null);
const selectedNodeId = ref<string | null>(null);
const selectedAdjacencyId = ref<string | null>(null);
const endpointView = ref<"left" | "right" | "both">("left");
const workspace = ref<HTMLElement | null>(null);
const draft = ref<IbgpDomain | null>(null);
const sessionDrafts = ref<Record<string, BgpSession>>({});
const loading = ref(false);
const saving = ref(false);
const layoutSaving = ref(false);
const error = ref("");
const connectionSelectionStep = ref<"idle" | "a" | "b" | "config">("idle");
const connectionSelectionFirstNodeId = ref<string | null>(null);
const canvas = ref<HTMLElement | null>(null);
const canvasViewportWidth = ref(0);
const dragging = ref<{ nodeId: string; dx: number; dy: number; moved?: boolean } | null>(null);
const previewPending = ref(false);
const previewValid = ref<boolean | null>(null);
const previewError = ref("");
const previewSides = ref<IbgpPreviewSide[]>([]);
const inventoryRevision = ref<number | null | undefined>(undefined);
const reviewed = ref<{ signature: string; response: IbgpDomainPreviewResponse } | null>(null);
const conflict = ref(false);
const latestContext = ref<{ domains: IbgpDomain[]; inventory: Inventory; inventoryRevision?: number | null } | null>(null);
const deploymentResult = ref<DeploymentReport | null>(null);
const reviewOpen = ref(false);
const inventorySnapshot = ref<Inventory | null>(null);
const runtimeByNodeId = ref<Record<string, NodeRuntime>>({});
const draftDirty = ref(false);
const leftSideColumn = ref<HTMLElement | null>(null);
const rightSideColumn = ref<HTMLElement | null>(null);
let runtimeTimer: number | null = null;
const policyActionDialog = ref<InstanceType<typeof PolicyActionDialog> | null>(
  null,
);
const policyActionContext = ref<{
  sessionId: string;
  family: AddressFamily;
  direction: "import" | "export";
} | null>(null);
let previewTimer: number | null = null;
let previewQueued = false;
let adjacencySequence = 0;
let domainLoadSequence = 0;
let runtimeRefreshSequence = 0;
let mounted = false;
let suppressDraftDirty = false;

const currentInventory = computed<Inventory | null>(
  // The domain endpoint returns the inventory used for its preview. Prefer it
  // over a possibly stale dashboard selection after a workspace refresh.
  () => inventorySnapshot.value ?? dashboard.value?.inventory ?? null,
);
const nodes = computed<ManagedNode[]>(
  () => currentInventory.value?.nodes ?? [],
);
const selectedAdjacency = computed(
  () =>
    draft.value?.adjacencies.find(
      (item) => item.id === selectedAdjacencyId.value,
    ) ?? null,
);
const selectedPairSessions = computed(() => {
  const adjacency = selectedAdjacency.value;
  if (!adjacency) return { left: null, right: null };
  return {
    left: sessionDrafts.value[adjacency.leftSessionId] ?? null,
    right: sessionDrafts.value[adjacency.rightSessionId] ?? null,
  };
});
const leftSession = computed(() => selectedPairSessions.value.left);
const rightSession = computed(() => selectedPairSessions.value.right);
const policySession = computed(() => {
  const sessionId = policyActionContext.value?.sessionId;
  return sessionId ? sessionDrafts.value[sessionId] ?? null : null;
});
const inventoryDefines = computed(() => currentInventory.value?.defines ?? []);
const inventoryFunctions = computed(() => currentInventory.value?.functions ?? []);
const inventoryFilters = computed(() => currentInventory.value?.filters ?? []);
const connectionSelectionFromNode = computed(() =>
  nodes.value.find((node) => node.id === connectionSelectionFirstNodeId.value) ?? null,
);
const connectionSelectionToNode = computed(() => {
  const adjacency = selectedAdjacency.value;
  const firstNodeId = connectionSelectionFirstNodeId.value;
  if (!adjacency || !firstNodeId) return null;
  const remoteNodeId = adjacency.leftNodeId === firstNodeId ? adjacency.rightNodeId : adjacency.leftNodeId;
  return nodes.value.find((node) => node.id === remoteNodeId) ?? null;
});
const connectionSelectionStepLabel = computed(() => {
  if (connectionSelectionStep.value === "a") return "第 1 步 · 选择端点 A：点击拓扑中的一个节点。";
  if (connectionSelectionStep.value === "b") return `第 2 步 · 选择端点 B：已选 A“${connectionSelectionFromNode.value?.name ?? "当前节点"}”，点击另一个节点完成配对。`;
  if (connectionSelectionStep.value === "config") return "第 3 步 · 配置双端：连接已建立，分别编辑两端会话参数。";
  return "点击“添加连接”，再按拓扑中的 A → B 顺序选择两端。";
});

function peerForSide(side: "left" | "right"): Peer | null {
  const domain = draft.value;
  const adjacency = selectedAdjacency.value;
  const session = selectedPairSessions.value[side];
  if (!domain || !adjacency || !session) return null;
  const remoteNodeId =
    side === "left" ? adjacency.rightNodeId : adjacency.leftNodeId;
  const remoteSessionId =
    side === "left" ? adjacency.rightSessionId : adjacency.leftSessionId;
  const remote = domain.members.find(
    (member) => member.nodeId === remoteNodeId,
  );
  const remoteNode = nodes.value.find((node) => node.id === remoteNodeId);
  if (!remote) return null;
  return {
    id: session.peerId,
    nodeId: session.nodeId,
    name: remoteNode?.name ?? remoteNodeId,
    address: remote.address,
    asn: domain.asn,
    port: sessionDrafts.value[remoteSessionId]?.localPort ?? remoteNode?.listenPort ?? 179,
    managedBy: session.managedBy,
  };
}

const leftPeer = computed(() => peerForSide("left"));
const rightPeer = computed(() => peerForSide("right"));
const leftNode = computed(() =>
  nodes.value.find((node) => node.id === selectedAdjacency.value?.leftNodeId) ?? null,
);
const rightNode = computed(() =>
  nodes.value.find((node) => node.id === selectedAdjacency.value?.rightNodeId) ?? null,
);
const selectedPreviewSides = computed(() =>
  previewSides.value.filter(
    (item) => item.session.managedBy?.adjacencyId === selectedAdjacencyId.value,
  ),
);

function protocolRuntime(session: BgpSession | null): NodeRuntime["protocols"][number] | null {
  if (!session) return null;
  return runtimeByNodeId.value[session.nodeId]?.protocols.find(
    (protocol) => protocol.name === session.protocolName,
  ) ?? null;
}

function sessionStatus(session: BgpSession | null): string {
  if (session && !session.enabled) return "已停用";
  const protocol = protocolRuntime(session);
  if (!protocol) return "未获取";
  if (protocol.established) return "已建立";
  if (protocol.state) return protocol.state;
  return protocol.configured ? "未连接" : "未配置";
}

function sessionStatusClass(session: BgpSession | null): string {
  const protocol = protocolRuntime(session);
  if (protocol?.established) return "status-established";
  if (protocol?.state?.toLowerCase() === "idle" || protocol?.state?.toLowerCase() === "active") return "status-warning";
  return "status-unknown";
}

async function refreshIbgpRuntimes(): Promise<void> {
  const domain = draft.value;
  if (!domain || !domain.members.length) return;
  const requestId = ++runtimeRefreshSequence;
  const domainId = domain.id;
  const nodeIds = domain.members.map((member) => member.nodeId);
  const results = await Promise.allSettled(
    nodeIds.map((nodeId) => api<{ runtime: NodeRuntime }>(`/api/nodes/${encodeURIComponent(nodeId)}/runtime`)),
  );
  const next: Record<string, NodeRuntime> = {};
  results.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value.runtime) {
      const nodeId = nodeIds[index];
      if (nodeId) next[nodeId] = result.value.runtime;
    }
  });
  if (!mounted || requestId !== runtimeRefreshSequence || draft.value?.id !== domainId) return;
  runtimeByNodeId.value = next;
}

function previewForSession(sessionId: string): IbgpPreviewSide | null {
  return selectedPreviewSides.value.find((item) => item.session.id === sessionId) ?? null;
}

const leftPreview = computed(() =>
  leftSession.value ? previewForSession(leftSession.value.id) : null,
);
const rightPreview = computed(() =>
  rightSession.value ? previewForSession(rightSession.value.id) : null,
);

function markDraftDirty(): void {
  draftDirty.value = true;
}

function confirmDiscardDraft(): boolean {
  if (saving.value) return false;
  if (!draftDirty.value) return true;
  return window.confirm("当前 iBGP 域有未保存的双端配置，切换后将丢失这些修改。是否继续？");
}

function handleDomainSelect(event: Event): void {
  const next = (event.target as HTMLSelectElement).value || null;
  if (next) selectDomain(next);
  (event.target as HTMLSelectElement).value = selectedDomainId.value ?? "";
}

async function focusPairSide(side: "left" | "right"): Promise<void> {
  endpointView.value = side;
  await nextTick();
  const target = side === "left" ? leftSideColumn.value : rightSideColumn.value;
  target?.scrollTo({ top: 0 });
  const panel = target?.closest<HTMLElement>(".ibgp-pair-workspace");
  panel?.scrollTo({ top: 0 });
  if (window.matchMedia("(max-width: 1099px)").matches) panel?.scrollIntoView({ block: "start" });
}

const workflowSteps = computed(() => [
  { id: "domain", title: "域与节点", detail: `${draft.value?.members.length ?? 0} 个成员 · AS${draft.value?.asn ?? '未设置'}` },
  { id: "connections", title: "连接与双端", detail: draft.value?.adjacencies.length ? `${draft.value.adjacencies.length} 条连接 · 分端编辑` : "在拓扑中选择端点 A 和端点 B" },
  { id: "review", title: "预检与应用", detail: previewValid.value ? "当前草稿已通过预检" : "检查所有受影响节点", disabled: previewPending.value },
]);
async function focusWorkflowStep(id: string): Promise<void> {
  if (id === "review") {
    reviewOpen.value = true;
    await runPreview();
    await nextTick();
  }
  const selector = id === "domain" ? ".ibgp-domain-strip" : id === "connections" ? ".ibgp-connection-panel" : ".ibgp-change-review";
  const target = workspace.value?.querySelector<HTMLElement>(selector);
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
  target?.focus({ preventScroll: true });
}

function clone<T>(value: T): T {
  return cloneReactive(value);
}

function domainNodes(domain: IbgpDomain): ManagedNode[] {
  const memberIds = new Set(domain.members.map((member) => member.nodeId));
  return nodes.value.filter((node) => memberIds.has(node.id));
}

function defaultLayoutFor(index: number): {
  x: number;
  y: number;
  locked: boolean;
} {
  return {
    x: 36 + (index % 4) * 190,
    y: 40 + Math.floor(index / 4) * 140,
    locked: false,
  };
}

function layoutFor(
  nodeId: string,
  index: number,
): { x: number; y: number; locked: boolean } {
  const saved = draft.value?.layout[nodeId] ?? defaultLayoutFor(index);
  // Keep the topology readable on narrow screens without changing the
  // persisted desktop coordinates. On narrow screens all nodes use a compact
  // two-column presentation so the saved desktop layout cannot crop them.
  // The canvas is mounted after the draft is loaded. During that first
  // render its clientWidth can still be zero, so fall back to the viewport
  // width and apply the compact presentation immediately on mobile.
  const viewportWidth =
    canvasViewportWidth.value ||
    (typeof window !== "undefined" ? window.innerWidth : 0);
  if (viewportWidth > 0 && viewportWidth < 620) {
    return {
      ...saved,
      x: 24 + (index % 2) * 166,
      y: 36 + Math.floor(index / 2) * 122,
    };
  }
  return saved;
}

function refreshCanvasViewport(): void {
  canvasViewportWidth.value = canvas.value?.clientWidth ?? 0;
}

function layoutForId(nodeId: string): { x: number; y: number; locked: boolean } {
  const index = draft.value ? domainNodes(draft.value).findIndex(node => node.id === nodeId) : 0;
  return layoutFor(nodeId, Math.max(0, index));
}

function makeDraft(): IbgpDomain {
  const members = nodes.value.map(
    (node): IbgpMember => ({
      nodeId: node.id,
      // Router ID is an identifier, not a transport endpoint. New domains
      // require an explicit IGP address (or the user can set it on the node).
      address: node.igpAddress ?? "",
    }),
  );
  return {
    id: "",
    name: "新 iBGP 域",
    asn: members.length
      ? (currentInventory.value?.sessions.find(
          (session) => session.nodeId === members[0]?.nodeId,
        )?.localAsn ?? 65000)
      : 65000,
    members,
    adjacencies: [],
    layout: Object.fromEntries(
      members.map((member, index) => [member.nodeId, defaultLayoutFor(index)]),
    ),
  };
}

function makeSession(
  adjacency: IbgpAdjacency,
  side: "left" | "right",
): BgpSession {
  const domain = draft.value!;
  const nodeId = side === "left" ? adjacency.leftNodeId : adjacency.rightNodeId;
  const localNode = nodes.value.find((node) => node.id === nodeId);
  const localMember = domain.members.find(
    (member) => member.nodeId === nodeId,
  )!;
  const remoteNodeId =
    side === "left" ? adjacency.rightNodeId : adjacency.leftNodeId;
  const remoteNode = nodes.value.find((node) => node.id === remoteNodeId);
  const sessionId =
    side === "left" ? adjacency.leftSessionId : adjacency.rightSessionId;
  const peerId = `${adjacency.id}_peer_${side}`;
  return {
    id: sessionId,
    nodeId,
    peerId,
    protocolName: uniqueBirdName(
      currentInventory.value ?? {
        version: 31,
        nodes: [],
        peers: [],
        defines: [],
        functions: [],
        filters: [],
        rpki: [],
        staticProtocols: [],
        directProtocols: [],
        kernelProtocols: [],
        pipeProtocols: [],
        sourcePolicies: [],
        sessions: [],
        ibgpDomains: [],
        ospfDomains: [],
        ospfLayout: {},
      },
      "ibgp",
      `${domain.name} ${remoteNode?.name ?? remoteNodeId}`,
      [],
      48,
    ),
    localAddress: localMember.address,
    localAsn: domain.asn,
    localPort: localNode?.listenPort ?? 179,
    bgp: { ...defaultBgpOptions(), connectionMode: "multihop" },
    channels: {
      ipv4: defaultChannel(),
      ipv6: defaultChannel(),
    },
    enabled: adjacency.enabled,
    sessionType: "ibgp",
    managedBy: {
      kind: "ibgp-domain",
      domainId: domain.id || "ibgp_preview",
      adjacencyId: adjacency.id,
    },
  };
}

function ensureAdjacencySessions(adjacency: IbgpAdjacency): void {
  for (const side of ["left", "right"] as const) {
    const id =
      side === "left" ? adjacency.leftSessionId : adjacency.rightSessionId;
    sessionDrafts.value[id] ??= makeSession(adjacency, side);
  }
}

function domainPayload(value: IbgpDomain): Record<string, unknown> {
  return {
    ...clone(value),
    sessionUpdates: Object.values(sessionDrafts.value).map(clone),
  };
}

async function loadDomains(): Promise<void> {
  const requestId = ++domainLoadSequence;
  loading.value = true;
  error.value = "";
  try {
    const response = await api<{ domains: IbgpDomain[]; inventory: Inventory; inventoryRevision?: number | null }>("/api/ibgp-domains");
    if (!mounted || requestId !== domainLoadSequence) return;
    if (draftDirty.value || saving.value) return;
    inventoryRevision.value = response.inventoryRevision;
    inventorySnapshot.value = response.inventory;
    domains.value = response.domains;
    if (
      selectedDomainId.value &&
      response.domains.some((domain) => domain.id === selectedDomainId.value)
    )
      selectDomain(selectedDomainId.value, true);
    else if (response.domains[0]) selectDomain(response.domains[0].id, true);
    await refreshIbgpRuntimes();
  } catch (cause) {
    if (!mounted || requestId !== domainLoadSequence) return;
    error.value = cause instanceof Error ? cause.message : "无法加载 iBGP 域";
  } finally {
    if (requestId === domainLoadSequence) loading.value = false;
  }
}

function selectDomain(domainId: string, reload = false): void {
  const domain = domains.value.find((item) => item.id === domainId);
  if (!domain) return;
  if (domain.id === selectedDomainId.value && !reload) return;
  if (!confirmDiscardDraft()) return;
  resetReview();
  runtimeRefreshSequence += 1;
  selectedDomainId.value = domainId;
  draft.value = clone(domain);
  selectedNodeId.value = domain.members[0]?.nodeId ?? null;
  selectedAdjacencyId.value = domain.adjacencies[0]?.id ?? null;
  const authoritativeSessions = inventorySnapshot.value?.sessions
    ?? dashboard.value?.inventory.sessions
    ?? [];
  suppressDraftDirty = true;
  try {
    sessionDrafts.value = Object.fromEntries(
      authoritativeSessions
        .filter((session) => session.managedBy?.domainId === domainId)
        .map((session) => [session.id, clone(session)]),
    );
    for (const adjacency of draft.value.adjacencies)
      ensureAdjacencySessions(adjacency);
  } finally {
    suppressDraftDirty = false;
  }
  draftDirty.value = false;
  connectionSelectionStep.value = "idle";
  connectionSelectionFirstNodeId.value = null;
  void refreshIbgpRuntimes();
}

function newDomain(): void {
  if (!confirmDiscardDraft()) return;
  resetReview();
  runtimeRefreshSequence += 1;
  selectedDomainId.value = null;
  draft.value = makeDraft();
  selectedNodeId.value = draft.value.members[0]?.nodeId ?? null;
  selectedAdjacencyId.value = null;
  suppressDraftDirty = true;
  sessionDrafts.value = {};
  suppressDraftDirty = false;
  connectionSelectionStep.value = "idle";
  connectionSelectionFirstNodeId.value = null;
  previewSides.value = [];
  previewValid.value = null;
  draftDirty.value = false;
  runtimeByNodeId.value = {};
}

function resetReview(): void {
  reviewed.value = null;
  previewValid.value = null;
  previewSides.value = [];
  previewError.value = "";
  conflict.value = false;
  latestContext.value = null;
  reviewOpen.value = false;
  deploymentResult.value = null;
}

async function compareLatest(): Promise<void> {
  try {
    latestContext.value = await api("/api/ibgp-domains");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "读取最新版本失败"; }
}
function rebaseDraft(useLatest: boolean): void {
  const context = latestContext.value;
  if (!context || !draft.value) return;
  const latest = context.domains.find(item => item.id === selectedDomainId.value);
  domains.value = context.domains;
  inventorySnapshot.value = context.inventory;
  inventoryRevision.value = context.inventoryRevision;
  conflict.value = false;
  latestContext.value = null;
  reviewed.value = null;
  if (useLatest) {
    draftDirty.value = false;
    if (latest) selectDomain(latest.id, true);
    else newDomain();
  } else if (selectedDomainId.value && !latest) {
    selectedDomainId.value = null;
    draft.value.id = "";
    // A deleted session cannot restore masked credentials from the server.
    for (const session of Object.values(sessionDrafts.value)) {
      if (session.bgp.password === "********") session.bgp.password = "";
      if (session.bgp.aoKeys === "********") session.bgp.aoKeys = "";
    }
  }
  schedulePreview();
}

async function saveDomain(): Promise<void> {
  if (!draft.value || saving.value || conflict.value || layoutSaving.value) return;
  if (!reviewed.value || reviewed.value.signature !== previewSignature.value || !reviewed.value.response.valid) {
    reviewOpen.value = true;
    await runPreview();
    return;
  }
  const accepted = reviewed.value;
  const names = accepted.response.configs?.map(item => item.nodeName) ?? [];
  if (!window.confirm(`将应用 iBGP 域“${draft.value.name}”的配置${names.length ? `，影响节点：${names.join("、")}` : ""}。是否确认下发？`)) return;
  // The browser confirmation may have remained open while async state changed.
  if (accepted !== reviewed.value || accepted.signature !== previewSignature.value || conflict.value) return;
  saving.value = true;
  error.value = "";
  try {
    const path = selectedDomainId.value ? `/api/ibgp-domains/${selectedDomainId.value}` : "/api/ibgp-domains";
    const response = await api<{ domain: IbgpDomain; inventory: Inventory; inventoryRevision?: number | null; deployment?: typeof deploymentResult.value }>(path, {
      method: selectedDomainId.value ? "PUT" : "POST",
      body: JSON.stringify({ ...accepted.response.domain, layout: draft.value.layout, sessionUpdates: accepted.response.sessions,
        inventoryRevision: accepted.response.inventoryRevision, mode: "apply", previewId: accepted.response.previewId, candidateHash: accepted.response.candidateHash }),
    });
    domains.value = [...domains.value.filter(item => item.id !== response.domain.id), response.domain];
    inventorySnapshot.value = response.inventory;
    inventoryRevision.value = response.inventoryRevision;
    draftDirty.value = false;
    saving.value = false;
    selectDomain(response.domain.id, true);
    deploymentResult.value = response.deployment ?? null;
    window.dispatchEvent(new CustomEvent("birdbox:dashboard-selection", { detail: { nodeId: selectedNodeId.value, peerId: null } }));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存 iBGP 域失败";
    if (cause instanceof ApiError && cause.code === "STATE_CONFLICT") conflict.value = true;
    if (cause instanceof ApiError && cause.code === "IBGP_PREVIEW_STALE") reviewed.value = null;
  } finally { saving.value = false; }
}

async function removeDomain(): Promise<void> {
  if (
    saving.value ||
    !selectedDomainId.value ||
    !window.confirm("删除该 iBGP 域及其全部双向会话？")
  )
    return;
  saving.value = true;
  try {
    const response = await api<{ inventory: Inventory; inventoryRevision?: number | null }>(`/api/ibgp-domains/${selectedDomainId.value}`, {
      method: "DELETE", body: JSON.stringify({ inventoryRevision: inventoryRevision.value }),
    });
    inventorySnapshot.value = response.inventory;
    inventoryRevision.value = response.inventoryRevision;
    domains.value = domains.value.filter(
      (domain) => domain.id !== selectedDomainId.value,
    );
    draftDirty.value = false;
    saving.value = false;
    if (domains.value[0]) selectDomain(domains.value[0].id);
    else newDomain();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "删除 iBGP 域失败";
    if (cause instanceof ApiError && cause.code === "STATE_CONFLICT") conflict.value = true;
  } finally {
    saving.value = false;
  }
}

async function saveLayout(): Promise<void> {
  if (!selectedDomainId.value || !draft.value || saving.value) return;
  const domainId = selectedDomainId.value;
  const revision = inventoryRevision.value;
  layoutSaving.value = true;
  try {
    const response = await api<{ inventoryRevision?: number | null }>(`/api/ibgp-domains/${domainId}/layout`, {
      method: "PATCH",
      body: JSON.stringify({ layout: draft.value.layout }),
    });
    if (selectedDomainId.value === domainId && typeof revision === "number" && response.inventoryRevision === revision + 1) inventoryRevision.value = response.inventoryRevision;
    reviewed.value = null;
    schedulePreview();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存拓扑位置失败";
  } finally {
    layoutSaving.value = false;
  }
}

function selectNode(nodeId: string): void {
  if (connectionSelectionStep.value === "a") {
    connectionSelectionFirstNodeId.value = nodeId;
    selectedNodeId.value = nodeId;
    selectedAdjacencyId.value = null;
    connectionSelectionStep.value = "b";
    return;
  }
  if (connectionSelectionStep.value === "b") {
    const firstNodeId = connectionSelectionFirstNodeId.value;
    if (!firstNodeId) {
      connectionSelectionStep.value = "a";
      return;
    }
    if (firstNodeId === nodeId) return;
    selectedNodeId.value = firstNodeId;
    connectNode(nodeId);
    connectionSelectionStep.value = "config";
    // A new adjacency is a two-sided editing task. Show both endpoint
    // editors immediately instead of making the user discover the toggle.
    endpointView.value = "both";
    return;
  }
  selectedNodeId.value = nodeId;
  const adjacency = draft.value?.adjacencies.find(
    (item) => item.leftNodeId === nodeId || item.rightNodeId === nodeId,
  );
  selectedAdjacencyId.value = adjacency?.id ?? null;
}

function startConnectionSelection(): void {
  if (!draft.value || draft.value.members.length < 2) return;
  connectionSelectionStep.value = "a";
  connectionSelectionFirstNodeId.value = null;
  selectedAdjacencyId.value = null;
}

function selectConnectionSelectionStep(step: "a" | "b" | "config"): void {
  if (step === "a") {
    startConnectionSelection();
    return;
  }
  if (connectionSelectionFirstNodeId.value) connectionSelectionStep.value = "b";
  if (step === "config" && selectedAdjacency.value) connectionSelectionStep.value = "config";
}

function startDrag(event: PointerEvent, nodeId: string): void {
  if (!draft.value || draft.value.layout[nodeId]?.locked) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dragging.value = {
    nodeId,
    dx: event.clientX - rect.left,
    dy: event.clientY - rect.top,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function dragNode(event: PointerEvent): void {
  if (!dragging.value || !canvas.value || !draft.value) return;
  const rect = canvas.value.getBoundingClientRect();
  dragging.value.moved = true;
  draft.value.layout[dragging.value.nodeId] = {
    ...(draft.value.layout[dragging.value.nodeId] ?? { locked: false }),
    x: Math.max(8, Math.round(event.clientX - rect.left - dragging.value.dx)),
    y: Math.max(8, Math.round(event.clientY - rect.top - dragging.value.dy)),
  };
}

function stopDrag(): void {
  if (!dragging.value) return;
  const moved = dragging.value.moved;
  dragging.value = null;
  if (moved) void saveLayout();
}

function connectionTo(nodeId: string): IbgpAdjacency | null {
  if (!draft.value || !selectedNodeId.value) return null;
  return (
    draft.value.adjacencies.find(
      (item) =>
        (item.leftNodeId === selectedNodeId.value &&
          item.rightNodeId === nodeId) ||
        (item.leftNodeId === nodeId &&
          item.rightNodeId === selectedNodeId.value),
    ) ?? null
  );
}

function makeClientAdjacencyId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  const fallback = `${Date.now().toString(36)}_${(adjacencySequence += 1).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `ibgp_adj_${(uuid ?? fallback).replaceAll("-", "").slice(0, 24)}`;
}

function connectNode(nodeId: string): void {
  if (!draft.value || !selectedNodeId.value || selectedNodeId.value === nodeId)
    return;
  const existing = connectionTo(nodeId);
  if (existing) {
    selectedAdjacencyId.value = existing.id;
    return;
  }
  const id = makeClientAdjacencyId();
  markDraftDirty();
  const adjacency: IbgpAdjacency = {
    id,
    leftNodeId: selectedNodeId.value,
    rightNodeId: nodeId,
    enabled: true,
    leftSessionId: `${id}_left`,
    rightSessionId: `${id}_right`,
  };
  draft.value.adjacencies.push(adjacency);
  ensureAdjacencySessions(adjacency);
  selectedAdjacencyId.value = adjacency.id;
}

function removeConnection(adjacency: IbgpAdjacency): void {
  if (!draft.value) return;
  markDraftDirty();
  draft.value.adjacencies = draft.value.adjacencies.filter(
    (item) => item.id !== adjacency.id,
  );
  delete sessionDrafts.value[adjacency.leftSessionId];
  delete sessionDrafts.value[adjacency.rightSessionId];
  if (selectedAdjacencyId.value === adjacency.id)
    selectedAdjacencyId.value = draft.value.adjacencies[0]?.id ?? null;
}

function updateSessionDraft(sessionId: string, session: BgpSession): void {
  if (!draft.value) return;
  markDraftDirty();
  sessionDrafts.value[sessionId] = session;
  const member = draft.value.members.find((item) => item.nodeId === session.nodeId);
  if (member) {
    member.address = session.localAddress ?? "";
  }
}

function openPolicyAction(
  sessionId: string,
  family: AddressFamily,
  direction: "import" | "export",
): void {
  policyActionContext.value = { sessionId, family, direction };
  policyActionDialog.value?.open(family, direction);
}

function insertPolicyFunction(resource: PolicyFunction): void {
  const context = policyActionContext.value;
  const session = context ? sessionDrafts.value[context.sessionId] : null;
  if (!session || !context) return;
  const { family, direction } = context;
  const channel = session.channels[family];
  const policyKey = direction === "import" ? "importPolicy" : "exportPolicy";
  const policy: ChannelPolicy = channel[policyKey];
  if (
    policy.steps.some(
      (step) => step.type === "function" && step.functionId === resource.id,
    )
  )
    return;
  const steps = [...policy.steps];
  const formIndex = steps.findIndex((step) => step.type === "form");
  steps.splice(formIndex < 0 ? steps.length : formIndex, 0, {
    type: "function",
    functionId: resource.id,
    action: "execute",
  });
  if (!steps.some((step) => step.type === "form")) steps.push({ type: "form" });
  channel[policyKey] = { ...policy, mode: "combined", steps, filterId: null, inlineFilterSource: null };
  policyActionContext.value = null;
}

const previewSignature = computed(() => {
  if (!draft.value) return null;
  const { layout: _layout, ...domain } = draft.value;
  return JSON.stringify({ ...domain, sessionUpdates: Object.values(sessionDrafts.value) });
});

function schedulePreview(): void {
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  reviewed.value = null;
  previewValid.value = null;
  previewSides.value = [];
  if (!previewSignature.value || conflict.value || saving.value) return;
  previewTimer = window.setTimeout(() => void runPreview(), 650);
}
async function runPreview(): Promise<void> {
  if (!mounted || !draft.value || conflict.value || saving.value) return;
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  if (previewPending.value) { previewQueued = true; return; }
  const signature = previewSignature.value;
  if (!signature) return;
  const domainId = selectedDomainId.value;
  const revision = inventoryRevision.value;
  reviewed.value = null;
  previewValid.value = null;
  previewPending.value = true;
  previewError.value = "";
  try {
    const response = await api<IbgpDomainPreviewResponse>("/api/ibgp-domains/preview", {
      method: "POST", body: JSON.stringify({ ...domainPayload(draft.value), inventoryRevision: revision }), mutationWait: false,
    });
    if (!mounted) return;
    if (signature !== previewSignature.value || domainId !== selectedDomainId.value || revision !== inventoryRevision.value) { previewQueued = true; return; }
    // Keep typed credentials and unsaved fields. The normalized candidate lives only in the reviewed snapshot.
    reviewed.value = { signature, response };
    previewSides.value = response.sides;
    previewValid.value = response.valid;
  } catch (cause) {
    if (!mounted || signature !== previewSignature.value || domainId !== selectedDomainId.value || revision !== inventoryRevision.value) { previewQueued = true; return; }
    previewValid.value = false;
    previewError.value = cause instanceof Error ? cause.message : "iBGP 两端配置预检失败";
    if (cause instanceof ApiError && cause.code === "STATE_CONFLICT") conflict.value = true;
  } finally {
    previewPending.value = false;
    if (previewQueued) { previewQueued = false; schedulePreview(); }
  }
}
function beforeUnload(event: BeforeUnloadEvent): void {
  if (draftDirty.value || saving.value) { event.preventDefault(); event.returnValue = ""; }
}
function confirmLeave(): boolean {
  return !saving.value && (!draftDirty.value || window.confirm("当前 iBGP 域有未应用修改，是否离开？草稿会保留在当前页面中。"));
}
defineExpose({ confirmLeave });

watch(previewSignature, schedulePreview);
watch([selectedAdjacencyId, selectedNodeId], () => { endpointView.value = selectedAdjacency.value?.rightNodeId === selectedNodeId.value ? "right" : "left"; });
watch(
  sessionDrafts,
  () => {
    if (!suppressDraftDirty) draftDirty.value = true;
  },
  { deep: true, flush: "sync" },
);
watch(
  () => dashboard.value?.inventory.nodes,
  () => {
    if (draft.value && !draft.value.id && !draft.value.members.length)
      draft.value = makeDraft();
  },
  { deep: true },
);
watch(draft, () => void nextTick(refreshCanvasViewport), { flush: "post" });

function handleAppReady(): void {
  void loadDomains();
}

onMounted(() => {
  mounted = true;
  window.addEventListener("birdbox:app-ready", handleAppReady);
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("resize", refreshCanvasViewport);
  void nextTick(refreshCanvasViewport);
  runtimeTimer = window.setInterval(() => void refreshIbgpRuntimes(), 10000);
});
onBeforeUnmount(() => {
  mounted = false;
  domainLoadSequence += 1;
  runtimeRefreshSequence += 1;
  window.removeEventListener("birdbox:app-ready", handleAppReady);
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("resize", refreshCanvasViewport);
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  if (runtimeTimer !== null) window.clearInterval(runtimeTimer);
});
</script>

<template>
  <section ref="workspace" class="ibgp-workspace" aria-labelledby="ibgpTitle">
    <div class="section-heading">
      <div>
        <p class="eyebrow">INTERNAL BGP</p>
        <h2 id="ibgpTitle">iBGP 管理</h2>
        <p class="section-note">
          域内节点默认不建立连接；点击“添加连接”，再在拓扑中选择端点 A 和端点 B。
        </p>
      </div>
      <div class="ibgp-toolbar">
        <select
          :disabled="saving"
          :value="selectedDomainId ?? ''"
          aria-label="选择 iBGP 域"
          @change="handleDomainSelect"
        >
          <option :value="null">选择域</option>
          <option v-for="domain in domains" :key="domain.id" :value="domain.id">
            {{ domain.name }} · AS{{ domain.asn }}
          </option>
        </select>
        <button class="secondary-button" type="button" :disabled="saving" @click="newDomain">
          新建域
        </button>
        <button
          v-if="selectedDomainId"
          class="text-danger-button"
          type="button"
          :disabled="saving"
          @click="removeDomain"
        >
          删除
        </button>
      </div>
    </div>
    <ProtocolWorkflow v-if="draft" label="iBGP 配置步骤" :steps="workflowSteps" :disabled="saving" @select="focusWorkflowStep" />
    <div v-if="draft" class="protocol-context-strip" role="status"><strong>{{ draft.name || '未命名域' }}</strong><span>{{ draftDirty ? '有未保存修改' : selectedDomainId ? '已保存' : '新域 · 尚未应用' }}</span><span>影响范围：{{ draft.members.length }} 个成员；保存域会预检并下发配置</span></div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <section v-if="conflict" class="ibgp-status-notice" role="alert">
      <p>库存已变化，当前双端草稿已保留。请读取最新配置，对比后重新预检。</p>
      <button class="secondary-button" type="button" @click="compareLatest">加载最新版本并对比</button>
      <template v-if="latestContext">
        <p>本地：{{ draft?.name }} · {{ draft?.adjacencies.length }} 条邻接；最新：{{ latestContext.domains.find(item => item.id === selectedDomainId)?.name ?? '域已删除' }} · {{ latestContext.domains.find(item => item.id === selectedDomainId)?.adjacencies.length ?? 0 }} 条邻接</p>
        <button class="secondary-button" type="button" @click="rebaseDraft(true)">采用最新配置</button>
        <button class="secondary-button" type="button" @click="rebaseDraft(false)">保留本地草稿并重新预检</button>
      </template>
    </section>
    <details v-if="reviewOpen" class="ibgp-change-review" tabindex="-1" open>
      <summary>预检与配置变更 · {{ previewPending ? '检查中' : previewValid === true ? '通过' : previewValid === false ? '未通过' : '待预检' }}</summary>
      <p v-if="previewError" class="form-error">{{ previewError }}</p>
      <p v-if="!previewPending && !previewError && !reviewed?.response.configs?.length">暂无节点配置差异；空域不会建立邻接。</p>
      <details v-for="item in reviewed?.response.configs ?? []" :key="item.nodeId">
        <summary>{{ item.nodeName }} · {{ item.validation.ok ? '通过' : '失败' }}</summary>
        <p v-if="!item.validation.ok" class="form-error">{{ item.validation.stderr || item.validation.stdout }}</p>
        <pre>{{ item.diff }}</pre>
      </details>
      <button class="primary-button" type="button" :disabled="saving || previewPending || !previewValid || conflict" @click="saveDomain">确认应用</button>
    </details>
    <p v-if="saving" class="ibgp-status-notice" role="status">正在预检和应用各节点配置，请保持页面打开。</p>
    <section v-if="deploymentResult" class="ibgp-status-notice" role="status">
      <p>应用完成</p>
      <p v-for="item in deploymentResult.nodeResults ?? []" :key="item.nodeId">{{ nodes.find(node => node.id === item.nodeId)?.name ?? item.nodeId }} · {{ item.status === 'success' ? '成功' : item.status }} {{ item.error ?? '' }}</p>
    </section>
    <div v-if="loading" class="empty-state">正在加载 iBGP 域…</div>
    <div v-else-if="!draft" class="empty-state">
      <strong>还没有 iBGP 域</strong
      ><button class="secondary-button" type="button" @click="newDomain">
        创建第一个域
      </button>
    </div>
    <div v-else class="ibgp-layout" :class="{ 'has-pair': !!selectedAdjacency, 'compare-endpoints': endpointView === 'both' }" :inert="saving || undefined">
      <section class="ibgp-canvas-panel">
        <div class="ibgp-domain-strip" tabindex="-1">
          <div class="field">
            <label for="ibgpName">域名称</label
            ><input id="ibgpName" v-model.trim="draft.name" maxlength="80" @input="markDraftDirty" />
          </div>
          <div class="field">
            <label for="ibgpAsn">内部 ASN</label
            ><input
              id="ibgpAsn"
              v-model.number="draft.asn"
              type="number"
              min="1"
              max="4294967295"
              @input="markDraftDirty"
            />
          </div>
        </div>
        <div class="panel-head">
          <div>
            <h3>iBGP 拓扑</h3>
            <small
              >{{ draft.members.length }} 个节点 ·
              {{ draft.adjacencies.length }} 条双向连接</small
            >
          </div>
          <button
            class="secondary-button compact-button"
            type="button"
            :disabled="layoutSaving || !selectedDomainId"
            @click="saveLayout"
          >
            {{ layoutSaving ? "保存中" : "保存位置" }}
          </button>
        </div>
        <div
          ref="canvas"
          class="ibgp-canvas"
          @pointermove="dragNode"
          @pointerup="stopDrag"
          @pointercancel="stopDrag"
        >
          <svg class="ibgp-edges" aria-hidden="true">
            <line
              v-for="edge in draft.adjacencies"
              :key="edge.id"
              :class="{ selected: selectedAdjacencyId === edge.id }"
              :x1="layoutForId(edge.leftNodeId).x + 72"
              :y1="layoutForId(edge.leftNodeId).y + 34"
              :x2="layoutForId(edge.rightNodeId).x + 72"
              :y2="layoutForId(edge.rightNodeId).y + 34"
            />
          </svg>
          <button
            v-for="(node, index) in domainNodes(draft)"
            :key="node.id"
            class="ibgp-node"
            :class="{
              selected: selectedNodeId === node.id,
              'connect-source': connectionSelectionStep === 'b' && connectionSelectionFirstNodeId === node.id,
              'connect-target': connectionSelectionStep === 'a' || (connectionSelectionStep === 'b' && connectionSelectionFirstNodeId !== node.id),
            }"
            type="button"
            :style="{
              left: `${layoutFor(node.id, index).x}px`,
              top: `${layoutFor(node.id, index).y}px`,
            }"
            @pointerdown="startDrag($event, node.id)"
            @click="selectNode(node.id)"
          >
            <span v-if="connectionSelectionStep === 'b' && connectionSelectionFirstNodeId === node.id" class="ibgp-node-endpoint-badge ibgp-node-endpoint-a">A</span>
            <span v-else-if="connectionSelectionStep === 'config' && selectedAdjacency && (selectedAdjacency.leftNodeId === node.id || selectedAdjacency.rightNodeId === node.id)" class="ibgp-node-endpoint-badge ibgp-node-endpoint-b">{{ connectionSelectionFirstNodeId === node.id ? 'A' : 'B' }}</span>
            <strong>{{ node.name }}</strong
            ><span
              >{{
                draft.adjacencies.filter(
                  (item) =>
                    item.leftNodeId === node.id || item.rightNodeId === node.id,
                ).length
              }}
              条连接</span
            ><small>{{
              draft.members.find((member) => member.nodeId === node.id)?.address
            }}</small>
          </button>
        </div>
      </section>

      <section class="ibgp-connection-panel" tabindex="-1">
        <div class="ibgp-connection-controls">
          <div class="subsection-head">
            <div>
              <h3>拓扑连接</h3>
              <span v-if="connectionSelectionStep !== 'idle'" role="status" aria-live="polite">{{ connectionSelectionStepLabel }}</span>
              <span v-else>点击“添加连接”，在拓扑中依次选择端点 A 和端点 B</span>
            </div>
            <button class="primary-button compact-button" type="button" :disabled="draft.members.length < 2" @click="startConnectionSelection">添加连接</button>
          </div>
          <div v-if="connectionSelectionStep !== 'idle'" class="ibgp-connection-selection-flow" aria-label="添加 iBGP 连接步骤">
            <button type="button" class="ibgp-connection-selection-step" :class="{ active: connectionSelectionStep === 'a', done: !!connectionSelectionFromNode }" @click="selectConnectionSelectionStep('a')"><span>1</span><strong>选择端点 A</strong><small>拓扑节点</small></button>
            <button type="button" class="ibgp-connection-selection-step" :class="{ active: connectionSelectionStep === 'b' }" :disabled="!connectionSelectionFromNode" @click="selectConnectionSelectionStep('b')"><span>2</span><strong>选择端点 B</strong><small>拓扑节点</small></button>
            <button type="button" class="ibgp-connection-selection-step" :class="{ active: connectionSelectionStep === 'config' }" :disabled="!selectedAdjacency" @click="selectConnectionSelectionStep('config')"><span>3</span><strong>配置双端</strong><small>分别编辑会话</small></button>
            <p class="ibgp-connection-selection-hint">{{ connectionSelectionStepLabel }}</p>
          </div>
          <div v-if="connectionSelectionStep !== 'idle'" class="ibgp-connection-selection-summary" aria-label="当前连接端点">
            <button type="button" class="ibgp-connection-endpoint-card" :class="{ active: connectionSelectionStep === 'a', ready: !!connectionSelectionFromNode }" @click="selectConnectionSelectionStep('a')"><small>端点 A</small><strong>{{ connectionSelectionFromNode?.name ?? '待选择' }}</strong></button>
            <span aria-hidden="true">↔</span>
            <button type="button" class="ibgp-connection-endpoint-card" :class="{ active: connectionSelectionStep === 'b' }" :disabled="!connectionSelectionFromNode" @click="selectConnectionSelectionStep('b')"><small>端点 B</small><strong>{{ connectionSelectionToNode?.name ?? (connectionSelectionStep === 'b' ? '点击拓扑节点' : '待选择') }}</strong></button>
          </div>
        </div>
      </section>

      <section v-if="selectedAdjacency" class="ibgp-pair-workspace">
        <div class="subsection-head ibgp-pair-heading">
          <div>
            <h3>双端会话配置</h3>
            <span>{{ leftNode?.name }} ↔ {{ rightNode?.name }}</span>
          </div>
          <div v-if="selectedAdjacency" class="ibgp-pair-status">
            <span :class="['ibgp-status', sessionStatusClass(leftSession)]"><i />{{ leftNode?.name }}：{{ sessionStatus(leftSession) }}</span>
            <span :class="['ibgp-status', sessionStatusClass(rightSession)]"><i />{{ rightNode?.name }}：{{ sessionStatus(rightSession) }}</span>
          </div>
          <label class="compact-toggle"><span>启用当前连接</span><input v-model="selectedAdjacency.enabled" type="checkbox" @change="markDraftDirty" /><i aria-hidden="true" /></label>
          <button class="secondary-button compact-button text-danger-button" type="button" @click="removeConnection(selectedAdjacency)">移除连接</button>
          <div class="ibgp-pair-jump" role="group" aria-label="选择编辑端点">
            <button class="secondary-button compact-button" type="button" :aria-pressed="endpointView === 'left'" @click="focusPairSide('left')">编辑 {{ leftNode?.name }}</button>
            <button class="secondary-button compact-button" type="button" :aria-pressed="endpointView === 'right'" @click="focusPairSide('right')">编辑 {{ rightNode?.name }}</button>
            <button class="secondary-button compact-button" type="button" :aria-pressed="endpointView === 'both'" @click="endpointView = 'both'">同时查看双端</button>
          </div>
          <span
            :class="{
              'preview-valid': previewValid,
              'preview-invalid': previewValid === false,
            }"
            >{{
              previewPending
                ? "正在实时预检"
                : previewValid === true
                  ? "双方检查通过"
                  : previewValid === false
                    ? "候选配置有误"
                    : "等待预检"
            }}</span
          >
        </div>
        <p v-if="previewError" class="form-error" role="alert">
          {{ previewError }}
        </p>
        <p class="protocol-help">{{ endpointView === 'both' ? '双端对照：每端配置独立保存。' : `当前编辑：${endpointView === 'left' ? leftNode?.name : rightNode?.name}。切换端点保留全部草稿。` }} 导入为从对端接收，导出为向对端发布。</p>
        <div class="ibgp-session-grid" :class="{ 'single-side': endpointView !== 'both' }">
          <div v-if="leftSession && leftPeer && leftNode" v-show="endpointView !== 'right'" ref="leftSideColumn" class="ibgp-side-column">
            <IbgpSessionSideEditor
              :model-value="leftSession"
              side="left"
              :node-name="leftNode.name"
              :peer="leftPeer"
              :defines="inventoryDefines"
              :functions="inventoryFunctions"
              :filters="inventoryFilters"
              @dirty="markDraftDirty"
              @update:model-value="updateSessionDraft(selectedAdjacency.leftSessionId, $event)"
              @open-policy-action="
                openPolicyAction(
                  selectedAdjacency.leftSessionId,
                  $event.family,
                  $event.direction,
                )
              "
            />
            <details class="ibgp-preview-section">
              <summary>查看 {{ leftNode.name }} 的候选配置</summary>
              <div class="tabs ibgp-preview-tabs" role="tablist">
                <button class="tab active" type="button" role="tab" aria-selected="true">
                  节点配置
                </button>
                <span>{{ leftPreview?.validation.ok ? "检查通过" : "等待检查" }}</span>
              </div>
              <div class="tab-panels ibgp-preview-panels">
                <pre class="tab-panel active">{{ leftPreview?.config || "# 正在生成候选配置" }}</pre>
              </div>
              <small v-if="leftPreview && !leftPreview.validation.ok" class="ibgp-preview-error">{{
                leftPreview.validation.stderr || leftPreview.validation.stdout
              }}</small>
            </details>
          </div>

          <div v-if="rightSession && rightPeer && rightNode" v-show="endpointView !== 'left'" ref="rightSideColumn" class="ibgp-side-column">
            <IbgpSessionSideEditor
              :model-value="rightSession"
              side="right"
              :node-name="rightNode.name"
              :peer="rightPeer"
              :defines="inventoryDefines"
              :functions="inventoryFunctions"
              :filters="inventoryFilters"
              @dirty="markDraftDirty"
              @update:model-value="updateSessionDraft(selectedAdjacency.rightSessionId, $event)"
              @open-policy-action="
                openPolicyAction(
                  selectedAdjacency.rightSessionId,
                  $event.family,
                  $event.direction,
                )
              "
            />
            <details class="ibgp-preview-section">
              <summary>查看 {{ rightNode.name }} 的候选配置</summary>
              <div class="tabs ibgp-preview-tabs" role="tablist">
                <button class="tab active" type="button" role="tab" aria-selected="true">
                  节点配置
                </button>
                <span>{{ rightPreview?.validation.ok ? "检查通过" : "等待检查" }}</span>
              </div>
              <div class="tab-panels ibgp-preview-panels">
                <pre class="tab-panel active">{{ rightPreview?.config || "# 正在生成候选配置" }}</pre>
              </div>
              <small v-if="rightPreview && !rightPreview.validation.ok" class="ibgp-preview-error">{{
                rightPreview.validation.stderr || rightPreview.validation.stdout
              }}</small>
            </details>
          </div>
        </div>
        <p v-if="!leftSession || !rightSession" class="field-help">
          正在生成双方会话草稿…
        </p>
      </section>
    </div>
    <div v-if="draft" class="protocol-action-bar" role="region" aria-label="iBGP 配置操作">
      <span class="protocol-action-state">{{ draftDirty ? '有待应用修改' : '当前配置' }} · {{ previewValid ? '预检通过' : '应用前需预检' }} · {{ draft.members.length }} 个成员</span>
      <div class="form-actions">
        <button class="secondary-button" type="button" :disabled="saving || previewPending || conflict || !draft" @click="reviewOpen = true; runPreview()">预检并查看变更</button>
        <button
          class="primary-button"
          type="button"
          :disabled="
            saving || previewPending || !draft || conflict || layoutSaving
          "
          @click="saveDomain"
        >
          {{ saving ? "正在保存" : draftDirty ? "保存域 · 有未保存修改" : "保存域" }}
        </button>
      </div>
    </div>
  </section>
  <PolicyActionDialog
    ref="policyActionDialog"
    :local-asn="draft?.asn ?? null"
    :node-id="policySession?.nodeId ?? null"
    @saved="insertPolicyFunction"
  />
</template>
