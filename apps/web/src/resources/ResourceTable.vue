<script setup lang="ts">
import { computed } from "vue";

import type {
  Inventory,
  PolicyCollection,
  PolicyDefine,
  PolicyFilter,
  PolicyFunction,
  StaticProtocol,
} from "@birdbox/contracts/inventory";

import type { ResourceEditKind } from "../shared/events";
import { useDashboardStore } from "../dashboard/dashboard-store";
import { resourceScopeCompactLabel, resourceScopeLabel } from "../shared/resource-scope";

const { kind } = defineProps<{ kind: ResourceEditKind }>();
const { dashboard } = useDashboardStore();
const inventory = computed<Inventory | null>(() => dashboard.value?.inventory ?? null);
const nodeNames = computed(() => new Map((inventory.value?.nodes ?? []).map((node) => [node.id, node.name])));
const defineNames = computed(() => new Map((inventory.value?.defines ?? []).map((resource) => [resource.id, resource.label ?? resource.name])));
const externalPeers = computed(() => (inventory.value?.peers ?? []).filter((peer) => !peer.managedBy));

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

function sourceReferences(source: unknown, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(String(source ?? ""));
}

function resourceSource(resource: PolicyDefine | PolicyFunction | PolicyFilter): string {
  if ("source" in resource) return resource.source;
  if (resource.type === "expression") return resource.value;
  return "";
}

function policyReferenceCount(collection: "functions" | "filters", resourceId: string): number {
  return (inventory.value?.sessions ?? []).reduce((count, session) => {
    const policies = Object.values(session.channels).flatMap((channel) => [channel.importPolicy, channel.exportPolicy]);
    return count + policies.filter((policy) => collection === "functions"
      ? policy.steps.some((step) => step.type === "function" && step.functionId === resourceId)
      : policy.filterId === resourceId).length;
  }, 0);
}

function defineReferenceCount(resource: PolicyDefine): number {
  if (!inventory.value) return 0;
  const policyReferences = [
    ...inventory.value.defines,
    ...inventory.value.functions,
    ...inventory.value.filters,
  ].filter((item) => item.id !== resource.id && sourceReferences(resourceSource(item), resource.name)).length;
  const sessionReferences = inventory.value.sessions.reduce((count, session) => count + Object.values(session.channels)
    .filter((channel) => channel.exportDefineId === resource.id).length, 0);
  const staticReferences = inventory.value.staticProtocols.filter((item) =>
    item.defineId === resource.id || sourceReferences(item.raw, resource.name)).length;
  return policyReferences + sessionReferences + staticReferences;
}

function defineType(resource: PolicyDefine): string {
  if (resource.type === "cidr4") return "IPv4 CIDR";
  if (resource.type === "cidr6") return "IPv6 CIDR";
  return "表达式";
}

function defineValue(resource: PolicyDefine): string {
  return resource.type === "expression" ? resource.value : resource.entries.join(", ");
}

function staticSummary(resource: StaticProtocol): string {
  if (!resource.defineId) return "仅自定义指令";
  const filterCount = Object.values(resource.routeFilters ?? {})
    .filter((filter) => filter.operations.length > 0 || filter.custom).length;
  const summary = `${defineNames.value.get(resource.defineId) ?? resource.defineId} · ${Object.keys(resource.routeActions ?? {}).length} 条 CIDR · ${filterCount} 条有 per-route 块`;
  return resource.raw ? `${summary} · + 自定义` : summary;
}

</script>

<template>
  <template v-if="kind === 'nodes'">
    <tr v-if="!inventory?.nodes.length"><td colspan="5" class="empty-cell">尚无受管节点</td></tr>
    <tr v-for="node in inventory?.nodes ?? []" v-else :key="node.id">
      <td><strong>{{ node.name }}</strong><small>{{ node.id }}</small></td>
      <td>{{ node.transport === "ssh" ? "SSH" : "本机" }} · {{ node.sshUser ? `${node.sshUser}@${node.sshHost}:${node.sshPort}` : (node.sshHost ?? "-") }}</td>
      <td><code>{{ node.routerId }}</code></td>
      <td>{{ node.listenPort }}</td>
      <td><button class="row-edit-button" type="button" title="编辑节点" :aria-label="`编辑节点 ${node.name}`" @click="edit('nodes', node.id)">✎</button></td>
    </tr>
  </template>

  <template v-else-if="kind === 'peers'">
    <tr v-if="!externalPeers.length"><td colspan="5" class="empty-cell">尚无 eBGP 远端</td></tr>
    <tr v-for="peer in externalPeers" v-else :key="peer.id">
      <td><strong>{{ peer.name }}</strong><small>{{ peer.id }}</small></td>
      <td>{{ nodeNames.get(peer.nodeId) ?? peer.nodeId }}</td>
      <td><code>{{ peer.address }}:{{ peer.port }}</code></td>
      <td>AS{{ peer.asn }}</td>
      <td><button class="row-edit-button" type="button" title="编辑 Peer" :aria-label="`编辑 Peer ${peer.name}`" @click="edit('peers', peer.id)">✎</button></td>
    </tr>
  </template>

  <template v-else-if="kind === 'defines'">
    <tr v-if="!inventory?.defines.length"><td colspan="8" class="empty-cell">尚无 Define</td></tr>
    <tr v-for="(resource, index) in inventory?.defines ?? []" v-else :key="resource.id">
      <td><strong>{{ resource.label }}</strong><small>{{ resource.name }} · {{ resource.id }}</small></td>
      <td>{{ defineType(resource) }}</td>
      <td :title="resourceScopeLabel(resource, nodeNames)">{{ resourceScopeCompactLabel(resource, nodeNames) }}</td>
      <td>{{ index + 1 }}</td>
      <td><code class="entry-summary" :title="defineValue(resource)">{{ defineValue(resource) }}</code></td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ status(resource, 'defines') }}</span></td>
      <td>{{ defineReferenceCount(resource) }}</td>
      <td><span class="resource-row-actions">
        <button class="row-edit-button" type="button" title="上移 Define" :aria-label="`上移 Define ${resource.name}`" data-move-resource :disabled="index === 0" @click="move($event, 'defines', resource.id, 'up')">↑</button>
        <button class="row-edit-button" type="button" title="下移 Define" :aria-label="`下移 Define ${resource.name}`" data-move-resource :disabled="index === (inventory?.defines.length ?? 0) - 1" @click="move($event, 'defines', resource.id, 'down')">↓</button>
        <button class="row-edit-button" type="button" title="编辑 Define" :aria-label="`编辑 Define ${resource.name}`" @click="edit('defines', resource.id)">✎</button>
      </span></td>
    </tr>
  </template>

  <template v-else-if="kind === 'statics'">
    <tr v-if="!inventory?.staticProtocols.length"><td colspan="7" class="empty-cell">尚无 Static 资源</td></tr>
    <tr v-for="resource in inventory?.staticProtocols ?? []" v-else :key="resource.id">
      <td><strong>{{ resource.label }}</strong><small>{{ resource.name }} · {{ resource.id }}</small></td>
      <td>{{ nodeNames.get(resource.nodeId) ?? resource.nodeId }}</td>
      <td>{{ resource.family === "ipv4" ? "IPv4" : "IPv6" }}</td>
      <td><code>{{ staticSummary(resource) }}</code></td>
      <td><code>{{ resource.import }} / {{ resource.export }}</code></td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ resource.enabled ? "已启用" : "已停用" }}</span></td>
      <td><button class="row-edit-button" type="button" title="编辑 Static" :aria-label="`编辑 Static ${resource.name}`" @click="edit('statics', resource.id)">✎</button></td>
    </tr>
  </template>

  <template v-else-if="kind === 'functions'">
    <tr v-if="!inventory?.functions.length"><td colspan="6" class="empty-cell">尚无 Function</td></tr>
    <tr v-for="(resource, index) in inventory?.functions ?? []" v-else :key="resource.id">
      <td><strong>{{ resource.label ?? resource.name }}</strong><small>{{ resource.name }} · {{ resource.id }}</small></td>
      <td :title="resourceScopeLabel(resource, nodeNames)">{{ resourceScopeCompactLabel(resource, nodeNames) }}</td>
      <td>{{ index + 1 }}</td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ status(resource, 'functions') }}</span></td>
      <td>{{ policyReferenceCount('functions', resource.id) }}</td>
      <td><span class="resource-row-actions">
        <button class="row-edit-button" type="button" title="上移 Function" :aria-label="`上移 Function ${resource.name}`" data-move-resource :disabled="index === 0" @click="move($event, 'functions', resource.id, 'up')">↑</button>
        <button class="row-edit-button" type="button" title="下移 Function" :aria-label="`下移 Function ${resource.name}`" data-move-resource :disabled="index === (inventory?.functions.length ?? 0) - 1" @click="move($event, 'functions', resource.id, 'down')">↓</button>
        <button class="row-edit-button" type="button" title="编辑 Function" :aria-label="`编辑 Function ${resource.name}`" @click="edit('functions', resource.id)">✎</button>
      </span></td>
    </tr>
  </template>

  <template v-else-if="kind === 'filters'">
    <tr v-if="!inventory?.filters.length"><td colspan="5" class="empty-cell">尚无 Filter</td></tr>
    <tr v-for="resource in inventory?.filters ?? []" v-else :key="resource.id">
      <td><strong>{{ resource.label ?? resource.name }}</strong><small>{{ resource.name }} · {{ resource.id }}</small></td>
      <td :title="resourceScopeLabel(resource, nodeNames)">{{ resourceScopeCompactLabel(resource, nodeNames) }}</td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ status(resource, 'filters') }}</span></td>
      <td>{{ policyReferenceCount('filters', resource.id) }}</td>
      <td><button class="row-edit-button" type="button" title="编辑 Filter" :aria-label="`编辑 Filter ${resource.name}`" @click="edit('filters', resource.id)">✎</button></td>
    </tr>
  </template>

  <template v-else>
    <tr v-if="!inventory?.rpki.length"><td colspan="6" class="empty-cell">尚无 RPKI 来源</td></tr>
    <tr v-for="resource in inventory?.rpki ?? []" v-else :key="resource.id">
      <td><strong>{{ resource.label }}</strong><small>{{ resource.name }} · {{ resource.id }}</small></td>
      <td>{{ resource.sourceType === "file" ? "本地文件" : `RPKI-RTR · ${resource.remote}` }}</td>
      <td :title="resourceScopeLabel(resource, nodeNames)">{{ resourceScopeCompactLabel(resource, nodeNames) }}</td>
      <td><code>{{ [resource.roa4Table, resource.roa6Table].filter(Boolean).join(" / ") }}</code></td>
      <td><span class="resource-state" :class="resource.enabled ? 'enabled' : 'disabled'">{{ resource.enabled ? "已启用" : "已停用" }}</span></td>
      <td><button class="row-edit-button" type="button" title="编辑 RPKI" :aria-label="`编辑 RPKI ${resource.name}`" @click="edit('rpki', resource.id)">✎</button></td>
    </tr>
  </template>
</template>
