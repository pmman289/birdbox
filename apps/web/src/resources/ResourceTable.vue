<script setup lang="ts">
import { defineReferences } from "@birdbox/contracts/define-references";
import { computed, toRef } from "vue";

import type {
  Inventory,
  PolicyCollection,
  PolicyDefine,
  SourcePolicyEgress,
  StaticProtocol,
} from "@birdbox/contracts/inventory";

import type { ResourceEditKind } from "../shared/events";
import { useDashboardStore } from "../dashboard/dashboard-store";
import { nodeConnectionStatus } from "../shared/resource-list";
import { resourceScopeCompactLabel, resourceScopeLabel } from "../shared/resource-scope";

const props = defineProps<{ kind: ResourceEditKind; selectedNodeIds?: string[]; resourceIds?: string[]; reorderDisabled?: boolean }>();
const emit = defineEmits<{ (event: "toggle-node", nodeId: string): void }>();
const kind = toRef(props, "kind");
const { dashboard } = useDashboardStore();
const inventory = computed<Inventory | null>(() => dashboard.value?.inventory ?? null);
const nodeNames = computed(() => new Map((inventory.value?.nodes ?? []).map((node) => [node.id, node.name])));
const defineNames = computed(() => new Map((inventory.value?.defines ?? []).map((resource) => [resource.id, resource.label ?? resource.name])));
const visibleOrder = computed(() => new Map(props.resourceIds?.map((id, index) => [id, index]) ?? []));
function visible<T extends { id: string }>(resources: T[] | undefined): T[] {
  if (!props.resourceIds) return resources ?? [];
  return (resources ?? []).filter(resource => visibleOrder.value.has(resource.id)).sort((a, b) => visibleOrder.value.get(a.id)! - visibleOrder.value.get(b.id)!);
}
const externalPeers = computed(() => visible((inventory.value?.peers ?? []).filter(peer => !peer.managedBy)));
const defineOrder = computed(() => new Map((inventory.value?.defines ?? []).map((resource, i) => [resource.id, i + 1])));
const functionOrder = computed(() => new Map((inventory.value?.functions ?? []).map((resource, i) => [resource.id, i + 1])));
const nodeHealth = computed(() => new Map((dashboard.value?.health.nodeStatuses ?? []).map(node => [node.nodeId, node])));
function connectionLabel(nodeId: string): string {
  return ({ online: '在线', offline: '离线', unknown: '未检查' })[nodeConnectionStatus(nodeHealth.value.get(nodeId))]!;
}

function edit(kind: ResourceEditKind, id: string): void {
  window.dispatchEvent(new CustomEvent("birdbox:resource-edit", { detail: { kind, id } }));
}

function move(event: MouseEvent, collection: PolicyCollection, id: string, direction: "up" | "down"): void {
  window.dispatchEvent(new CustomEvent("birdbox:resource-move", {
    detail: { collection, id, direction, button: event.currentTarget as HTMLButtonElement },
  }));
}

function status(resource: { enabled: boolean }, collection: PolicyCollection): string {
  if (!resource.enabled) return "已停用";
  if (collection === "functions" && "callable" in resource && resource.callable === false) return "仅源码引用";
  return "已启用";
}

function policyReferenceCount(collection: "functions" | "filters", resourceId: string): number {
  if (!inventory.value) return 0;
  const sessionCount = (inventory.value.sessions ?? []).reduce((count, session) => {
    const policies = Object.values(session.channels).flatMap((channel) => [channel.importPolicy, channel.exportPolicy]);
    return count + policies.filter((policy) => collection === "functions"
      ? policy.steps.some((step) => step.type === "function" && step.functionId === resourceId)
      : policy.filterId === resourceId).length;
  }, 0);
  const kernelCount = (inventory.value.kernelProtocols ?? []).reduce((count, resource) => {
    const exportPolicies = resource.exportPolicies
      ? Object.values(resource.exportPolicies).filter((item) => item.mode === "visual").map((item) => item.policy)
      : [resource.exportPolicy];
    const policies = [...Object.values(resource.importPolicies ?? { legacy: resource.importPolicy }), ...exportPolicies];
    return count + policies.filter((policy) => collection === "functions"
      ? policy.steps.some((step) => step.type === "function" && step.functionId === resourceId)
      : policy.filterId === resourceId).length;
  }, 0);
  const pipeCount = (inventory.value.pipeProtocols ?? []).reduce((count, pipe) => count + [pipe.importPolicy, pipe.exportPolicy].filter((policy) => collection === "functions"
    ? policy.steps.some((step) => step.type === "function" && step.functionId === resourceId) : policy.filterId === resourceId).length, 0);
  return sessionCount + kernelCount + pipeCount;
}

function openPipeRuntime(id: string): void {
  window.dispatchEvent(new CustomEvent("birdbox:pipe-runtime-open", { detail: { id } }));
}
function openSourceRuntime(id: string): void {
  window.dispatchEvent(new CustomEvent("birdbox:source-policy-runtime-open", { detail: { id } }));
}
function pipePolicySummary(policy: Inventory["pipeProtocols"][number]["exportPolicy"]): string {
  return policy.mode === "custom" ? "Filter" : policy.mode === "combined" ? "组合策略" : policy.formAction === "all" ? "允许" : "禁止";
}
function kernelExportSummary(resource: Inventory["kernelProtocols"][number]): string {
  if (!resource.exportPolicies) return resource.exportPolicy.formAction;
  return (["ipv4", "ipv6"] as const)
    .filter((family) => resource[family])
    .map((family) => {
      const setting = resource.exportPolicies?.[family];
      if (!setting || setting.mode === "visual") return `${family === "ipv4" ? "v4" : "v6"}: 可视化`;
      return `${family === "ipv4" ? "v4" : "v6"}: krt_prefsrc ${setting.prefSrc ?? "未设置"}`;
    })
    .join(" / ");
}

function defineReferenceCount(resource: PolicyDefine): number {
  return inventory.value ? defineReferences(inventory.value, resource).length : 0;
}

function defineType(resource: PolicyDefine): string {
  if (resource.type === "cidr4") return resource.entrySource.kind === "irr-as-set" ? "IPv4 · AS-SET" : "IPv4 CIDR";
  if (resource.type === "cidr6") return resource.entrySource.kind === "irr-as-set" ? "IPv6 · AS-SET" : "IPv6 CIDR";
  return "表达式";
}

function defineValue(resource: PolicyDefine): string {
  if (resource.type === "expression") return resource.value;
  if (resource.entrySource.kind === "irr-as-set") {
    const state = resource.sync.status === "error" ? `同步失败 · 旧快照 ${resource.entries.length} 条` : `${resource.entrySource.asSet} · ${resource.entries.length} 条`;
    return `${state} · ${resource.entrySource.server}`;
  }
  return resource.entries.join(", ");
}

function openRpkiRuntime(id: string): void { window.dispatchEvent(new CustomEvent("birdbox:rpki-runtime-open", { detail: { id } })); }
function openSystemRuntime(kind: "directs" | "kernels", id: string): void { window.dispatchEvent(new CustomEvent("birdbox:system-runtime-open", { detail: { kind, id } })); }
function openStaticRuntime(id: string) { window.dispatchEvent(new CustomEvent("birdbox:static-runtime-open", { detail: { id } })); }

function staticSummary(resource: StaticProtocol): string {
  if (!resource.defineId) return `${resource.routes?.length ?? 0} 条直接路由${resource.raw ? " · + 自定义" : ""} · ${resource.table?.name ?? (resource.family === "ipv4" ? "master4" : "master6")}`;
  const filterCount = Object.values(resource.routeFilters ?? {})
    .filter((filter) => filter.operations.length > 0 || filter.custom).length;
  const summary = `${defineNames.value.get(resource.defineId) ?? resource.defineId} · ${Object.keys(resource.routeActions ?? {}).length} 条 CIDR · ${filterCount} 条有 per-route 块`;
  return `${summary}${resource.routes?.length ? ` · ${resource.routes.length} 条直接路由` : ""}${resource.raw ? " · + 自定义" : ""} · ${resource.table?.name ?? (resource.family === "ipv4" ? "master4" : "master6")}`;
}

function sourcePolicySources(resource: SourcePolicyEgress): number {
  return resource.groups.reduce((count, group) => count + group.sources.length, 0);
}

</script>

<template>
  <template v-if="kind === 'nodes'">
    <tr v-if="!inventory?.nodes.length"><td colspan="6" class="empty-cell">尚无受管节点</td></tr>
    <tr v-for="node in visible(inventory?.nodes)" v-else :key="node.id" :data-resource-id="node.id">
      <td><label class="resource-node-select"><input type="checkbox" :checked="props.selectedNodeIds?.includes(node.id) ?? false" :disabled="node.transport !== 'agent'" :aria-label="`选择节点 ${node.name} 批量升级 Agent`" :title="node.transport === 'agent' ? '选择此 Agent 节点' : '仅 Agent 节点支持批量升级'" @change="emit('toggle-node', node.id)"><strong>{{ node.name }}</strong></label><small :title="node.id">{{ node.id }}</small></td>
      <td>{{ node.transport === "ssh" ? "SSH" : node.transport === "agent" ? "Agent" : "本机" }} · {{ node.transport === "agent" ? "节点主动连接" : (node.sshUser ? `${node.sshUser}@${node.sshHost}:${node.sshPort}` : (node.sshHost ?? "-")) }}</td>
      <td><code>{{ node.routerId }}</code><small v-if="node.igpAddress">IGP {{ node.igpAddress }}</small></td>
      <td>{{ node.listenPort }}</td>
      <td><span class="resource-state" :class="nodeConnectionStatus(nodeHealth.get(node.id)) === 'online' ? 'enabled' : nodeConnectionStatus(nodeHealth.get(node.id)) === 'offline' ? 'disabled' : ''" :title="nodeHealth.get(node.id)?.error ?? undefined">{{ connectionLabel(node.id) }}</span></td>
      <td><button class="row-edit-button" type="button" title="编辑节点" :aria-label="`编辑节点 ${node.name}`" @click="edit('nodes', node.id)">✎</button></td>
    </tr>
  </template>

  <template v-else-if="kind === 'peers'">
    <tr v-if="!externalPeers.length"><td colspan="5" class="empty-cell">尚无 eBGP 远端</td></tr>
    <tr v-for="peer in externalPeers" v-else :key="peer.id" :data-resource-id="peer.id">
      <td><strong>{{ peer.name }}</strong><small :title="peer.id">{{ peer.id }}</small></td>
      <td>{{ nodeNames.get(peer.nodeId) ?? peer.nodeId }}</td>
      <td><code>{{ peer.address }}:{{ peer.port }}</code></td>
      <td>AS{{ peer.asn }}</td>
      <td><button class="row-edit-button" type="button" title="编辑 Peer" :aria-label="`编辑 Peer ${peer.name}`" @click="edit('peers', peer.id)">✎</button></td>
    </tr>
  </template>

  <template v-else-if="kind === 'defines'">
    <tr v-if="!inventory?.defines.length"><td colspan="8" class="empty-cell">尚无 Define</td></tr>
    <tr v-for="resource in visible(inventory?.defines)" v-else :key="resource.id" :data-resource-id="resource.id">
      <td><strong>{{ resource.label }}</strong><small :title="`${resource.name} · ${resource.id}`">{{ resource.name }} · {{ resource.id }}</small></td>
      <td>{{ defineType(resource) }}</td>
      <td :title="resourceScopeLabel(resource, nodeNames)">{{ resourceScopeCompactLabel(resource, nodeNames) }}</td>
      <td>{{ defineOrder.get(resource.id) }}</td>
      <td><code class="entry-summary" :title="defineValue(resource)">{{ defineValue(resource) }}</code></td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ status(resource, 'defines') }}</span></td>
      <td>{{ defineReferenceCount(resource) }}</td>
      <td><span class="resource-row-actions">
        <button class="row-edit-button" type="button" title="上移 Define" :aria-label="`上移 Define ${resource.name}`" data-move-resource :disabled="reorderDisabled || defineOrder.get(resource.id) === 1" @click="move($event, 'defines', resource.id, 'up')">↑</button>
        <button class="row-edit-button" type="button" title="下移 Define" :aria-label="`下移 Define ${resource.name}`" data-move-resource :disabled="reorderDisabled || defineOrder.get(resource.id) === inventory?.defines.length" @click="move($event, 'defines', resource.id, 'down')">↓</button>
        <button class="row-edit-button" type="button" title="编辑 Define" :aria-label="`编辑 Define ${resource.name}`" @click="edit('defines', resource.id)">✎</button>
      </span></td>
    </tr>
  </template>

  <template v-else-if="kind === 'statics'">
    <tr v-if="!inventory?.staticProtocols.length"><td colspan="7" class="empty-cell">尚无 Static 资源</td></tr>
    <tr v-for="resource in visible(inventory?.staticProtocols)" v-else :key="resource.id" :data-resource-id="resource.id">
      <td><strong>{{ resource.label }}</strong><small :title="`${resource.name} · ${resource.id}`">{{ resource.name }} · {{ resource.id }}</small></td>
      <td>{{ nodeNames.get(resource.nodeId) ?? resource.nodeId }}</td>
      <td>{{ resource.family === "ipv4" ? "IPv4" : "IPv6" }}</td>
      <td><code>{{ staticSummary(resource) }}</code></td>
      <td><code>{{ resource.importPolicy?.mode === "custom" ? "Filter" : resource.importPolicy?.mode === "combined" ? "Function" : resource.importPolicy?.formAction ?? resource.import }} / {{ resource.export }}</code></td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ resource.enabled ? "已启用" : "已停用" }}</span></td>
      <td><span class="resource-row-actions"><button class="secondary-button compact-command" type="button" title="查看 Static 运行态" :aria-label="`查看 Static ${resource.name} 运行态`" @click="openStaticRuntime(resource.id)">运行态</button><button class="row-edit-button" type="button" title="编辑 Static" :aria-label="`编辑 Static ${resource.name}`" @click="edit('statics', resource.id)">✎</button></span></td>
    </tr>
  </template>

  <template v-else-if="kind === 'directs'">
    <tr v-if="!inventory?.directProtocols.length"><td colspan="6" class="empty-cell">尚无 Direct 资源</td></tr>
    <tr v-for="resource in visible(inventory?.directProtocols)" v-else :key="resource.id" :data-resource-id="resource.id">
      <td><strong>{{ resource.label }}</strong><small :title="`${resource.name} · ${resource.id}`">{{ resource.name }} · {{ resource.id }}</small></td>
      <td>{{ nodeNames.get(resource.nodeId) ?? resource.nodeId }}</td>
      <td><code>{{ resource.interfaces.length ? resource.interfaces.join(', ') : '*' }}</code></td>
      <td>{{ [resource.ipv4 ? 'IPv4' : '', resource.ipv6 ? 'IPv6' : ''].filter(Boolean).join(' / ') }}</td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ resource.enabled ? '已启用' : '已停用' }}</span></td>
      <td><span class="resource-row-actions"><button class="secondary-button compact-command" type="button" :aria-label="`查看 Direct ${resource.name} 运行态`" @click="openSystemRuntime('directs', resource.id)">运行态</button><button class="row-edit-button" type="button" title="编辑 Direct" :aria-label="`编辑 Direct ${resource.name}`" @click="edit('directs', resource.id)">✎</button></span></td>
    </tr>
  </template>

  <template v-else-if="kind === 'pipes'">
    <tr v-if="!(inventory?.pipeProtocols ?? []).length"><td colspan="7" class="empty-cell">尚无 Pipe 资源。添加 Pipe，在同一节点的两张 BIRD 路由表间传递路由。</td></tr>
    <tr v-for="resource in visible(inventory?.pipeProtocols)" v-else :key="resource.id" :data-resource-id="resource.id">
      <td><strong>{{ resource.label }}</strong><small :title="`${resource.name} · ${resource.id}`">{{ resource.name }} · {{ resource.id }}</small></td>
      <td :title="resourceScopeLabel(resource, nodeNames)">{{ resourceScopeCompactLabel(resource, nodeNames) }}</td>
      <td>{{ resource.family === 'ipv4' ? 'IPv4' : 'IPv6' }}</td>
      <td><code>{{ resource.table.name }} ⇄ {{ resource.peerTable.name }}</code></td>
      <td><small>主表 → 对端：{{ pipePolicySummary(resource.exportPolicy) }}</small><small>对端 → 主表：{{ pipePolicySummary(resource.importPolicy) }}</small></td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ resource.enabled ? '配置已启用' : '配置已停用' }}</span></td>
      <td><span class="resource-row-actions"><button class="secondary-button compact-command" type="button" :aria-label="`查看 Pipe ${resource.name} 运行态`" @click="openPipeRuntime(resource.id)">运行态</button><button class="row-edit-button" type="button" :aria-label="`编辑 Pipe ${resource.name}`" @click="edit('pipes', resource.id)">✎</button></span></td>
    </tr>
  </template>

  <template v-else-if="kind === 'kernels'">
    <tr v-if="!inventory?.kernelProtocols.length"><td colspan="6" class="empty-cell">尚无 Kernel 资源</td></tr>
    <tr v-for="resource in visible(inventory?.kernelProtocols)" v-else :key="resource.id" :data-resource-id="resource.id">
      <td><strong>{{ resource.label }}</strong><small :title="`${resource.name} · ${resource.id}`">{{ resource.name }} · {{ resource.id }}</small></td>
      <td :title="resourceScopeLabel(resource, nodeNames)">{{ resourceScopeCompactLabel(resource, nodeNames) }}</td>
      <td>{{ [resource.ipv4 ? 'IPv4' : '', resource.ipv6 ? 'IPv6' : ''].filter(Boolean).join(' / ') }}</td>
      <td><small>Import：{{ resource.importPolicies ? [resource.ipv4 ? `v4 ${pipePolicySummary(resource.importPolicies.ipv4)}` : '', resource.ipv6 ? `v6 ${pipePolicySummary(resource.importPolicies.ipv6)}` : ''].filter(Boolean).join(' / ') : pipePolicySummary(resource.importPolicy) }}</small><small>Export：{{ kernelExportSummary(resource) }}</small><small>{{ [resource.ipv4 ? resource.tables?.ipv4.name ?? 'master4' : '', resource.ipv6 ? resource.tables?.ipv6.name ?? 'master6' : ''].filter(Boolean).join(' / ') }} → Linux {{ resource.table ?? 'main' }}</small></td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ resource.enabled ? '已启用' : '已停用' }}</span></td>
      <td><span class="resource-row-actions"><button class="secondary-button compact-command" type="button" :aria-label="`查看 Kernel ${resource.name} 运行态`" @click="openSystemRuntime('kernels', resource.id)">运行态</button><button class="row-edit-button" type="button" title="编辑 Kernel" :aria-label="`编辑 Kernel ${resource.name}`" @click="edit('kernels', resource.id)">✎</button></span></td>
    </tr>
  </template>

  <template v-else-if="kind === 'functions'">
    <tr v-if="!inventory?.functions.length"><td colspan="6" class="empty-cell">尚无 Function</td></tr>
    <tr v-for="resource in visible(inventory?.functions)" v-else :key="resource.id" :data-resource-id="resource.id">
      <td><strong>{{ resource.label ?? resource.name }}</strong><small :title="`${resource.name} · ${resource.id}`">{{ resource.name }} · {{ resource.id }}</small></td>
      <td :title="resourceScopeLabel(resource, nodeNames)">{{ resourceScopeCompactLabel(resource, nodeNames) }}</td>
      <td>{{ functionOrder.get(resource.id) }}</td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ status(resource, 'functions') }}</span></td>
      <td>{{ policyReferenceCount('functions', resource.id) }}</td>
      <td><span class="resource-row-actions">
        <button class="row-edit-button" type="button" title="上移 Function" :aria-label="`上移 Function ${resource.name}`" data-move-resource :disabled="reorderDisabled || functionOrder.get(resource.id) === 1" @click="move($event, 'functions', resource.id, 'up')">↑</button>
        <button class="row-edit-button" type="button" title="下移 Function" :aria-label="`下移 Function ${resource.name}`" data-move-resource :disabled="reorderDisabled || functionOrder.get(resource.id) === inventory?.functions.length" @click="move($event, 'functions', resource.id, 'down')">↓</button>
        <button class="row-edit-button" type="button" title="编辑 Function" :aria-label="`编辑 Function ${resource.name}`" @click="edit('functions', resource.id)">✎</button>
      </span></td>
    </tr>
  </template>

  <template v-else-if="kind === 'filters'">
    <tr v-if="!inventory?.filters.length"><td colspan="5" class="empty-cell">尚无 Filter</td></tr>
    <tr v-for="resource in visible(inventory?.filters)" v-else :key="resource.id" :data-resource-id="resource.id">
      <td><strong>{{ resource.label ?? resource.name }}</strong><small :title="`${resource.name} · ${resource.id}`">{{ resource.name }} · {{ resource.id }}</small></td>
      <td :title="resourceScopeLabel(resource, nodeNames)">{{ resourceScopeCompactLabel(resource, nodeNames) }}</td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ status(resource, 'filters') }}</span></td>
      <td>{{ policyReferenceCount('filters', resource.id) }}</td>
      <td><button class="row-edit-button" type="button" title="编辑 Filter" :aria-label="`编辑 Filter ${resource.name}`" @click="edit('filters', resource.id)">✎</button></td>
    </tr>
  </template>

  <template v-else-if="kind === 'rpki'">
    <tr v-if="!inventory?.rpki.length"><td colspan="6" class="empty-cell">尚无 RPKI 来源</td></tr>
    <tr v-for="resource in visible(inventory?.rpki)" v-else :key="resource.id" :data-resource-id="resource.id">
      <td><strong>{{ resource.label }}</strong><small :title="`${resource.name} · ${resource.id}`">{{ resource.name }} · {{ resource.id }}</small></td>
      <td>{{ resource.sourceType === "file" ? "本地文件" : `RPKI-RTR · ${resource.remote}` }}</td>
      <td :title="resourceScopeLabel(resource, nodeNames)">{{ resourceScopeCompactLabel(resource, nodeNames) }}</td>
      <td><code>{{ [resource.roa4Table, resource.roa6Table].filter(Boolean).join(" / ") }}</code></td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ resource.enabled ? "已启用" : "已停用" }}</span></td>
      <td><div class="resource-row-actions"><button class="row-edit-button" type="button" :aria-label="`查看 RPKI ${resource.name} 运行态`" @click="openRpkiRuntime(resource.id)">运行态</button><button class="row-edit-button" type="button" title="编辑 RPKI" :aria-label="`编辑 RPKI ${resource.name}`" @click="edit('rpki', resource.id)">✎</button></div></td>
    </tr>
  </template>

  <template v-else>
    <tr v-if="!(inventory?.sourcePolicies ?? []).length"><td colspan="6" class="empty-cell">尚无源地址出口映射</td></tr>
    <tr v-for="resource in visible(inventory?.sourcePolicies)" v-else :key="resource.id" :data-resource-id="resource.id">
      <td><strong>{{ resource.label }}</strong><small :title="resource.id">{{ resource.id }}</small></td>
      <td :title="resourceScopeLabel(resource, nodeNames)">{{ resourceScopeCompactLabel(resource, nodeNames) }}</td>
      <td>{{ resource.groups.length }}</td>
      <td>{{ sourcePolicySources(resource) }}</td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ resource.enabled ? "配置已启用" : "配置已停用" }}</span></td>
      <td><span class="resource-row-actions"><button class="secondary-button compact-command" type="button" :aria-label="`查看源地址出口映射 ${resource.label} 运行态`" @click="openSourceRuntime(resource.id)">运行态</button><button class="row-edit-button" type="button" title="编辑源地址出口映射" :aria-label="`编辑源地址出口映射 ${resource.label}`" @click="edit('sourcePolicies', resource.id)">✎</button></span></td>
    </tr>
  </template>
</template>
