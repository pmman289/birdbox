<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type {
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

import { useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
import { cloneReactive } from "../shared/clone-reactive";
import { uniqueBirdName } from "../shared/resource-names";
import PolicyActionDialog from "../sessions/PolicyActionDialog.vue";
import { defaultBgpOptions, defaultChannel } from "../sessions/session-draft";
import IbgpSessionSideEditor from "./IbgpSessionSideEditor.vue";

const { dashboard } = useDashboardStore();
const domains = ref<IbgpDomain[]>([]);
const selectedDomainId = ref<string | null>(null);
const selectedNodeId = ref<string | null>(null);
const selectedAdjacencyId = ref<string | null>(null);
const draft = ref<IbgpDomain | null>(null);
const sessionDrafts = ref<Record<string, BgpSession>>({});
const loading = ref(false);
const saving = ref(false);
const layoutSaving = ref(false);
const error = ref("");
const connectionSearch = ref("");
const canvas = ref<HTMLElement | null>(null);
const dragging = ref<{ nodeId: string; dx: number; dy: number } | null>(null);
const previewPending = ref(false);
const previewValid = ref<boolean | null>(null);
const previewError = ref("");
const previewSides = ref<IbgpPreviewSide[]>([]);
const inventorySnapshot = ref<Inventory | null>(null);
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

const currentInventory = computed<Inventory | null>(
  () => dashboard.value?.inventory ?? inventorySnapshot.value,
);
const nodes = computed<ManagedNode[]>(
  () => currentInventory.value?.nodes ?? [],
);
const selectedNode = computed(
  () => nodes.value.find((node) => node.id === selectedNodeId.value) ?? null,
);
const selectedMember = computed(
  () =>
    draft.value?.members.find(
      (member) => member.nodeId === selectedNodeId.value,
    ) ?? null,
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
const connectionCandidates = computed(() => {
  const domain = draft.value;
  if (!domain || !selectedNodeId.value) return [];
  const query = connectionSearch.value.trim().toLowerCase();
  return domainNodes(domain).filter((node) => {
    if (node.id === selectedNodeId.value) return false;
    if (!query) return true;
    const address = domain.members.find((member) => member.nodeId === node.id)?.address ?? "";
    return `${node.name} ${node.id} ${address}`.toLowerCase().includes(query);
  });
});

function peerForSide(side: "left" | "right"): Peer | null {
  const domain = draft.value;
  const adjacency = selectedAdjacency.value;
  const session = selectedPairSessions.value[side];
  if (!domain || !adjacency || !session) return null;
  const remoteNodeId =
    side === "left" ? adjacency.rightNodeId : adjacency.leftNodeId;
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
    port: remoteNode?.listenPort ?? 179,
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

function previewForSession(sessionId: string): IbgpPreviewSide | null {
  return selectedPreviewSides.value.find((item) => item.session.id === sessionId) ?? null;
}

const leftPreview = computed(() =>
  leftSession.value ? previewForSession(leftSession.value.id) : null,
);
const rightPreview = computed(() =>
  rightSession.value ? previewForSession(rightSession.value.id) : null,
);

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
  return draft.value?.layout[nodeId] ?? defaultLayoutFor(index);
}

function makeDraft(): IbgpDomain {
  const members = nodes.value.map(
    (node): IbgpMember => ({
      nodeId: node.id,
      address: node.routerId,
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
        version: 27,
        nodes: [],
        peers: [],
        defines: [],
        functions: [],
        filters: [],
        rpki: [],
        staticProtocols: [],
        sourcePolicies: [],
        sessions: [],
        ibgpDomains: [],
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
  loading.value = true;
  error.value = "";
  try {
    const response = await api<{ domains: IbgpDomain[]; inventory: Inventory }>("/api/ibgp-domains");
    inventorySnapshot.value = response.inventory;
    domains.value = response.domains;
    if (
      selectedDomainId.value &&
      response.domains.some((domain) => domain.id === selectedDomainId.value)
    )
      selectDomain(selectedDomainId.value);
    else if (response.domains[0]) selectDomain(response.domains[0].id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法加载 iBGP 域";
  } finally {
    loading.value = false;
  }
}

function selectDomain(domainId: string): void {
  const domain = domains.value.find((item) => item.id === domainId);
  if (!domain) return;
  selectedDomainId.value = domainId;
  draft.value = clone(domain);
  selectedNodeId.value = domain.members[0]?.nodeId ?? null;
  selectedAdjacencyId.value = domain.adjacencies[0]?.id ?? null;
  const authoritativeSessions = inventorySnapshot.value?.sessions
    ?? dashboard.value?.inventory.sessions
    ?? [];
  sessionDrafts.value = Object.fromEntries(
    authoritativeSessions
      .filter((session) => session.managedBy?.domainId === domainId)
      .map((session) => [session.id, clone(session)]),
  );
  for (const adjacency of draft.value.adjacencies)
    ensureAdjacencySessions(adjacency);
  connectionSearch.value = "";
}

function newDomain(): void {
  selectedDomainId.value = null;
  draft.value = makeDraft();
  selectedNodeId.value = draft.value.members[0]?.nodeId ?? null;
  selectedAdjacencyId.value = null;
  sessionDrafts.value = {};
  connectionSearch.value = "";
  previewSides.value = [];
  previewValid.value = null;
}

async function saveDomain(): Promise<void> {
  if (!draft.value) return;
  saving.value = true;
  error.value = "";
  try {
    const path = selectedDomainId.value
      ? `/api/ibgp-domains/${selectedDomainId.value}`
      : "/api/ibgp-domains";
    const response = await api<{ domain: IbgpDomain; inventory: Inventory }>(path, {
      method: selectedDomainId.value ? "PUT" : "POST",
      body: JSON.stringify(domainPayload(draft.value)),
    });
    domains.value = selectedDomainId.value
      ? domains.value.map((domain) =>
          domain.id === response.domain.id ? response.domain : domain,
        )
      : [...domains.value, response.domain];
    selectedDomainId.value = response.domain.id;
    draft.value = clone(response.domain);
    inventorySnapshot.value = response.inventory;
    window.dispatchEvent(
      new CustomEvent("birdbox:dashboard-selection", {
        detail: { nodeId: selectedNodeId.value, peerId: null },
      }),
    );
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存 iBGP 域失败";
  } finally {
    saving.value = false;
  }
}

async function removeDomain(): Promise<void> {
  if (
    !selectedDomainId.value ||
    !window.confirm("删除该 iBGP 域及其全部双向会话？")
  )
    return;
  saving.value = true;
  try {
    await api(`/api/ibgp-domains/${selectedDomainId.value}`, {
      method: "DELETE",
    });
    domains.value = domains.value.filter(
      (domain) => domain.id !== selectedDomainId.value,
    );
    if (domains.value[0]) selectDomain(domains.value[0].id);
    else newDomain();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "删除 iBGP 域失败";
  } finally {
    saving.value = false;
  }
}

async function saveLayout(): Promise<void> {
  if (!selectedDomainId.value || !draft.value) return;
  layoutSaving.value = true;
  try {
    await api(`/api/ibgp-domains/${selectedDomainId.value}/layout`, {
      method: "PATCH",
      body: JSON.stringify({ layout: draft.value.layout }),
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存拓扑位置失败";
  } finally {
    layoutSaving.value = false;
  }
}

function selectNode(nodeId: string): void {
  selectedNodeId.value = nodeId;
  const adjacency = draft.value?.adjacencies.find(
    (item) => item.leftNodeId === nodeId || item.rightNodeId === nodeId,
  );
  if (adjacency) selectedAdjacencyId.value = adjacency.id;
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
  draft.value.layout[dragging.value.nodeId] = {
    ...(draft.value.layout[dragging.value.nodeId] ?? { locked: false }),
    x: Math.max(8, Math.round(event.clientX - rect.left - dragging.value.dx)),
    y: Math.max(8, Math.round(event.clientY - rect.top - dragging.value.dy)),
  };
}

function stopDrag(): void {
  if (!dragging.value) return;
  dragging.value = null;
  void saveLayout();
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
  draft.value.adjacencies = draft.value.adjacencies.filter(
    (item) => item.id !== adjacency.id,
  );
  delete sessionDrafts.value[adjacency.leftSessionId];
  delete sessionDrafts.value[adjacency.rightSessionId];
  if (selectedAdjacencyId.value === adjacency.id)
    selectedAdjacencyId.value = draft.value.adjacencies[0]?.id ?? null;
}

function setMember<K extends keyof IbgpMember>(
  key: K,
  value: IbgpMember[K],
): void {
  if (!selectedMember.value) return;
  selectedMember.value[key] = value;
  if (key !== "address") return;
  for (const session of Object.values(sessionDrafts.value)) {
    if (session.nodeId === selectedMember.value.nodeId) {
      session.localAddress = String(value);
    }
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
  channel[policyKey] = { ...policy, mode: "combined", steps, filterId: null };
  policyActionContext.value = null;
}

const previewSignature = computed(() => {
  if (!draft.value || !draft.value.adjacencies.length) return null;
  const { layout: _layout, ...domain } = draft.value;
  return JSON.stringify({
    ...domain,
    sessionUpdates: Object.values(sessionDrafts.value),
  });
});

function schedulePreview(): void {
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  if (!previewSignature.value) {
    previewSides.value = [];
    previewValid.value = null;
    previewError.value = "";
    return;
  }
  previewTimer = window.setTimeout(() => void runPreview(), 650);
}

async function runPreview(): Promise<void> {
  if (!draft.value) return;
  if (previewPending.value) {
    previewQueued = true;
    return;
  }
  const signature = previewSignature.value;
  if (!signature) return;
  previewPending.value = true;
  previewError.value = "";
  try {
    const response = await api<IbgpDomainPreviewResponse>(
      "/api/ibgp-domains/preview",
      {
        method: "POST",
        body: signature,
        mutationWait: false,
      },
    );
    if (signature !== previewSignature.value) {
      previewQueued = true;
      return;
    }
    if (!draft.value.id) draft.value.id = response.domain.id;
    draft.value.adjacencies = response.domain.adjacencies;
    sessionDrafts.value = Object.fromEntries(
      response.sessions.map((session) => [session.id, clone(session)]),
    );
    previewSides.value = response.sides;
    previewValid.value = response.valid;
  } catch (cause) {
    previewValid.value = false;
    previewError.value =
      cause instanceof Error ? cause.message : "iBGP 双端候选配置预检失败";
  } finally {
    previewPending.value = false;
    if (previewQueued) {
      previewQueued = false;
      schedulePreview();
    }
  }
}

watch(previewSignature, schedulePreview);
watch(
  () => dashboard.value?.inventory.nodes,
  () => {
    if (draft.value && !draft.value.id && !draft.value.members.length)
      draft.value = makeDraft();
  },
  { deep: true },
);

function handleAppReady(): void {
  void loadDomains();
}

onMounted(() => window.addEventListener("birdbox:app-ready", handleAppReady));
onBeforeUnmount(() => {
  window.removeEventListener("birdbox:app-ready", handleAppReady);
  if (previewTimer !== null) window.clearTimeout(previewTimer);
});
</script>

<template>
  <section class="ibgp-workspace" aria-labelledby="ibgpTitle">
    <div class="section-heading">
      <div>
        <p class="eyebrow">INTERNAL BGP</p>
        <h2 id="ibgpTitle">iBGP 管理</h2>
        <p class="section-note">
          域内节点默认不建立连接；请在画布中选择节点并手工建立双向邻接。
        </p>
      </div>
      <div class="ibgp-toolbar">
        <select
          v-model="selectedDomainId"
          aria-label="选择 iBGP 域"
          @change="selectedDomainId && selectDomain(selectedDomainId)"
        >
          <option :value="null">选择域</option>
          <option v-for="domain in domains" :key="domain.id" :value="domain.id">
            {{ domain.name }} · AS{{ domain.asn }}
          </option>
        </select>
        <button class="secondary-button" type="button" @click="newDomain">
          新建域
        </button>
        <button
          class="primary-button"
          type="button"
          :disabled="
            saving || previewPending || previewValid === false || !draft
          "
          @click="saveDomain"
        >
          {{ saving ? "正在保存" : "保存域" }}
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
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div v-if="loading" class="empty-state">正在加载 iBGP 域…</div>
    <div v-else-if="!draft" class="empty-state">
      <strong>还没有 iBGP 域</strong
      ><button class="secondary-button" type="button" @click="newDomain">
        创建第一个域
      </button>
    </div>
    <div v-else class="ibgp-layout">
      <section class="ibgp-canvas-panel">
        <div class="ibgp-domain-strip">
          <div class="field">
            <label for="ibgpName">域名称</label
            ><input id="ibgpName" v-model.trim="draft.name" maxlength="80" />
          </div>
          <div class="field">
            <label for="ibgpAsn">内部 ASN</label
            ><input
              id="ibgpAsn"
              v-model.number="draft.asn"
              type="number"
              min="1"
              max="4294967295"
            />
          </div>
        </div>
        <div class="panel-head">
          <div>
            <h3>手工邻接画布</h3>
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
              :x1="(draft.layout[edge.leftNodeId]?.x ?? 0) + 72"
              :y1="(draft.layout[edge.leftNodeId]?.y ?? 0) + 34"
              :x2="(draft.layout[edge.rightNodeId]?.x ?? 0) + 72"
              :y2="(draft.layout[edge.rightNodeId]?.y ?? 0) + 34"
            />
          </svg>
          <button
            v-for="(node, index) in domainNodes(draft)"
            :key="node.id"
            class="ibgp-node"
            :class="{ selected: selectedNodeId === node.id }"
            type="button"
            :style="{
              left: `${layoutFor(node.id, index).x}px`,
              top: `${layoutFor(node.id, index).y}px`,
            }"
            @pointerdown="startDrag($event, node.id)"
            @click="selectNode(node.id)"
          >
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

      <section class="ibgp-connection-panel">
        <div class="ibgp-connection-controls">
          <div class="subsection-head">
            <div>
              <h3>手工连接</h3>
              <span v-if="selectedNode">从 {{ selectedNode.name }} 选择对端节点</span>
              <span v-else>请先在画布中选择节点</span>
            </div>
          </div>
          <div v-if="selectedNode" class="field ibgp-transport-field">
            <label>节点连接地址</label
              ><input
                :value="selectedMember?.address ?? ''"
                placeholder="IPv4 或 IPv6 地址"
                @input="
                  setMember(
                    'address',
                    ($event.target as HTMLInputElement).value,
                  )
                "
              />
          </div>
          <div class="field ibgp-connection-search">
            <label for="ibgpConnectionSearch">搜索节点</label>
            <input
              id="ibgpConnectionSearch"
              v-model.trim="connectionSearch"
              type="search"
              placeholder="名称、ID 或连接地址"
              :disabled="!selectedNode"
            />
          </div>
        </div>
        <div class="quick-node-list" role="list" aria-label="可连接节点">
            <div
              v-for="node in connectionCandidates"
              :key="node.id"
              class="connection-list-row"
              role="listitem"
            >
              <button
                class="quick-node"
                :class="{
                  active: connectionTo(node.id)?.id === selectedAdjacencyId,
                }"
                type="button"
                @click="connectNode(node.id)"
              >
                <span><strong>{{ node.name }}</strong><small>{{
                  draft.members.find((member) => member.nodeId === node.id)?.address
                }}</small></span>
                <span>{{
                  connectionTo(node.id) ? "编辑双端配置" : "建立连接"
                }}</span></button
              ><button
                v-if="connectionTo(node.id)"
                class="compact-icon text-danger-button"
                type="button"
                title="移除连接"
                aria-label="移除连接"
                @click="removeConnection(connectionTo(node.id)!)"
              >
                ×
              </button>
            </div>
            <div v-if="selectedNode && !connectionCandidates.length" class="empty-cell">
              没有匹配的节点
            </div>
          </div>
      </section>

      <section v-if="selectedAdjacency" class="ibgp-pair-workspace">
        <div class="subsection-head ibgp-pair-heading">
          <div>
            <h3>双端会话配置</h3>
            <span>{{ leftNode?.name }} ↔ {{ rightNode?.name }}</span>
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
        <div class="ibgp-session-grid">
          <div v-if="leftSession && leftPeer && leftNode" class="ibgp-side-column">
            <IbgpSessionSideEditor
              :model-value="leftSession"
              :node-name="leftNode.name"
              :peer="leftPeer"
              :defines="inventoryDefines"
              :functions="inventoryFunctions"
              :filters="inventoryFilters"
              @update:model-value="
                sessionDrafts[selectedAdjacency.leftSessionId] = $event
              "
              @open-policy-action="
                openPolicyAction(
                  selectedAdjacency.leftSessionId,
                  $event.family,
                  $event.direction,
                )
              "
            />
            <section class="ibgp-preview-section">
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
            </section>
          </div>

          <div v-if="rightSession && rightPeer && rightNode" class="ibgp-side-column">
            <IbgpSessionSideEditor
              :model-value="rightSession"
              :node-name="rightNode.name"
              :peer="rightPeer"
              :defines="inventoryDefines"
              :functions="inventoryFunctions"
              :filters="inventoryFilters"
              @update:model-value="
                sessionDrafts[selectedAdjacency.rightSessionId] = $event
              "
              @open-policy-action="
                openPolicyAction(
                  selectedAdjacency.rightSessionId,
                  $event.family,
                  $event.direction,
                )
              "
            />
            <section class="ibgp-preview-section">
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
            </section>
          </div>
        </div>
        <p v-if="!leftSession || !rightSession" class="field-help">
          正在生成双方会话草稿…
        </p>
      </section>
    </div>
  </section>
  <PolicyActionDialog
    ref="policyActionDialog"
    :local-asn="draft?.asn ?? null"
    :node-id="policySession?.nodeId ?? null"
    @saved="insertPolicyFunction"
  />
</template>
