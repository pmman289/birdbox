<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import type { AgentBatchUpgradeResponse, AgentStatusResponse } from "@birdbox/contracts/api";
import { useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
import { dispatchToast } from "../shared/events";

const dialog = ref<HTMLDialogElement | null>(null);
const nodeIds = ref<string[]>([]);
const statuses = ref<AgentStatusResponse["agents"]>([]);
const job = ref<AgentBatchUpgradeResponse["job"]>(null);
const pending = ref(false);
let pollTimer: number | null = null;
const { dashboard } = useDashboardStore();

const selectedNodes = computed(() => (dashboard.value?.inventory.nodes ?? []).filter((node) => nodeIds.value.includes(node.id)));
const counts = computed(() => {
  const items = job.value?.items ?? [];
  return {
    success: items.filter((item) => item.status === "success").length,
    failed: items.filter((item) => item.status === "failed").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    running: items.filter((item) => item.status === "running").length,
    pending: items.filter((item) => item.status === "pending").length,
  };
});

function arch(value: string | null): string {
  const key = String(value ?? "").toLowerCase();
  const mapped: Record<string, string> = { x64: "amd64", x86_64: "amd64", amd64: "amd64", aarch64: "arm64", arm64: "arm64", armv7l: "arm", armv7: "arm", arm: "arm", armv6l: "armv6", armv6: "armv6", armv5l: "armv5", armv5: "armv5", mips: "mips", mipsel: "mipsle", mipsle: "mipsle", mips64: "mips64", mips64el: "mips64le", mips64le: "mips64le", riscv64: "riscv64" };
  return mapped[key] ?? "";
}

function stopPolling(): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = null;
}

async function poll(): Promise<void> {
  try {
    const response = await api<AgentBatchUpgradeResponse>("/api/agent/upgrades/batch", { mutationWait: false });
    if (response.job) job.value = response.job;
    if (job.value?.status === "running") pollTimer = window.setTimeout(() => void poll(), 2000);
    else if (job.value) dispatchToast("Agent 批量升级任务已完成", counts.value.failed ? "error" : "success");
  } catch {
    pollTimer = window.setTimeout(() => void poll(), 3000);
  }
}

async function loadStatuses(): Promise<void> {
  const response = await api<AgentStatusResponse>("/api/agent/status", { mutationWait: false });
  statuses.value = response.agents;
}

async function start(): Promise<void> {
  if (!nodeIds.value.length || pending.value) return;
  pending.value = true;
  stopPolling();
  try {
    await loadStatuses();
    const agentMap = new Map(statuses.value.map((item) => [item.nodeId, item]));
    const nodes = [] as Array<{ nodeId: string; params: Record<string, unknown> }>;
    for (const node of selectedNodes.value) {
      const status = agentMap.get(node.id);
      if (status?.connected) {
        const architecture = arch(status.architecture);
        if (!architecture) throw new Error(`${node.name} 上报的架构不受支持，请先重新安装 Agent`);
        nodes.push({ nodeId: node.id, params: {} });
      } else {
        nodes.push({ nodeId: node.id, params: {} });
      }
    }
    const response = await api<AgentBatchUpgradeResponse>("/api/agent/upgrades/batch", { method: "POST", timeoutMs: 30_000, body: JSON.stringify({ nodes }) });
    job.value = response.job;
    void poll();
  } catch (error) {
    dispatchToast(error instanceof Error ? error.message : "批量升级启动失败", "error");
  } finally {
    pending.value = false;
  }
}

async function open(ids: string[]): Promise<void> {
  stopPolling();
  nodeIds.value = [...new Set(ids)];
  job.value = null;
  if (!dialog.value?.open) dialog.value?.showModal();
  try {
    const [statusResponse, jobResponse] = await Promise.all([
      api<AgentStatusResponse>("/api/agent/status", { mutationWait: false }),
      api<AgentBatchUpgradeResponse>("/api/agent/upgrades/batch", { mutationWait: false }),
    ]);
    statuses.value = statusResponse.agents;
    if (jobResponse.job?.status === "running") {
      job.value = jobResponse.job;
      void poll();
    }
  } catch {
    statuses.value = [];
  }
}

function close(): void {
  if (job.value?.status === "running") return;
  stopPolling();
  dialog.value?.close();
}

function nodeName(nodeId: string): string {
  return dashboard.value?.inventory.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;
}

function stateLabel(state: string): string {
  return ({ pending: "等待中", running: "升级中", success: "成功", failed: "失败", skipped: "已跳过" } as Record<string, string>)[state] ?? state;
}

function handleOpen(event: CustomEvent<{ nodeIds: string[] }>): void { void open(event.detail.nodeIds); }
const onBatchUpgrade = (event: Event): void => { handleOpen(event as CustomEvent<{ nodeIds: string[] }>); };
onMounted(() => window.addEventListener("birdbox:agent-batch-upgrade", onBatchUpgrade));
onBeforeUnmount(() => { stopPolling(); window.removeEventListener("birdbox:agent-batch-upgrade", onBatchUpgrade); });
</script>

<template>
  <dialog ref="dialog" class="editor-dialog batch-upgrade-dialog" aria-labelledby="batchUpgradeTitle" @cancel.prevent="close">
    <div class="dialog-head"><span class="dialog-icon">↑</span><div><p class="eyebrow">Agent 运维</p><h2 id="batchUpgradeTitle">批量升级 Agent</h2></div></div>
    <p class="dialog-note">升级任务按顺序执行，同时只允许一个节点下载发布包。离线节点会在队列中标记为跳过。</p>
    <div v-if="!job" class="batch-upgrade-list"><div v-for="node in selectedNodes" :key="node.id" class="batch-upgrade-row"><span>{{ node.name }}</span><span :class="statuses.find((item) => item.nodeId === node.id)?.connected ? 'ready' : 'muted'">{{ statuses.find((item) => item.nodeId === node.id)?.connected ? 'Agent 在线' : 'Agent 离线' }}</span></div></div>
    <template v-else>
      <div class="batch-upgrade-summary"><span>成功 {{ counts.success }}</span><span>失败 {{ counts.failed }}</span><span>跳过 {{ counts.skipped }}</span><span v-if="counts.running || counts.pending">剩余 {{ counts.running + counts.pending }}</span></div>
      <p v-if="job.currentNodeId" class="dialog-note">当前节点：{{ nodeName(job.currentNodeId) }}（仅此节点占用下载带宽）</p>
      <div class="batch-upgrade-list"><div v-for="item in job.items" :key="item.nodeId" class="batch-upgrade-row"><span>{{ nodeName(item.nodeId) }}</span><span :class="`batch-state-${item.status}`">{{ stateLabel(item.status) }}<small v-if="item.error"> · {{ item.error }}</small></span></div></div>
    </template>
    <div class="dialog-actions"><button class="secondary-button" type="button" :disabled="pending || job?.status === 'running'" @click="close">{{ job?.status === 'completed' ? '关闭' : '取消' }}</button><button v-if="!job" class="primary-button" type="button" :disabled="pending || !selectedNodes.length" @click="start">{{ pending ? '正在准备…' : '开始批量升级' }}</button></div>
  </dialog>
</template>

<style scoped>
.batch-upgrade-dialog { max-width: 620px; width: min(calc(100vw - 32px), 620px); padding: 22px; }
.batch-upgrade-list { display: grid; gap: 6px; margin: 16px 0; max-height: 320px; overflow: auto; }
.batch-upgrade-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 12px; border: 1px solid var(--line, #d7dce2); border-radius: 6px; }
.batch-upgrade-row small { color: var(--muted, #68707a); }
.batch-upgrade-summary { display: flex; gap: 16px; margin: 14px 0; font-variant-numeric: tabular-nums; }
.batch-state-success, .ready { color: #18794e; }
.batch-state-failed { color: #b42318; }
.batch-state-skipped, .muted { color: #8a5a00; }
</style>
