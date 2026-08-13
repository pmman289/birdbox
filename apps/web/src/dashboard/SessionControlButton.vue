<script setup lang="ts">
import { computed, ref } from "vue";

import { refreshDashboardRuntime, setSessionProtocolEnabled, useDashboardStore } from "./dashboard-store";
import { isEbgpDashboardPeer } from "./peer-kind";
import { api } from "../shared/api-client";
import { dispatchToast } from "../shared/events";

interface SessionControlResponse {
  enabled: boolean;
}

const { dashboard, loading } = useDashboardStore();
const pending = ref(false);
const peer = computed(() => {
  const selected = dashboard.value?.selectedPeer;
  return isEbgpDashboardPeer(selected) ? selected : null;
});
const session = computed(() => peer.value?.session ?? null);
const manuallyDisabled = computed(() => peer.value?.protocol?.disabled === true);
const label = computed(() => manuallyDisabled.value ? "启动当前会话" : "停止当前会话");
const disabled = computed(() => pending.value || loading.value || !dashboard.value?.node || !session.value
  || session.value.enabled === false || peer.value?.protocol?.configured === false);

async function control(): Promise<void> {
  const node = dashboard.value?.node;
  const selectedPeer = peer.value;
  const selectedSession = session.value;
  if (!node || !selectedPeer || !selectedSession || disabled.value) return;
  const action = manuallyDisabled.value ? "enable" : "disable";
  if (!window.confirm(`${action === "enable" ? "启动" : "停止"} ${node.name} 上的 BGP 会话 ${selectedSession.protocolName}？`)) return;
  pending.value = true;
  try {
    const result = await api<SessionControlResponse>(`/api/sessions/${selectedSession.id}/control`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    setSessionProtocolEnabled(selectedSession.id, result.enabled);
    dispatchToast(action === "enable" ? "BGP 会话已启动" : "BGP 会话已停止", "success");
    window.setTimeout(() => void refreshDashboardRuntime().catch(() => undefined), 1_500);
  } catch (error) {
    dispatchToast(error instanceof Error ? error.message : "更新 BGP 会话状态失败", "error");
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <button class="protocol-control" :class="manuallyDisabled ? 'start' : 'stop'" type="button" :disabled="disabled" :aria-label="label" :title="manuallyDisabled ? '启动当前选中的 BGP 会话' : '只停止当前选中的 BGP 会话'" @click="control">
    {{ pending ? (manuallyDisabled ? "正在启动" : "正在停止") : label }}
  </button>
</template>
