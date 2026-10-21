<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import type { DashboardPeer, ProtocolDetailsResponse } from "@birdbox/contracts/api";

import { api } from "../shared/api-client";
import { useDashboardStore } from "./dashboard-store";
import { protocolPresentation } from "./presentation";

const { dashboard } = useDashboardStore();
const dialog = ref<HTMLDialogElement | null>(null);
const peerId = ref<string | null>(null);
const result = ref<ProtocolDetailsResponse | null>(null);
const pending = ref(false);
const errorMessage = ref("");
let requestId = 0;
let controller: AbortController | null = null;

const peer = computed<DashboardPeer | null>(() => dashboard.value?.peers.find((item) => item.id === peerId.value) ?? null);
const statusLabel = computed(() => peer.value ? protocolPresentation(dashboard.value, peer.value).label : "");
const subtitle = computed(() => peer.value?.session
  ? `${dashboard.value?.node?.name ?? "节点"} · ${peer.value.session.protocolName} · ${peer.value.address}`
  : "");

async function load(): Promise<void> {
  const selectedPeer = peer.value;
  if (!selectedPeer?.session) return;
  controller?.abort();
  controller = new AbortController();
  const currentRequest = ++requestId;
  pending.value = true;
  errorMessage.value = "";
  result.value = null;
  try {
    const response = await api<ProtocolDetailsResponse>(
      `/api/sessions/${encodeURIComponent(selectedPeer.session.id)}/protocol`,
      { signal: controller.signal, timeoutMs: 30_000 },
    );
    if (currentRequest !== requestId) return;
    result.value = response;
    if (!response.ok && response.error) errorMessage.value = response.error;
  } catch (error) {
    if (controller?.signal.aborted || currentRequest !== requestId) return;
    errorMessage.value = error instanceof Error ? error.message : "读取 BIRD 协议详情失败";
  } finally {
    if (currentRequest === requestId) {
      pending.value = false;
      controller = null;
    }
  }
}

function open(event: CustomEvent<{ peerId: string }>): void {
  const selectedPeer = dashboard.value?.peers.find((item) => item.id === event.detail.peerId);
  if (!selectedPeer?.session) return;
  controller?.abort();
  requestId += 1;
  peerId.value = selectedPeer.id;
  result.value = null;
  errorMessage.value = "";
  pending.value = false;
  dialog.value?.showModal();
  void load();
}

function close(): void {
  controller?.abort();
  controller = null;
  requestId += 1;
  pending.value = false;
  dialog.value?.close();
}

onMounted(() => window.addEventListener("birdbox:protocol-details-open", open));
onBeforeUnmount(() => {
  window.removeEventListener("birdbox:protocol-details-open", open);
  controller?.abort();
});
</script>

<template>
  <dialog ref="dialog" class="route-dialog protocol-details-dialog" aria-labelledby="protocolDetailsDialogTitle" @cancel.prevent="close">
    <div class="route-dialog-shell">
      <header class="route-dialog-head">
        <div>
          <p class="eyebrow">BIRD PROTOCOL</p>
          <h2 id="protocolDetailsDialogTitle">{{ peer?.name ?? "会话" }} 连接详情</h2>
          <span>{{ subtitle }}</span>
        </div>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭协议详情" @click="close">×</button>
      </header>
      <div class="protocol-details-summary">
        <span>当前状态</span>
        <strong :class="peer?.protocol?.established ? 'up' : 'down'">{{ statusLabel || "未知" }}</strong>
      </div>
      <div class="protocol-details-meta">
        <span>等价查询：<code>birdc -v 'show protocols all "{{ peer?.session?.protocolName ?? "" }}"'</code></span>
        <button class="secondary-button compact-command" type="button" :disabled="pending" @click="load">刷新</button>
      </div>
      <div class="protocol-details-body" aria-live="polite">
        <div v-if="pending" class="route-dialog-state"><div class="route-loading-copy"><i aria-hidden="true"></i><span>正在读取 BIRD 协议详情</span></div></div>
        <div v-else-if="errorMessage" class="route-dialog-state error"><div><p>{{ errorMessage }}</p><button class="secondary-button" type="button" @click="load">重试</button></div></div>
        <pre v-else-if="result" class="protocol-details-output">{{ result.output || "BIRD 未返回协议详情" }}</pre>
        <div v-else class="route-dialog-state">尚未读取协议详情</div>
      </div>
    </div>
  </dialog>
</template>
