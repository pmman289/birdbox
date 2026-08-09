<script setup lang="ts">
import { computed, ref } from "vue";

import type { AddressFamily } from "@birdbox/contracts/inventory";
import type { ChangeEvent, DashboardPeer } from "@birdbox/contracts/api";

import { useDashboardStore } from "./dashboard-store";
import { protocolPresentation } from "./presentation";

type RuntimeTab = "config" | "events";

const { dashboard } = useDashboardStore();
const activeTab = ref<RuntimeTab>("config");
const peers = computed(() => dashboard.value?.peers ?? []);
const events = computed(() => [...(dashboard.value?.events ?? [])].reverse());

function enabledFamilies(peer: DashboardPeer): AddressFamily[] {
  return (["ipv4", "ipv6"] as const).filter((family) => peer.session?.channels[family]?.enabled);
}

function familyLabel(family: AddressFamily): string {
  return family === "ipv4" ? "IPv4" : "IPv6";
}

function routeCount(peer: DashboardPeer, family: AddressFamily, direction: "imported" | "exported"): number | null {
  const families = enabledFamilies(peer);
  const channel = peer.protocol?.channels?.[family];
  const fallback = families.length === 1 ? peer.protocol : null;
  return channel?.[direction] ?? fallback?.[direction] ?? null;
}

function routesAvailable(peer: DashboardPeer): boolean {
  return Boolean(
    peer.session?.enabled !== false
      && enabledFamilies(peer).length
      && dashboard.value?.runtime.reachable
      && peer.protocol?.configured !== false,
  );
}

function openRoutes(peerId: string): void {
  window.dispatchEvent(new CustomEvent("birdbox:routes-open", { detail: { peerId } }));
}

function selectTab(tab: RuntimeTab): void {
  activeTab.value = tab;
}

function moveTabFocus(event: KeyboardEvent, tab: RuntimeTab): void {
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "Home"
    ? "config"
    : "events";
  selectTab(next);
  document.querySelector<HTMLButtonElement>(next === "config" ? "#localConfigTab" : "#eventLogTab")?.focus();
}

function eventTime(event: ChangeEvent): string {
  return new Date(event.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}

</script>

<template>
  <div class="protocol-table-wrap">
    <table>
      <thead><tr><th>Peer</th><th>地址</th><th>协议</th><th>状态</th><th>路由明细</th></tr></thead>
      <tbody>
        <tr v-if="peers.length === 0"><td colspan="5" class="empty-cell">尚无远端 Peer</td></tr>
        <tr v-for="peer in peers" v-else :key="peer.id">
          <td>{{ peer.name }}</td>
          <td>{{ peer.address }}</td>
          <td>{{ peer.session?.protocolName ?? "-" }}</td>
          <td><span class="table-state" :class="peer.protocol?.established ? 'up' : peer.session ? 'down' : ''">{{ protocolPresentation(dashboard, peer).label }}</span></td>
          <td>
            <button
              v-if="peer.session"
              class="route-summary-button"
              type="button"
              :disabled="!routesAvailable(peer)"
              :aria-label="`查看 ${peer.name} 的路由明细`"
              @click="openRoutes(peer.id)"
            >
              <span class="route-summary-copy">
                <strong>查看路由</strong>
                <template v-if="enabledFamilies(peer).length">
                  <span v-for="family in enabledFamilies(peer)" :key="family">
                    {{ familyLabel(family) }} {{ routeCount(peer, family, "imported") ?? "-" }} 入 / {{ routeCount(peer, family, "exported") ?? "-" }} 出
                  </span>
                </template>
                <span v-else>Channel 未启用</span>
              </span>
              <span aria-hidden="true">›</span>
            </button>
            <span v-else>-</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <div class="tabs" role="tablist" aria-label="配置与日志">
    <button id="localConfigTab" class="tab" :class="{ active: activeTab === 'config' }" type="button" role="tab" :aria-selected="activeTab === 'config'" aria-controls="localConfig" :tabindex="activeTab === 'config' ? 0 : -1" @click="selectTab('config')" @keydown="moveTabFocus($event, 'config')">节点配置</button>
    <button id="eventLogTab" class="tab" :class="{ active: activeTab === 'events' }" type="button" role="tab" :aria-selected="activeTab === 'events'" aria-controls="eventLog" :tabindex="activeTab === 'events' ? 0 : -1" @click="selectTab('events')" @keydown="moveTabFocus($event, 'events')">变更日志 <span>{{ dashboard?.events.length ?? 0 }}</span></button>
  </div>
  <div class="tab-panels">
    <pre id="localConfig" class="tab-panel" :class="{ active: activeTab === 'config' }" role="tabpanel" aria-labelledby="localConfigTab">{{ dashboard?.config ?? "# 尚无配置" }}</pre>
    <div id="eventLog" class="tab-panel event-log" :class="{ active: activeTab === 'events' }" role="tabpanel" aria-labelledby="eventLogTab">
      <div v-if="events.length === 0" class="empty-cell">尚无变更日志</div>
      <div v-for="entry in events" v-else :key="`${entry.timestamp}:${entry.nodeId}:${entry.message}`" class="log-row" :class="entry.level">
        <time>{{ eventTime(entry) }}</time><span>{{ entry.nodeId ?? "控制器" }}</span><strong>{{ entry.message }}</strong>
      </div>
    </div>
  </div>
</template>
