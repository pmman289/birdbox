<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

export interface OspfApplyNode {
  nodeId: string;
  name: string;
  status: "ready" | "applying" | "success" | "failed" | "unknown";
  detail?: string;
}

const props = withDefaults(defineProps<{
  open: boolean;
  domainName: string;
  nodes: OspfApplyNode[];
  pending?: boolean;
  error?: string;
}>(), { pending: false, error: "" });

const emit = defineEmits<{
  close: [];
  confirm: [];
  retry: [];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const statusLabel: Record<OspfApplyNode["status"], string> = {
  ready: "待应用",
  applying: "应用中",
  success: "已完成",
  failed: "失败",
  unknown: "结果未知",
};

watch(() => props.open, async (open) => {
  await nextTick();
  if (open && dialog.value && !dialog.value.open) dialog.value.showModal();
  if (!open && dialog.value?.open) dialog.value.close();
});

function close(): void {
  if (props.pending) return;
  emit("close");
}
</script>

<template>
  <dialog ref="dialog" class="route-dialog ospf-apply-dialog" aria-labelledby="ospfApplyDialogTitle" @cancel.prevent="close" @close="emit('close')">
    <div class="route-dialog-shell">
      <header class="route-dialog-head">
        <div>
          <p class="eyebrow">OSPF APPLY</p>
          <h2 id="ospfApplyDialogTitle">应用 OSPF 配置</h2>
          <span>{{ domainName }} · 已完成服务端预检</span>
        </div>
        <button class="icon-button" type="button" aria-label="关闭 OSPF 应用确认" title="关闭" :disabled="pending" @click="close">×</button>
      </header>
      <div class="ospf-apply-copy">
        <strong>即将更新 {{ nodes.length }} 个节点</strong>
        <span>应用会按节点执行检查、部署和重载；失败节点会显示原因并保留当前草稿。</span>
      </div>
      <div class="ospf-apply-list">
        <div v-for="node in nodes" :key="node.nodeId" class="ospf-apply-row" :class="`status-${node.status}`">
          <span class="ospf-apply-node"><i aria-hidden="true" /><strong>{{ node.name }}</strong><small>{{ node.nodeId }}</small></span>
          <span class="ospf-apply-status">{{ statusLabel[node.status] }}<small v-if="node.detail"> · {{ node.detail }}</small></span>
        </div>
      </div>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <button class="secondary-button" type="button" :disabled="pending" @click="close">取消</button>
        <button v-if="nodes.some((node) => node.status === 'failed' || node.status === 'unknown')" class="secondary-button" type="button" :disabled="pending" @click="emit('retry')">重试失败节点</button>
        <button class="primary-button" type="button" :disabled="pending || !nodes.length" @click="emit('confirm')">{{ pending ? "正在应用…" : "确认应用" }}</button>
      </div>
    </div>
  </dialog>
</template>
