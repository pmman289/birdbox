<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";

import type { PeerMutationRequest, PeerMutationResponse } from "@birdbox/contracts/api";
import type { Peer } from "@birdbox/contracts/inventory";

import { loadDashboard, useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
import { deploymentSummary } from "../shared/deployment";
import { dispatchToast } from "../shared/events";
import { clearFormValidation, presentFormError, validateForm } from "../shared/form-validation";

const dialog = ref<HTMLDialogElement | null>(null);
const form = ref<HTMLFormElement | null>(null);
const editingId = ref<string | null>(null);
const nodeId = ref("");
const pending = ref(false);
const draft = reactive<PeerMutationRequest>({ name: "", address: "", asn: 0, port: 179 });
const { dashboard } = useDashboardStore();
const editing = computed(() => editingId.value !== null);
const nodes = computed(() => dashboard.value?.inventory.nodes ?? []);

const fieldMappings = [
  [/所属节点|不存在的节点/, "peerEditorNodeId"],
  [/Peer.*名称/, "peerEditorName"],
  [/Peer.*地址/, "peerEditorAddress"],
  [/Peer.*ASN/, "peerEditorAsn"],
  [/BGP 端口|Peer.*端口/, "peerEditorPort"],
] as const;

function open(peer: Peer | null): void {
  const selectedNodeId = peer?.nodeId ?? dashboard.value?.node?.id ?? nodes.value[0]?.id ?? "";
  if (!selectedNodeId) {
    dispatchToast("请先添加受管节点", "error");
    return;
  }
  editingId.value = peer?.id ?? null;
  nodeId.value = selectedNodeId;
  Object.assign(draft, { name: peer?.name ?? "", address: peer?.address ?? "", asn: peer?.asn ?? 0, port: peer?.port ?? 179 });
  if (form.value) clearFormValidation(form.value);
  if (!dialog.value?.open) dialog.value?.showModal();
  void nextTick(() => document.querySelector<HTMLInputElement>("#peerEditorName")?.focus());
}

function close(): void {
  if (!pending.value) dialog.value?.close();
}

async function save(): Promise<void> {
  if (!form.value || !validateForm(form.value)) return;
  pending.value = true;
  try {
    const id = editingId.value;
    const result = await api<PeerMutationResponse>(id ? `/api/peers/${encodeURIComponent(id)}` : `/api/nodes/${encodeURIComponent(nodeId.value)}/peers`, {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(draft),
    });
    await loadDashboard(nodeId.value, result.peer.id);
    dialog.value?.close();
    dispatchToast(id ? `Peer 已更新，${result.deployment ? deploymentSummary(result.deployment) : "配置已同步"}` : "Peer 已添加", "success");
  } catch (error) {
    presentFormError(form.value, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

async function remove(): Promise<void> {
  const peer = dashboard.value?.inventory.peers.find((item) => item.id === editingId.value);
  if (!peer || !window.confirm(`删除 Peer ${peer.name}？`)) return;
  pending.value = true;
  try {
    await api(`/api/peers/${encodeURIComponent(peer.id)}`, { method: "DELETE" });
    await loadDashboard(peer.nodeId);
    dialog.value?.close();
    dispatchToast("Peer 已删除", "success");
  } catch (error) {
    dispatchToast(error instanceof Error ? error.message : "Peer 删除失败", "error");
  } finally {
    pending.value = false;
  }
}

function handleCreate(event: CustomEvent<{ kind: string }>): void {
  if (event.detail.kind === "peers") open(null);
}

function handleEdit(event: CustomEvent<{ kind: string; id: string }>): void {
  if (event.detail.kind !== "peers") return;
  const peer = dashboard.value?.inventory.peers.find((item) => item.id === event.detail.id) ?? null;
  if (peer) open(peer);
}

onMounted(() => {
  window.addEventListener("birdbox:resource-create", handleCreate);
  window.addEventListener("birdbox:resource-edit", handleEdit);
});
onBeforeUnmount(() => {
  window.removeEventListener("birdbox:resource-create", handleCreate);
  window.removeEventListener("birdbox:resource-edit", handleEdit);
});
</script>

<template>
  <dialog id="peerDialog" ref="dialog" class="editor-dialog" aria-labelledby="peerDialogTitle" @cancel.prevent="close">
    <form id="peerForm" ref="form" novalidate :aria-busy="pending" @submit.prevent="save">
      <div class="dialog-head"><span class="dialog-icon remote">P</span><div><p class="eyebrow">远端定义</p><h2 id="peerDialogTitle">{{ editing ? "编辑外部 Peer" : "添加外部 Peer" }}</h2></div></div>
      <div class="dialog-grid">
        <div id="peerNodeField" class="field full-width"><label for="peerEditorNodeId">所属节点</label><select id="peerEditorNodeId" v-model="nodeId" required :disabled="editing"><option v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></div>
        <div class="field full-width"><label for="peerEditorName">Peer 名称</label><input id="peerEditorName" v-model.trim="draft.name" maxlength="80" required></div>
        <div class="field"><label for="peerEditorAddress">邻居地址</label><input id="peerEditorAddress" v-model.trim="draft.address" required></div>
        <div class="field"><label for="peerEditorAsn">远端 ASN</label><input id="peerEditorAsn" v-model.number="draft.asn" type="number" min="1" max="4294967295" required></div>
        <div class="field"><label for="peerEditorPort">BGP 端口</label><input id="peerEditorPort" v-model.number="draft.port" type="number" min="1" max="65535" required></div>
      </div>
      <div class="dialog-actions split-actions">
        <button v-if="editing" id="deletePeerButton" class="text-danger-button" type="button" :disabled="pending" @click="remove">删除 Peer</button><span></span>
        <button class="secondary-button" type="button" data-close="peerDialog" :disabled="pending" @click="close">取消</button>
        <button id="savePeerButton" class="primary-button" type="submit" :disabled="pending">{{ pending ? (editing ? "正在更新 Peer" : "正在添加 Peer") : "保存 Peer" }}</button>
      </div>
    </form>
  </dialog>
</template>
