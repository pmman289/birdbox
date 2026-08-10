<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from "vue";

import type {
  AddressFamily,
  BgpSession,
  IbgpAdjacency,
  IbgpDomain,
  IbgpMember,
  ManagedNode,
} from "@birdbox/contracts/inventory";

import { useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";

const { dashboard } = useDashboardStore();
const domains = ref<IbgpDomain[]>([]);
const selectedDomainId = ref<string | null>(null);
const selectedNodeId = ref<string | null>(null);
const draft = ref<IbgpDomain | null>(null);
const sessionDrafts = ref<Record<string, BgpSession>>({});
const loading = ref(false);
const saving = ref(false);
const layoutSaving = ref(false);
const error = ref("");
const canvas = ref<HTMLElement | null>(null);
const dragging = ref<{ nodeId: string; dx: number; dy: number } | null>(null);
const activeSide = ref<"left" | "right">("left");

const nodes = computed<ManagedNode[]>(
  () => dashboard.value?.inventory.nodes ?? [],
);
const selectedNode = computed(
  () => nodes.value.find((node) => node.id === selectedNodeId.value) ?? null,
);
const selectedAdjacency = computed(
  () =>
    draft.value?.adjacencies.find(
      (item) =>
        item.leftNodeId === selectedNodeId.value ||
        item.rightNodeId === selectedNodeId.value,
    ) ?? null,
);
const selectedPairSessions = computed(() => {
  const adjacency = selectedAdjacency.value;
  if (!adjacency) return { left: null, right: null };
  return {
    left:
      sessionDrafts.value[adjacency.leftSessionId] ??
      dashboard.value?.inventory.sessions.find(
        (item) => item.id === adjacency.leftSessionId,
      ) ??
      null,
    right:
      sessionDrafts.value[adjacency.rightSessionId] ??
      dashboard.value?.inventory.sessions.find(
        (item) => item.id === adjacency.rightSessionId,
      ) ??
      null,
  };
});
const activeSession = computed(
  () => selectedPairSessions.value[activeSide.value],
);
const selectedMember = computed(
  () =>
    draft.value?.members.find(
      (member) => member.nodeId === selectedNodeId.value,
    ) ?? null,
);
const activeFamily = ref<AddressFamily>("ipv4");
const activePolicyDirection = ref<"import" | "export">("import");

function clone<T>(value: T): T {
  return structuredClone(toRaw(value as object)) as T;
}

function domainNodes(domain: IbgpDomain): ManagedNode[] {
  const memberIds = new Set(domain.members.map((member) => member.nodeId));
  return nodes.value.filter((node) => memberIds.has(node.id));
}

function defaultLayout(
  nodeId: string,
  index: number,
): { x: number; y: number; locked: boolean } {
  return (
    draft.value?.layout[nodeId] ?? {
      x: 36 + (index % 4) * 190,
      y: 40 + Math.floor(index / 4) * 140,
      locked: false,
    }
  );
}

function makeDraft(): IbgpDomain {
  const members = nodes.value.map(
    (node, index): IbgpMember => ({
      nodeId: node.id,
      address4: node.routerId,
      address6: null,
      role: "member",
      clusterId: null,
    }),
  );
  const layout = Object.fromEntries(
    members.map((member, index) => [member.nodeId, defaultLayoutFor(index)]),
  );
  return {
    id: "",
    name: "新 iBGP 域",
    asn: members.length
      ? (dashboard.value?.inventory.sessions.find(
          (session) => session.nodeId === members[0]?.nodeId,
        )?.localAsn ?? 65000)
      : 65000,
    topology: "full-mesh",
    families: ["ipv4"],
    defaultClusterId: null,
    members,
    adjacencies: [],
    layout,
  };
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

function domainPayload(value: IbgpDomain): Record<string, unknown> {
  return {
    ...clone(value),
    sessionUpdates: Object.values(sessionDrafts.value).map((session) => ({
      id: session.id,
      protocolName: session.protocolName,
      localAddress: session.localAddress,
      localPort: session.localPort,
      bgp: session.bgp,
      channels: session.channels,
    })),
  };
}

function rebuildLocalAdjacencies(): void {
  if (!draft.value || draft.value.topology === "manual") return;
  const pairs: Array<{ leftNodeId: string; rightNodeId: string }> = [];
  if (draft.value.topology === "full-mesh") {
    draft.value.members.forEach((left, index) =>
      draft.value?.members
        .slice(index + 1)
        .forEach((right) =>
          pairs.push({ leftNodeId: left.nodeId, rightNodeId: right.nodeId }),
        ),
    );
  } else {
    const reflectors = draft.value.members.filter(
      (member) => member.role === "reflector",
    );
    const clients = draft.value.members.filter(
      (member) => member.role !== "reflector",
    );
    reflectors.forEach((left) =>
      clients
        .filter((right) => right.nodeId !== left.nodeId)
        .forEach((right) =>
          pairs.push({ leftNodeId: left.nodeId, rightNodeId: right.nodeId }),
        ),
    );
  }
  const old = new Map(
    draft.value.adjacencies.map((item) => [
      `${item.leftNodeId}:${item.rightNodeId}`,
      item,
    ]),
  );
  draft.value.adjacencies = pairs.map((pair, index) => {
    const prior =
      old.get(`${pair.leftNodeId}:${pair.rightNodeId}`) ??
      old.get(`${pair.rightNodeId}:${pair.leftNodeId}`);
    const id = prior?.id ?? `${draft.value?.id || "ibgp_new"}_adj_${index + 1}`;
    return (
      prior ?? {
        id,
        ...pair,
        enabled: true,
        leftSessionId: `${id}_left`,
        rightSessionId: `${id}_right`,
      }
    );
  });
}

async function loadDomains(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const response = await api<{ domains: IbgpDomain[] }>("/api/ibgp-domains");
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
  sessionDrafts.value = Object.fromEntries(
    (dashboard.value?.inventory.sessions ?? [])
      .filter((session) => session.managedBy?.domainId === domainId)
      .map((session) => [session.id, clone(session)]),
  );
  activeSide.value = "left";
  rebuildLocalAdjacencies();
}

function newDomain(): void {
  selectedDomainId.value = null;
  draft.value = makeDraft();
  selectedNodeId.value = draft.value.members[0]?.nodeId ?? null;
  sessionDrafts.value = {};
  rebuildLocalAdjacencies();
}

async function saveDomain(): Promise<void> {
  if (!draft.value) return;
  saving.value = true;
  error.value = "";
  try {
    const path = selectedDomainId.value
      ? `/api/ibgp-domains/${selectedDomainId.value}`
      : "/api/ibgp-domains";
    const response = await api<{ domain: IbgpDomain }>(path, {
      method: selectedDomainId.value ? "PUT" : "POST",
      body: JSON.stringify(domainPayload(draft.value)),
    });
    domains.value = selectedDomainId.value
      ? domains.value.map((domain) =>
          domain.id === response.domain.id ? response.domain : domain,
        )
      : [...domains.value, response.domain];
    selectDomain(response.domain.id);
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
    !window.confirm("删除该 iBGP 域及其生成的双向会话？")
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
  if (!draft.value?.id) return;
  layoutSaving.value = true;
  try {
    await api(`/api/ibgp-domains/${draft.value.id}/layout`, {
      method: "PATCH",
      body: JSON.stringify({ layout: draft.value.layout }),
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存拓扑位置失败";
  } finally {
    layoutSaving.value = false;
  }
}

function startDrag(event: PointerEvent, nodeId: string): void {
  if (!draft.value || draft.value.layout[nodeId]?.locked) return;
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  dragging.value = {
    nodeId,
    dx: event.clientX - rect.left,
    dy: event.clientY - rect.top,
  };
  target.setPointerCapture(event.pointerId);
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

function toggleConnection(nodeId: string): void {
  if (!draft.value || !selectedNodeId.value || selectedNodeId.value === nodeId)
    return;
  const existing = draft.value.adjacencies.find(
    (item) =>
      (item.leftNodeId === selectedNodeId.value &&
        item.rightNodeId === nodeId) ||
      (item.leftNodeId === nodeId && item.rightNodeId === selectedNodeId.value),
  );
  if (existing) existing.enabled = !existing.enabled;
  else {
    const id = `${draft.value.id || "ibgp_new"}_adj_${draft.value.adjacencies.length + 1}`;
    draft.value.adjacencies.push({
      id,
      leftNodeId: selectedNodeId.value,
      rightNodeId: nodeId,
      enabled: true,
      leftSessionId: `${id}_left`,
      rightSessionId: `${id}_right`,
    });
  }
}

function setMember<K extends keyof IbgpMember>(
  key: K,
  value: IbgpMember[K],
): void {
  if (selectedMember.value) selectedMember.value[key] = value;
  if (key === "role") rebuildLocalAdjacencies();
}

function updateSessionField<K extends keyof BgpSession>(
  key: K,
  value: BgpSession[K],
): void {
  const session = activeSession.value;
  if (session) sessionDrafts.value[session.id] = { ...session, [key]: value };
}

function updateSessionBgp<K extends keyof BgpSession["bgp"]>(
  key: K,
  value: BgpSession["bgp"][K],
): void {
  const session = activeSession.value;
  if (session)
    sessionDrafts.value[session.id] = {
      ...session,
      bgp: { ...session.bgp, [key]: value },
    };
}

function updatePolicy(
  direction: "import" | "export",
  value: "all" | "none" | "cidr",
): void {
  const session = activeSession.value;
  if (!session) return;
  const family = session.channels[activeFamily.value];
  const policy =
    direction === "import" ? family.importPolicy : family.exportPolicy;
  const next = {
    ...policy,
    mode: "form" as const,
    formAction: value,
    steps: [],
    filterId: null,
  };
  const exportDefineId =
    direction === "export" && value === "cidr"
      ? (family.exportDefineId ??
        dashboard.value?.cidrDefines[activeFamily.value][0]?.id ??
        null)
      : family.exportDefineId;
  const channels = {
    ...session.channels,
    [activeFamily.value]: {
      ...family,
      exportDefineId,
      [direction === "import" ? "importPolicy" : "exportPolicy"]: next,
    },
  };
  sessionDrafts.value[session.id] = { ...session, channels };
}

function updatePolicyMode(
  direction: "import" | "export",
  mode: "form" | "combined" | "custom",
): void {
  const session = activeSession.value;
  if (!session) return;
  const family = session.channels[activeFamily.value];
  const key = direction === "import" ? "importPolicy" : "exportPolicy";
  const policy = family[key];
  const next =
    mode === "custom"
      ? {
          ...policy,
          mode,
          steps: [],
          filterId: dashboard.value?.filters[0]?.id ?? null,
        }
      : mode === "combined"
        ? {
            ...policy,
            mode,
            steps: policy.steps.length
              ? policy.steps
              : [{ type: "form" as const }],
            filterId: null,
          }
        : { ...policy, mode, steps: [], filterId: null };
  sessionDrafts.value[session.id] = {
    ...session,
    channels: {
      ...session.channels,
      [activeFamily.value]: { ...family, [key]: next },
    },
  };
}

function addPolicyFunction(
  direction: "import" | "export",
  functionId: string,
): void {
  if (!functionId) return;
  const session = activeSession.value;
  if (!session) return;
  const family = session.channels[activeFamily.value];
  const key = direction === "import" ? "importPolicy" : "exportPolicy";
  const policy = family[key];
  if (
    policy.steps.some(
      (step) => step.type === "function" && step.functionId === functionId,
    )
  )
    return;
  const formIndex = policy.steps.findIndex((step) => step.type === "form");
  const steps = [...policy.steps];
  steps.splice(formIndex < 0 ? steps.length : formIndex, 0, {
    type: "function" as const,
    functionId,
    action: "execute" as const,
  });
  if (!steps.some((step) => step.type === "form"))
    steps.push({ type: "form" as const });
  sessionDrafts.value[session.id] = {
    ...session,
    channels: {
      ...session.channels,
      [activeFamily.value]: {
        ...family,
        [key]: { ...policy, mode: "combined", steps, filterId: null },
      },
    },
  };
}

function updatePolicyFilter(
  direction: "import" | "export",
  filterId: string,
): void {
  const session = activeSession.value;
  if (!session) return;
  const family = session.channels[activeFamily.value];
  const key = direction === "import" ? "importPolicy" : "exportPolicy";
  sessionDrafts.value[session.id] = {
    ...session,
    channels: {
      ...session.channels,
      [activeFamily.value]: {
        ...family,
        [key]: {
          ...family[key],
          mode: "custom",
          steps: [],
          filterId: filterId || null,
        },
      },
    },
  };
}

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

onMounted(() => {
  window.addEventListener("birdbox:app-ready", handleAppReady);
});

onBeforeUnmount(() => {
  window.removeEventListener("birdbox:app-ready", handleAppReady);
});
</script>

<template>
  <section class="ibgp-workspace" aria-labelledby="ibgpTitle">
    <div class="section-heading">
      <div>
        <p class="eyebrow">INTERNAL BGP</p>
        <h2 id="ibgpTitle">iBGP 域管理</h2>
        <p class="section-note">
          用一个域维护 ASN、拓扑、节点角色和双向邻接配置。
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
          </option></select
        ><button class="secondary-button" type="button" @click="newDomain">
          新建域</button
        ><button
          class="primary-button"
          type="button"
          :disabled="saving || !draft"
          @click="saveDomain"
        >
          {{ saving ? "正在保存" : "保存域" }}</button
        ><button
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
    <div v-else class="ibgp-grid">
      <section class="ibgp-canvas-panel">
        <div class="panel-head">
          <div>
            <h3>域拓扑画布</h3>
            <small
              >{{
                draft.topology === "full-mesh"
                  ? "全网状"
                  : draft.topology === "route-reflector"
                    ? "Route Reflector"
                    : "手工邻接"
              }}
              · {{ draft.members.length }} 个节点</small
            >
          </div>
          <button
            class="secondary-button compact-button"
            type="button"
            :disabled="layoutSaving || !draft.id"
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
              v-for="edge in draft.adjacencies.filter((item) => item.enabled)"
              :key="edge.id"
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
              left: `${defaultLayout(node.id, index).x}px`,
              top: `${defaultLayout(node.id, index).y}px`,
            }"
            @pointerdown="startDrag($event, node.id)"
            @click="selectedNodeId = node.id"
          >
            <strong>{{ node.name }}</strong
            ><span>{{
              draft.members.find((member) => member.nodeId === node.id)?.role ??
              "member"
            }}</span
            ><small>{{ node.routerId }}</small>
          </button>
        </div>
      </section>
      <aside class="ibgp-editor-panel">
        <div class="ibgp-form-grid">
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
          <div class="field">
            <label>拓扑模式</label
            ><select v-model="draft.topology" @change="rebuildLocalAdjacencies">
              <option value="full-mesh">Full Mesh</option>
              <option value="route-reflector">Route Reflector</option>
              <option value="manual">Manual</option>
            </select>
          </div>
          <div class="field">
            <label>地址族</label>
            <div class="check-row">
              <label
                ><input v-model="draft.families" type="checkbox" value="ipv4" />
                IPv4</label
              ><label
                ><input v-model="draft.families" type="checkbox" value="ipv6" />
                IPv6</label
              >
            </div>
          </div>
          <div class="field full-width">
            <label for="ibgpCluster">默认 Cluster ID</label
            ><input
              id="ibgpCluster"
              v-model.trim="draft.defaultClusterId"
              placeholder="可选，例如 10.0.0.254"
            />
          </div>
        </div>
        <section v-if="selectedNode" class="ibgp-subsection">
          <div class="subsection-head">
            <h3>节点角色与地址</h3>
            <span>{{ selectedNode.name }}</span>
          </div>
          <div class="ibgp-form-grid">
            <div class="field">
              <label>角色</label
              ><select
                :value="selectedMember?.role"
                @change="
                  setMember(
                    'role',
                    ($event.target as HTMLSelectElement)
                      .value as IbgpMember['role'],
                  )
                "
              >
                <option value="member">普通成员</option>
                <option value="reflector">Route Reflector</option>
                <option value="client">RR Client</option>
              </select>
            </div>
            <div class="field">
              <label>IPv4 地址</label
              ><input
                :value="selectedMember?.address4 ?? ''"
                placeholder="自动使用 Router ID"
                @input="
                  setMember(
                    'address4',
                    ($event.target as HTMLInputElement).value || null,
                  )
                "
              />
            </div>
            <div class="field">
              <label>IPv6 地址</label
              ><input
                :value="selectedMember?.address6 ?? ''"
                placeholder="可选"
                @input="
                  setMember(
                    'address6',
                    ($event.target as HTMLInputElement).value || null,
                  )
                "
              />
            </div>
            <div class="field">
              <label>节点 Cluster ID</label
              ><input
                :value="selectedMember?.clusterId ?? ''"
                placeholder="继承域默认"
                @input="
                  setMember(
                    'clusterId',
                    ($event.target as HTMLInputElement).value || null,
                  )
                "
              />
            </div>
          </div>
        </section>
        <section class="ibgp-subsection">
          <div class="subsection-head">
            <h3>快速选择邻接</h3>
            <span>点击其它节点切换连接</span>
          </div>
          <div class="quick-node-list">
            <button
              v-for="node in domainNodes(draft)"
              :key="node.id"
              class="quick-node"
              :class="{
                active: draft.adjacencies.some(
                  (item) =>
                    item.enabled &&
                    ((item.leftNodeId === selectedNodeId &&
                      item.rightNodeId === node.id) ||
                      (item.rightNodeId === selectedNodeId &&
                        item.leftNodeId === node.id)),
                ),
              }"
              type="button"
              :disabled="node.id === selectedNodeId"
              @click="toggleConnection(node.id)"
            >
              {{ node.name
              }}<span>{{
                node.id === selectedNodeId
                  ? "当前节点"
                  : draft.adjacencies.some(
                        (item) =>
                          item.enabled &&
                          ((item.leftNodeId === selectedNodeId &&
                            item.rightNodeId === node.id) ||
                            (item.rightNodeId === selectedNodeId &&
                              item.leftNodeId === node.id)),
                      )
                    ? "已连接"
                    : "未连接"
              }}</span>
            </button>
          </div>
        </section>
        <section v-if="selectedAdjacency" class="ibgp-subsection">
          <div class="subsection-head">
            <h3>双向会话编辑</h3>
            <div class="side-tabs">
              <button
                type="button"
                :class="{ active: activeSide === 'left' }"
                @click="activeSide = 'left'"
              >
                {{
                  nodes.find(
                    (node) => node.id === selectedAdjacency?.leftNodeId,
                  )?.name
                }}
                本端</button
              ><button
                type="button"
                :class="{ active: activeSide === 'right' }"
                @click="activeSide = 'right'"
              >
                {{
                  nodes.find(
                    (node) => node.id === selectedAdjacency?.rightNodeId,
                  )?.name
                }}
                本端
              </button>
            </div>
          </div>
          <div v-if="activeSession" class="ibgp-form-grid">
            <div class="field">
              <label>协议名称</label
              ><input
                :value="activeSession.protocolName"
                @input="
                  updateSessionField(
                    'protocolName',
                    ($event.target as HTMLInputElement).value,
                  )
                "
              />
            </div>
            <div class="field">
              <label>本地地址</label
              ><input
                :value="activeSession.localAddress ?? ''"
                placeholder="自动选择"
                @input="
                  updateSessionField(
                    'localAddress',
                    ($event.target as HTMLInputElement).value || null,
                  )
                "
              />
            </div>
            <div class="field">
              <label>连接方式</label
              ><select
                :value="activeSession.bgp.connectionMode"
                @change="
                  updateSessionBgp(
                    'connectionMode',
                    ($event.target as HTMLSelectElement)
                      .value as BgpSession['bgp']['connectionMode'],
                  )
                "
              >
                <option value="multihop">Multihop</option>
                <option value="direct">Direct</option>
              </select>
            </div>
            <div class="field">
              <label>Route Reflector</label
              ><label class="toggle-line"
                ><input
                  type="checkbox"
                  :checked="activeSession.bgp.rrClient"
                  @change="
                    updateSessionBgp(
                      'rrClient',
                      ($event.target as HTMLInputElement).checked,
                    )
                  "
                />
                rr client</label
              >
            </div>
            <div class="field">
              <label>Cluster ID</label
              ><input
                :value="activeSession.bgp.rrClusterId ?? ''"
                @input="
                  updateSessionBgp(
                    'rrClusterId',
                    ($event.target as HTMLInputElement).value || null,
                  )
                "
              />
            </div>
            <div class="field">
              <label>地址族</label
              ><select v-model="activeFamily">
                <option value="ipv4">IPv4</option>
                <option value="ipv6">IPv6</option>
              </select>
            </div>
            <div class="field">
              <label>策略方向</label
              ><select v-model="activePolicyDirection">
                <option value="import">Import</option>
                <option value="export">Export</option>
              </select>
            </div>
            <div class="field">
              <label>策略模式</label
              ><select
                :value="
                  activeSession.channels[activeFamily][
                    activePolicyDirection === 'import'
                      ? 'importPolicy'
                      : 'exportPolicy'
                  ].mode
                "
                @change="
                  updatePolicyMode(
                    activePolicyDirection,
                    ($event.target as HTMLSelectElement).value as
                      | 'form'
                      | 'combined'
                      | 'custom',
                  )
                "
              >
                <option value="form">表单</option>
                <option value="combined">Function + 表单</option>
                <option value="custom">Filter</option>
              </select>
            </div>
            <div class="field">
              <label
                >{{
                  activePolicyDirection === "import" ? "Import" : "Export"
                }}
                动作</label
              ><select
                :value="
                  activeSession.channels[activeFamily][
                    activePolicyDirection === 'import'
                      ? 'importPolicy'
                      : 'exportPolicy'
                  ].formAction
                "
                @change="
                  updatePolicy(
                    activePolicyDirection,
                    ($event.target as HTMLSelectElement).value as
                      | 'all'
                      | 'none',
                  )
                "
              >
                <option value="all">all</option>
                <option value="none">none</option>
                <option v-if="activePolicyDirection === 'export'" value="cidr">
                  CIDR Define
                </option>
              </select>
            </div>
            <div
              v-if="
                activeSession.channels[activeFamily][
                  activePolicyDirection === 'import'
                    ? 'importPolicy'
                    : 'exportPolicy'
                ].mode === 'combined'
              "
              class="field full-width"
            >
              <label>快捷加入 Function</label
              ><select
                @change="
                  addPolicyFunction(
                    activePolicyDirection,
                    ($event.target as HTMLSelectElement).value,
                  )
                "
              >
                <option value="">选择 Function</option>
                <option
                  v-for="item in dashboard?.functions ?? []"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.name }}
                </option>
              </select>
            </div>
            <div
              v-if="
                activeSession.channels[activeFamily][
                  activePolicyDirection === 'import'
                    ? 'importPolicy'
                    : 'exportPolicy'
                ].mode === 'custom'
              "
              class="field full-width"
            >
              <label>Filter</label
              ><select
                :value="
                  activeSession.channels[activeFamily][
                    activePolicyDirection === 'import'
                      ? 'importPolicy'
                      : 'exportPolicy'
                  ].filterId ?? ''
                "
                @change="
                  updatePolicyFilter(
                    activePolicyDirection,
                    ($event.target as HTMLSelectElement).value,
                  )
                "
              >
                <option value="">选择 Filter</option>
                <option
                  v-for="item in dashboard?.filters ?? []"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.name }}
                </option>
              </select>
            </div>
          </div>
          <p v-else class="field-help">该邻接尚未生成会话，请先保存域。</p>
        </section>
      </aside>
    </div>
  </section>
</template>
