<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRaw } from "vue";

import type {
  NodeMutationRequest,
  NodeMutationResponse,
  NodeSetupScriptResponse,
  NodeTestResponse,
} from "@birdbox/contracts/api";
import type { ManagedNode, RpkiSource } from "@birdbox/contracts/inventory";
import { resourceExplicitlyScopesNode } from "@birdbox/contracts/resource-scope";

import { useDashboardStore } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
import { copyText } from "../shared/copy-text";
import { deploymentSummary } from "../shared/deployment";
import { dispatchToast } from "../shared/events";
import { clearFormValidation, presentFormError, validateForm } from "../shared/form-validation";
import { loadDashboard } from "../dashboard/dashboard-store";

interface NodeDraft extends NodeMutationRequest {}
type NodeSystemPreset = "linux" | "openwrt";

const dialog = ref<HTMLDialogElement | null>(null);
const cleanupDialog = ref<HTMLDialogElement | null>(null);
const form = ref<HTMLFormElement | null>(null);
const editingId = ref<string | null>(null);
const pending = ref(false);
const verified = ref(false);
const onboardingStatus = ref("等待连接测试");
const onboardingState = ref("");
const setupScript = ref("");
const includeLine = ref("");
const cleanupNode = ref<ManagedNode | null>(null);
const cleanupForced = ref(false);
const systemPreset = ref<NodeSystemPreset>("linux");
const { dashboard } = useDashboardStore();

const draft = reactive<NodeDraft>({
  name: "",
  transport: "ssh",
  sshHost: "",
  sshPort: 22,
  sshUser: "",
  sshIdentity: "managed",
  deploymentMode: "include",
  mainConfigPath: "/etc/bird/bird.conf",
  generatedConfigPath: "/var/lib/birdbox/generated.conf",
  socketPath: "/run/bird/bird.ctl",
  routerId: "",
  listenPort: 179,
});

const editing = computed(() => editingId.value !== null);
const isSsh = computed(() => draft.transport === "ssh");
const saveDisabled = computed(() => pending.value || (!editing.value && !verified.value));
const globalRpkiResources = computed(() => (
  dashboard.value?.inventory.rpki.filter((resource) => resource.enabled && resource.nodeId === null) ?? []
));

const fieldMappings = [
  [/节点名称/, "nodeEditorName"],
  [/SSH 目标|节点地址/, "nodeEditorSshHost"],
  [/SSH 用户/, "nodeEditorSshUser"],
  [/SSH 端口/, "nodeEditorSshPort"],
  [/Router ID/, "nodeEditorRouterId"],
  [/监听端口|本地监听端口/, "nodeEditorPort"],
  [/主配置/, "nodeEditorMainConfigPath"],
  [/生成配置/, "nodeEditorGeneratedConfigPath"],
  [/Socket/, "nodeEditorSocketPath"],
] as const;

function resetDraft(node: ManagedNode | null): void {
  editingId.value = node?.id ?? null;
  systemPreset.value = node?.mainConfigPath === "/etc/bird.conf" ? "openwrt" : "linux";
  Object.assign(draft, {
    name: node?.name ?? "",
    transport: node?.transport ?? "ssh",
    sshHost: node?.sshHost ?? "",
    sshPort: node?.sshPort ?? 22,
    sshUser: node?.sshUser ?? "",
    sshIdentity: node?.sshIdentity ?? "managed",
    deploymentMode: node?.deploymentMode ?? "include",
    mainConfigPath: node?.mainConfigPath ?? "/etc/bird/bird.conf",
    generatedConfigPath: node?.generatedConfigPath ?? "/var/lib/birdbox/generated.conf",
    socketPath: node?.socketPath ?? "/run/bird/bird.ctl",
    routerId: node?.routerId ?? "",
    listenPort: node?.listenPort ?? 179,
  });
  verified.value = Boolean(node);
  onboardingStatus.value = node ? "已接入" : "等待连接测试";
  onboardingState.value = node ? "ready" : "";
  setupScript.value = "";
  includeLine.value = "";
  if (form.value) clearFormValidation(form.value);
}

function rpkiResourceDetails(resource: RpkiSource): Array<{ label: string; value: string }> {
  if (resource.sourceType === "file") {
    return [
      ...(resource.file4 === null ? [] : [{ label: "IPv4 文件", value: resource.file4 }]),
      ...(resource.file6 === null ? [] : [{ label: "IPv6 文件", value: resource.file6 }]),
    ];
  }
  return [{
    label: resource.transport === "ssh" ? "RPKI SSH" : "RPKI-RTR",
    value: `${resource.remote}:${resource.port}`,
  }];
}

function rpkiResourceAction(resource: RpkiSource): string {
  if (resource.sourceType === "file") return "先将 ROA 文件同步到上述路径并配置持续更新，再运行准备脚本。";
  return resource.transport === "ssh"
    ? "确认新节点可访问该 SSH 服务，且 BIRD 使用的用户、私钥与远端公钥已部署。"
    : "确认新节点可访问该 RPKI-RTR 地址和端口；使用 TCP-MD5 时还需确认两端密钥一致。";
}

function applySystemPreset(preset: NodeSystemPreset): void {
  systemPreset.value = preset;
  Object.assign(draft, preset === "openwrt" ? {
    mainConfigPath: "/etc/bird.conf",
    generatedConfigPath: "/etc/birdbox/generated.conf",
    socketPath: "/var/run/bird.ctl",
  } : {
    mainConfigPath: "/etc/bird/bird.conf",
    generatedConfigPath: "/var/lib/birdbox/generated.conf",
    socketPath: "/run/bird/bird.ctl",
  });
  changed();
}

function open(node: ManagedNode | null): void {
  resetDraft(node);
  if (!dialog.value?.open) dialog.value?.showModal();
  void nextTick(() => document.querySelector<HTMLInputElement>("#nodeEditorName")?.focus());
}

function close(): void {
  if (!pending.value) dialog.value?.close();
}

function onboardingPayload(): NodeMutationRequest {
  const value = toRaw(draft);
  return {
    name: String(value.name),
    transport: value.transport,
    sshHost: isSsh.value ? String(value.sshHost || "") || null : null,
    sshPort: isSsh.value ? Number(value.sshPort) : null,
    sshUser: isSsh.value ? String(value.sshUser || "") || null : null,
    sshIdentity: value.sshIdentity,
    deploymentMode: value.deploymentMode,
    mainConfigPath: String(value.mainConfigPath),
    generatedConfigPath: String(value.generatedConfigPath),
    socketPath: String(value.socketPath),
    routerId: String(value.routerId),
    listenPort: Number(value.listenPort),
  };
}

function changed(): void {
  if (editing.value) return;
  verified.value = false;
  onboardingStatus.value = "等待连接测试";
  onboardingState.value = "";
  setupScript.value = "";
  includeLine.value = "";
}

async function generateScript(): Promise<void> {
  if (!form.value || !validateForm(form.value)) return;
  pending.value = true;
  onboardingStatus.value = "正在生成";
  onboardingState.value = "";
  try {
    const result = await api<NodeSetupScriptResponse>("/api/nodes/setup-script", {
      method: "POST",
      body: JSON.stringify(onboardingPayload()),
    });
    setupScript.value = result.script;
    includeLine.value = result.includeLine;
    onboardingStatus.value = "脚本已生成";
  } catch (error) {
    onboardingStatus.value = "生成失败";
    onboardingState.value = "error";
    presentFormError(form.value, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

async function testConnection(): Promise<void> {
  if (!form.value || !validateForm(form.value)) return;
  pending.value = true;
  onboardingStatus.value = "正在检查 SSH、Include 与 BIRD";
  onboardingState.value = "";
  try {
    const result = await api<NodeTestResponse>("/api/nodes/test", {
      method: "POST",
      body: JSON.stringify(onboardingPayload()),
    });
    verified.value = true;
    onboardingStatus.value = `${result.runtime.version ?? "BIRD 2"} · 检查通过`;
    onboardingState.value = "ready";
    dispatchToast("节点接入检查通过", "success");
  } catch (error) {
    verified.value = false;
    onboardingStatus.value = "检查失败";
    onboardingState.value = "error";
    presentFormError(form.value, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

async function copyScript(): Promise<void> {
  try {
    await copyText(setupScript.value);
    dispatchToast("准备脚本已复制", "success");
  } catch {
    dispatchToast("无法访问剪贴板，请手动选择脚本内容", "error");
  }
}

async function save(): Promise<void> {
  if (!form.value || !validateForm(form.value)) return;
  if (!editing.value && !verified.value) {
    dispatchToast("请先完成节点连接测试", "error");
    return;
  }
  pending.value = true;
  try {
    const id = editingId.value;
    const result = await api<NodeMutationResponse>(id ? `/api/nodes/${encodeURIComponent(id)}` : "/api/nodes", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(onboardingPayload()),
    });
    await loadDashboard(result.node.id);
    dialog.value?.close();
    dispatchToast(id ? `节点已更新，${deploymentSummary(result.deployment)}` : "节点已添加", "success");
  } catch (error) {
    presentFormError(form.value, error, fieldMappings);
  } finally {
    pending.value = false;
  }
}

function showCleanup(node: ManagedNode, forced: boolean): void {
  cleanupNode.value = node;
  cleanupForced.value = forced;
  cleanupDialog.value?.showModal();
}

async function retire(force: boolean): Promise<void> {
  const node = dashboard.value?.inventory.nodes.find((item) => item.id === editingId.value);
  if (!node) return;
  if (!force) {
    if (!window.confirm(`安全退役节点 ${node.name}？Birdbox 将先清空远端受管 include；控制器公钥和主配置 include 行仍需手动删除。`)) return;
  } else {
    const inventory = dashboard.value?.inventory;
    if (!inventory) return;
    const counts = [
      ["Sessions", inventory.sessions.filter((item) => item.nodeId === node.id).length],
      ["Peers", inventory.peers.filter((item) => item.nodeId === node.id).length],
      ["Defines", inventory.defines.filter((item) => resourceExplicitlyScopesNode(item, node.id)).length],
      ["Functions", inventory.functions.filter((item) => resourceExplicitlyScopesNode(item, node.id)).length],
      ["Filters", inventory.filters.filter((item) => item.nodeId === node.id).length],
      ["RPKI", inventory.rpki.filter((item) => item.nodeId === node.id).length],
      ["Static", inventory.staticProtocols.filter((item) => item.nodeId === node.id).length],
    ].map(([label, count]) => `${label} ${count}`).join("、");
    if (!window.confirm(`强制遗忘 ${node.name} (${node.sshHost}:${node.sshPort})？将处理关联资源：${counts}。多节点 Define/Function 只会移除此节点的可用范围；操作不会清理远端配置。`)) return;
    const confirmation = `遗忘 ${node.id}`;
    if (window.prompt(`请输入“${confirmation}”以确认：`) !== confirmation) return;
  }
  pending.value = true;
  try {
    await api(`/api/nodes/${encodeURIComponent(node.id)}${force ? "?force=true" : ""}`, { method: "DELETE" });
    await loadDashboard();
    dialog.value?.close();
    showCleanup(node, force);
  } catch (error) {
    dispatchToast(error instanceof Error ? error.message : "节点删除失败", "error");
  } finally {
    pending.value = false;
  }
}

function handleCreate(event: CustomEvent<{ kind: string }>): void {
  if (event.detail.kind === "nodes") open(null);
}

function handleEdit(event: CustomEvent<{ kind: string; id: string }>): void {
  if (event.detail.kind !== "nodes") return;
  const node = dashboard.value?.inventory.nodes.find((item) => item.id === event.detail.id) ?? null;
  if (node) open(node);
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
  <dialog id="nodeDialog" ref="dialog" class="editor-dialog" aria-labelledby="nodeDialogTitle" @cancel.prevent="close">
    <form id="nodeForm" ref="form" novalidate :aria-busy="pending" @submit.prevent="save" @input="changed">
      <div class="dialog-head"><span class="dialog-icon">N</span><div><p class="eyebrow">资产</p><h2 id="nodeDialogTitle">{{ editing ? "编辑受管节点" : "添加受管节点" }}</h2></div></div>
      <div class="dialog-grid">
        <div class="field full-width"><label for="nodeEditorName">节点名称</label><input id="nodeEditorName" v-model.trim="draft.name" maxlength="80" required></div>
        <div class="field"><span class="field-label">管理方式</span><div class="field-readonly">{{ isSsh ? "SSH" : "本机" }}</div></div>
        <template v-if="isSsh">
          <div id="sshHostField" class="field"><label for="nodeEditorSshHost">节点地址</label><input id="nodeEditorSshHost" v-model.trim="draft.sshHost" placeholder="router.example" required :disabled="editing"></div>
          <div class="field"><label for="nodeEditorSshUser">SSH 用户</label><input id="nodeEditorSshUser" v-model.trim="draft.sshUser" placeholder="birdbox" required :disabled="editing"></div>
          <div class="field"><label for="nodeEditorSshPort">SSH 端口</label><input id="nodeEditorSshPort" v-model.number="draft.sshPort" type="number" min="1" max="65535" required :disabled="editing"></div>
        </template>
        <div class="field"><label for="nodeEditorRouterId">Router ID</label><input id="nodeEditorRouterId" v-model.trim="draft.routerId" required></div>
        <div class="field"><label for="nodeEditorPort">默认会话端口</label><input id="nodeEditorPort" v-model.number="draft.listenPort" type="number" min="1" max="65535" required></div>
        <details id="nodeBirdPaths" class="node-path-settings full-width" :open="!editing || draft.deploymentMode === 'include'">
          <summary>系统 BIRD 路径</summary>
          <div class="dialog-grid node-path-grid">
            <div v-if="!editing" class="field full-width"><span class="field-label">系统预设</span><div class="segmented-control" role="radiogroup" aria-label="节点系统预设"><label><input :checked="systemPreset === 'linux'" type="radio" name="nodeSystemPreset" value="linux" @change="applySystemPreset('linux')"><span>Linux</span></label><label><input :checked="systemPreset === 'openwrt'" type="radio" name="nodeSystemPreset" value="openwrt" @change="applySystemPreset('openwrt')"><span>OpenWrt</span></label></div></div>
            <div class="field full-width"><label for="nodeEditorMainConfigPath">主配置</label><input id="nodeEditorMainConfigPath" v-model.trim="draft.mainConfigPath" required :disabled="editing"></div>
            <div class="field full-width"><label for="nodeEditorGeneratedConfigPath">生成配置</label><input id="nodeEditorGeneratedConfigPath" v-model.trim="draft.generatedConfigPath" required :disabled="editing"></div>
            <div class="field full-width"><label for="nodeEditorSocketPath">控制 Socket</label><input id="nodeEditorSocketPath" v-model.trim="draft.socketPath" required :disabled="editing"></div>
          </div>
        </details>
        <section v-if="!editing && globalRpkiResources.length" id="nodeGlobalRpkiWarning" class="node-rpki-warning full-width" role="status" aria-live="polite">
          <div class="node-rpki-warning-head"><strong>全节点 RPKI 前置条件</strong><span>{{ globalRpkiResources.length }} 个资源</span></div>
          <p>这些资源会自动应用到新节点。请在测试连接前完成对应处理；不适用于该节点时，请先到 RPKI 资源中把作用域改为指定节点。</p>
          <ul><li v-for="resource in globalRpkiResources" :key="resource.id"><strong>{{ resource.label }}</strong><div v-for="detail in rpkiResourceDetails(resource)" :key="`${resource.id}:${detail.label}:${detail.value}`"><span>{{ detail.label }}</span><code>{{ detail.value }}</code></div><p class="node-rpki-action"><span>处理</span>{{ rpkiResourceAction(resource) }}</p></li></ul>
        </section>
        <section v-if="!editing" id="nodeOnboardingPanel" class="node-onboarding full-width">
          <div class="node-onboarding-head"><strong>节点接入</strong><span :class="onboardingState">{{ onboardingStatus }}</span></div>
          <div class="node-onboarding-actions">
            <button id="generateNodeSetupButton" class="secondary-button" type="button" :disabled="pending" @click="generateScript">{{ pending && onboardingStatus === "正在生成" ? "正在生成" : "生成准备脚本" }}</button>
            <button id="testNodeConnectionButton" class="secondary-button" type="button" :disabled="pending" @click="testConnection">测试连接</button>
          </div>
          <div v-if="setupScript" id="nodeSetupGuide" class="node-setup-guide">
            <div class="setup-guide-heading"><span>在目标节点以 root 身份执行</span><button id="copyNodeSetupButton" class="compact-command" type="button" @click="copyScript">复制脚本</button></div>
            <pre id="nodeSetupScript">{{ setupScript }}</pre>
            <div class="setup-include"><span>脚本将自动写入主配置</span><code id="nodeIncludeLine">{{ includeLine }}</code></div>
          </div>
        </section>
      </div>
      <div class="dialog-actions split-actions">
        <div v-if="editing" id="nodeRetireActions" class="node-retire-actions">
          <button id="deleteNodeButton" class="text-danger-button" type="button" :disabled="pending" @click="retire(false)">安全退役</button>
          <details><summary>节点永久离线</summary><button id="forceDeleteNodeButton" class="text-danger-button" type="button" :disabled="pending" @click="retire(true)">强制遗忘</button></details>
        </div>
        <span></span>
        <button class="secondary-button" type="button" data-close="nodeDialog" :disabled="pending" @click="close">取消</button>
        <button id="saveNodeButton" class="primary-button" type="submit" :disabled="saveDisabled">{{ pending ? (editing ? "正在更新节点" : "正在添加节点") : "保存节点" }}</button>
      </div>
    </form>
  </dialog>

  <dialog id="nodeCleanupDialog" ref="cleanupDialog" aria-labelledby="nodeCleanupDialogTitle">
    <form method="dialog">
      <div class="dialog-head"><span class="dialog-icon managed">!</span><div><p class="eyebrow">需要人工清理</p><h2 id="nodeCleanupDialogTitle">{{ cleanupForced ? "节点已强制遗忘" : "节点已安全退役，仍需人工清理" }}</h2></div></div>
      <p id="nodeCleanupTarget" class="dialog-note">SSH {{ cleanupNode?.sshUser ? `${cleanupNode.sshUser}@` : "" }}{{ cleanupNode?.sshHost }}:{{ cleanupNode?.sshPort }} · 主配置 {{ cleanupNode?.mainConfigPath }} · 生成配置 {{ cleanupNode?.generatedConfigPath }} · Socket {{ cleanupNode?.socketPath }}</p>
      <ul class="cleanup-list"><li>先从主配置移除 include 行并执行 BIRD configure check/configure</li><li>再删除远端生成配置，最后从 authorized_keys 删除控制器公钥</li><li v-if="cleanupNode?.mainConfigPath === '/etc/bird.conf'">OpenWrt 节点还需移除 /etc/init.d/bird 启动命令中的 Birdbox 管理组参数并重启 BIRD</li><li>重新纳管或复用主机前核对 BIRD 当前配置</li></ul>
      <div class="dialog-actions"><button class="primary-button" value="default">我已记录</button></div>
    </form>
  </dialog>
</template>
