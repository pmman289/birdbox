<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type { AddressFamily, ChannelPolicy, DirectProtocol, KernelExportPolicy, KernelProtocol } from "@birdbox/contracts/inventory";
import { useDashboardStore, loadDashboard } from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
import { dispatchToast } from "../shared/events";
import PolicyEditor from "../sessions/PolicyEditor.vue";
import { resourceAppliesToNode } from "@birdbox/contracts/resource-scope";

const dialog = ref<HTMLDialogElement | null>(null);
const editingId = ref<string | null>(null);
const kind = ref<"directs" | "kernels">("directs");
const pending = ref(false);
const interfaceLoading = ref(false);
const interfaceError = ref("");
let interfaceRequestId = 0;
let interfaceController: AbortController | null = null;
const interfaceSearch = ref("");
const interfaceOptions = ref<string[]>([]);
const kernelNodeSearch = ref("");
const { dashboard } = useDashboardStore();
const defaultPolicy = (direction: "import" | "export"): ChannelPolicy => ({ mode: "form", steps: [], filterId: null, formAction: direction === "import" ? "none" : "all" });
function clonePolicy(policy: ChannelPolicy): ChannelPolicy {
  return {
    mode: policy.mode,
    steps: policy.steps.map((step) => ({ ...step })),
    filterId: policy.filterId,
    formAction: policy.formAction,
  };
}
function defaultKernelExportPolicy(): KernelExportPolicy {
  return { mode: "visual", policy: defaultPolicy("export"), prefSrc: null };
}
function cloneKernelExportPolicy(value: KernelExportPolicy | undefined, fallback: ChannelPolicy): KernelExportPolicy {
  if (!value) return { mode: "visual", policy: clonePolicy(fallback), prefSrc: null };
  return {
    mode: value.mode === "krt_prefsrc" ? "krt_prefsrc" : "visual",
    policy: clonePolicy(value.policy ?? fallback),
    prefSrc: value.prefSrc ?? null,
  };
}
const draft = reactive<any>({
  label: "", name: "birdbox_direct", nodeId: "", nodeIds: [] as string[], kernelGlobal: true, interfaces: [] as string[], ipv4: true, ipv6: true,
  importPolicy: defaultPolicy("import"), exportPolicy: defaultPolicy("export"), exportPolicies: { ipv4: defaultKernelExportPolicy(), ipv6: defaultKernelExportPolicy() }, table: null, scanTime: 60, persist: false, enabled: true,
});
const editing = computed(() => editingId.value !== null);
const nodes = computed(() => dashboard.value?.inventory.nodes ?? []);
const functions = computed(() => dashboard.value?.inventory.functions.filter((item) => item.enabled) ?? []);
const filters = computed(() => dashboard.value?.inventory.filters.filter((item) => item.enabled) ?? []);
const defines = computed(() => dashboard.value?.inventory.defines.filter((item) => item.enabled) ?? []);
const enabledKernelFamilies = computed<AddressFamily[]>(() => [
  ...(draft.ipv4 ? ["ipv4" as const] : []),
  ...(draft.ipv6 ? ["ipv6" as const] : []),
]);
const kernelTargetNodeIds = computed(() => draft.kernelGlobal ? nodes.value.map((node) => node.id) : draft.nodeIds);
const kernelFunctions = computed(() => functions.value.filter((item) => kernelTargetNodeIds.value.every((nodeId: string) => resourceAppliesToNode(item, nodeId))));
const kernelFilters = computed(() => filters.value.filter((item) => kernelTargetNodeIds.value.every((nodeId: string) => resourceAppliesToNode(item, nodeId))));
const visibleKernelNodes = computed(() => {
  const query = kernelNodeSearch.value.trim().toLocaleLowerCase();
  return query ? nodes.value.filter((node) => `${node.name} ${node.id} ${node.routerId}`.toLocaleLowerCase().includes(query)) : nodes.value;
});
const filteredInterfaces = computed(() => {
  const query = interfaceSearch.value.trim().toLowerCase();
  return interfaceOptions.value.filter((item) => !query || item.toLowerCase().includes(query));
});

function policyPreview(policy: ChannelPolicy, direction: "import" | "export"): string[] {
  if (policy.mode === "custom") {
    const filter = policy.filterId ? filters.value.find((item) => item.id === policy.filterId) : undefined;
    return [`  ${direction} filter ${filter?.name ?? "<未选择 Filter>"};`];
  }
  if (policy.mode === "form" && (direction === "export" || policy.steps.length === 0)) {
    return [`  ${direction} ${policy.formAction};`];
  }
  const lines = [`  ${direction} filter {`];
  for (const step of policy.steps) {
    if (step.type === "form") {
      if (direction === "import" || policy.formAction !== "none") lines.push(`    ${policy.formAction === "all" ? "accept" : "reject"};`);
      continue;
    }
    const fn = functions.value.find((item) => item.id === step.functionId);
    if (!fn) continue;
    lines.push(step.action === "execute" ? `    ${fn.name}();` : `    if ${fn.name}() then ${step.action};`);
  }
  if (direction === "export") lines.push("    reject;");
  lines.push("  };");
  return lines;
}

function kernelExportPreview(family: AddressFamily): string[] {
  const setting = draft.exportPolicies[family] as KernelExportPolicy;
  if (setting.mode === "krt_prefsrc") {
    return setting.prefSrc
      ? [`  export filter {`, `    krt_prefsrc = ${setting.prefSrc};`, "    accept;", "  };"]
      : ["  export filter {", "    # 请输入源地址", "    accept;", "  };"];
  }
  return policyPreview(setting.policy, "export");
}

const configPreview = computed(() => {
  if (kind.value === "directs") {
    const name = draft.name.trim() || "birdbox_direct";
    const interfaces = draft.interfaces.length ? draft.interfaces : ["*"];
    return [
      `protocol direct ${name} {`,
      `  interface ${interfaces.map((item: string) => `"${item.replaceAll('"', '\\"')}"`).join(", ")};`,
      ...(draft.ipv4 ? ["  ipv4;"] : []),
      ...(draft.ipv6 ? ["  ipv6;"] : []),
      "}",
    ].join("\n");
  }
  const families = [
    ...(draft.ipv4 ? [{ name: "ipv4", suffix: "4" }] : []),
    ...(draft.ipv6 ? [{ name: "ipv6", suffix: "6" }] : []),
  ];
  const targets = draft.kernelGlobal ? "所有节点" : nodes.value.filter((node) => draft.nodeIds.includes(node.id)).map((node) => node.name).join("、") || "未选择节点";
  const lines = [`# 下发节点：${targets}`];
  for (const family of families) {
    const protocolName = families.length === 1 ? (draft.name.trim() || "birdbox_kernel") : `${draft.name.trim() || "birdbox_kernel"}${family.suffix}`;
    lines.push("", `protocol kernel ${protocolName} {`);
    if (draft.table !== null && draft.table !== "") lines.push(`  kernel table ${draft.table};`);
    if (draft.scanTime !== null && draft.scanTime !== "") lines.push(`  scan time ${draft.scanTime};`);
    if (draft.persist) lines.push("  persist;");
    lines.push(`  ${family.name} {`, ...policyPreview(draft.importPolicy, "import"), ...kernelExportPreview(family.name as AddressFamily), "  };", "}");
  }
  return lines.join("\n");
});

const kernelScopeMode = computed<"all" | "selected">({
  get: () => draft.kernelGlobal ? "all" : "selected",
  set: (mode) => { draft.kernelGlobal = mode === "all"; },
});

function reset(resource: DirectProtocol | KernelProtocol | null): void {
  editingId.value = resource?.id ?? null;
  if (kind.value === "directs") {
    const item = resource as DirectProtocol | null;
    Object.assign(draft, { label: item?.label ?? "", name: item?.name ?? "birdbox_direct", nodeId: item?.nodeId ?? nodes.value[0]?.id ?? "", interfaces: [...(item?.interfaces ?? [])], ipv4: item?.ipv4 ?? true, ipv6: item?.ipv6 ?? true, enabled: item?.enabled ?? true });
    interfaceSearch.value = "";
    interfaceError.value = "";
    interfaceOptions.value = [...(item?.interfaces ?? [])];
  } else {
    const item = resource as KernelProtocol | null;
    const fallbackExport = item?.exportPolicy ?? defaultPolicy("export");
    Object.assign(draft, { label: item?.label ?? "", name: item?.name ?? "birdbox_kernel", kernelGlobal: item ? item.nodeIds === null : true, nodeIds: [...(item?.nodeIds ?? [])], ipv4: item?.ipv4 ?? true, ipv6: item?.ipv6 ?? true, importPolicy: clonePolicy(item?.importPolicy ?? defaultPolicy("import")), exportPolicy: clonePolicy(fallbackExport), exportPolicies: { ipv4: cloneKernelExportPolicy(item?.exportPolicies?.ipv4, fallbackExport), ipv6: cloneKernelExportPolicy(item?.exportPolicies?.ipv6, fallbackExport) }, table: item?.table ?? null, scanTime: item?.scanTime ?? 60, persist: item?.persist ?? false, enabled: item?.enabled ?? true });
    kernelNodeSearch.value = "";
  }
}

function open(nextKind: "directs" | "kernels", resource: DirectProtocol | KernelProtocol | null): void {
  interfaceRequestId += 1;
  interfaceController?.abort();
  interfaceController = null;
  kind.value = nextKind;
  reset(resource);
  if (nextKind === "directs") void loadInterfaces(draft.nodeId);
  dialog.value?.showModal();
}

function setKernelScope(mode: "all" | "selected"): void {
  draft.kernelGlobal = mode === "all";
}

function toggleNode(nodeId: string): void {
  draft.nodeIds = draft.nodeIds.includes(nodeId) ? draft.nodeIds.filter((id: string) => id !== nodeId) : [...draft.nodeIds, nodeId];
}

function selectAllKernelNodes(): void {
  draft.nodeIds = nodes.value.map((node) => node.id);
}

function clearKernelNodes(): void {
  draft.nodeIds = [];
}

function interfacesValue(): string {
  return draft.interfaces.join(", ");
}

async function loadInterfaces(nodeId: string): Promise<void> {
  const requestId = ++interfaceRequestId;
  interfaceController?.abort();
  const controller = new AbortController();
  interfaceController = controller;
  interfaceOptions.value = [...new Set(draft.interfaces as string[])];
  interfaceError.value = "";
  if (!nodeId || kind.value !== "directs") {
    interfaceLoading.value = false;
    interfaceController = null;
    return;
  }
  interfaceLoading.value = true;
  try {
    const response = await api<{ interfaces: string[] }>(`/api/nodes/${encodeURIComponent(nodeId)}/interfaces`, { signal: controller.signal });
    if (requestId !== interfaceRequestId || controller.signal.aborted || draft.nodeId !== nodeId) return;
    interfaceOptions.value = [...new Set([...response.interfaces, ...draft.interfaces])].sort();
  } catch (error) {
    if (controller.signal.aborted || requestId !== interfaceRequestId) return;
    interfaceError.value = error instanceof Error ? error.message : "无法读取节点接口，可继续手动填写";
  } finally {
    if (requestId === interfaceRequestId) {
      interfaceLoading.value = false;
      interfaceController = null;
    }
  }
}

function toggleInterface(name: string): void {
  draft.interfaces = draft.interfaces.includes(name)
    ? draft.interfaces.filter((item: string) => item !== name)
    : [...draft.interfaces, name];
}

function setManualInterfaces(event: Event): void {
  draft.interfaces = String((event.target as HTMLInputElement).value)
    .split(",").map((value) => value.trim()).filter(Boolean);
}

function selectDirectNode(): void {
  draft.interfaces = [];
  void loadInterfaces(draft.nodeId);
}

async function save(): Promise<void> {
  if (!draft.label.trim() || !draft.name.trim()) return dispatchToast("请填写显示名称和协议名称", "error");
  if (kind.value === "directs" && !draft.nodeId) return dispatchToast("请选择 Direct 所属节点", "error");
  if (kind.value === "kernels" && !draft.kernelGlobal && !draft.nodeIds.length) return dispatchToast("Kernel 至少选择一个节点", "error");
  if (!draft.ipv4 && !draft.ipv6) return dispatchToast("至少启用一个地址族", "error");
  pending.value = true;
  try {
    const body = kind.value === "directs"
      ? { label: draft.label, name: draft.name, nodeId: draft.nodeId, interfaces: draft.interfaces, ipv4: draft.ipv4, ipv6: draft.ipv6, enabled: draft.enabled }
      : { label: draft.label, name: draft.name, nodeIds: draft.kernelGlobal ? null : draft.nodeIds, ipv4: draft.ipv4, ipv6: draft.ipv6, importPolicy: draft.importPolicy, exportPolicy: draft.exportPolicies.ipv4.policy, exportPolicies: draft.exportPolicies, table: draft.table === "" ? null : draft.table, scanTime: draft.scanTime === "" ? null : draft.scanTime, persist: draft.persist, enabled: draft.enabled };
    await api(editingId.value ? `/api/${kind.value}/${encodeURIComponent(editingId.value)}` : `/api/${kind.value}`, { method: editingId.value ? "PUT" : "POST", body: JSON.stringify(body) });
    await loadDashboard(dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null);
    dialog.value?.close();
    dispatchToast("协议资源已保存并应用", "success");
  } catch (error) {
    dispatchToast(error instanceof Error ? error.message : "协议资源保存失败", "error");
  } finally { pending.value = false; }
}

async function remove(): Promise<void> {
  if (!editingId.value || !confirm("确认删除该协议资源？")) return;
  pending.value = true;
  try {
    await api(`/api/${kind.value}/${encodeURIComponent(editingId.value)}`, { method: "DELETE" });
    await loadDashboard(dashboard.value?.node?.id ?? null, dashboard.value?.selectedPeer?.id ?? null);
    dialog.value?.close();
    dispatchToast("协议资源已删除", "success");
  } catch (error) { dispatchToast(error instanceof Error ? error.message : "协议资源删除失败", "error"); } finally { pending.value = false; }
}

function close(): void {
  if (!pending.value) dialog.value?.close();
}

function handleCreate(event: CustomEvent<{ kind: string }>): void { if (event.detail.kind === "directs" || event.detail.kind === "kernels") open(event.detail.kind, null); }
function handleEdit(event: CustomEvent<{ kind: string; id: string }>): void {
  if (event.detail.kind !== "directs" && event.detail.kind !== "kernels") return;
  const resource = event.detail.kind === "directs" ? dashboard.value?.inventory.directProtocols.find((item) => item.id === event.detail.id) : dashboard.value?.inventory.kernelProtocols.find((item) => item.id === event.detail.id);
  open(event.detail.kind, resource ?? null);
}
onMounted(() => { window.addEventListener("birdbox:resource-create", handleCreate); window.addEventListener("birdbox:resource-edit", handleEdit); });
onBeforeUnmount(() => { interfaceRequestId += 1; interfaceController?.abort(); window.removeEventListener("birdbox:resource-create", handleCreate); window.removeEventListener("birdbox:resource-edit", handleEdit); });
</script>

<template>
  <dialog ref="dialog" class="editor-dialog" :aria-labelledby="`${kind}DialogTitle`" @cancel.prevent="close">
    <form @submit.prevent="save">
      <div class="dialog-head"><span class="dialog-icon">{{ kind === 'directs' ? 'D' : 'K' }}</span><div><p class="eyebrow">资源</p><h2 :id="`${kind}DialogTitle`">{{ editing ? '编辑' : '添加' }} {{ kind === 'directs' ? 'Direct' : 'Kernel' }}</h2></div></div>
      <div class="dialog-grid">
        <div class="field"><label>显示名称</label><input v-model.trim="draft.label" required></div>
        <div class="field"><label>协议名称</label><input v-model.trim="draft.name" pattern="[A-Za-z_][A-Za-z0-9_]*" required></div>
        <template v-if="kind === 'directs'">
          <div class="field full-width"><label for="directNode">所属节点</label><select id="directNode" v-model="draft.nodeId" @change="selectDirectNode"><option value="" disabled>请选择节点</option><option v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }} · {{ node.routerId }}</option></select></div>
          <div class="field full-width">
            <div class="field-label-row"><span>学习接口</span><button class="secondary-button compact-command" type="button" :disabled="interfaceLoading || !draft.nodeId" @click="loadInterfaces(draft.nodeId)">{{ interfaceLoading ? '读取中…' : '刷新接口' }}</button></div>
            <div class="interface-picker">
              <div class="interface-picker-toolbar"><input v-model="interfaceSearch" type="search" placeholder="搜索节点接口" aria-label="搜索节点接口"><span>{{ interfaceOptions.length ? `${draft.interfaces.length} 个已选择` : '暂无接口目录' }}</span></div>
              <div v-if="filteredInterfaces.length" class="interface-option-list">
                <label v-for="item in filteredInterfaces" :key="item" class="interface-option"><input type="checkbox" :checked="draft.interfaces.includes(item)" @change="toggleInterface(item)"><span><strong>{{ item }}</strong><small>来自节点接口目录</small></span></label>
              </div>
              <p v-else class="interface-empty">{{ interfaceLoading ? '正在读取节点接口…' : '未发现接口，可直接手动填写下方规则。' }}</p>
            </div>
            <input :value="interfacesValue()" class="interface-manual-input" placeholder="手动填写接口或匹配规则，多个值用逗号分隔；留空匹配全部" aria-label="手动填写接口或匹配规则" @input="setManualInterfaces">
            <small v-if="interfaceError" class="field-error">{{ interfaceError }}</small>
            <small v-else class="field-help">选择接口会生成精确的 interface 列表；也可以填写通配符规则。</small>
          </div>
          <div class="field full-width"><span class="field-label">地址族</span><div class="address-family-options" role="group" aria-label="Direct 地址族"><label><input v-model="draft.ipv4" type="checkbox"><span>IPv4</span></label><label><input v-model="draft.ipv6" type="checkbox"><span>IPv6</span></label></div></div>
        </template>
        <template v-else>
          <div class="field full-width kernel-scope-field">
            <div class="field-label-row"><span>下发节点</span><span>{{ draft.kernelGlobal ? '所有节点' : `已选择 ${draft.nodeIds.length} 个节点` }}</span></div>
            <div class="segmented-control kernel-scope-mode" role="radiogroup" aria-label="Kernel 下发节点范围">
              <label><input v-model="kernelScopeMode" type="radio" name="kernelScopeMode" value="all"><span>所有节点</span></label>
              <label><input v-model="kernelScopeMode" type="radio" name="kernelScopeMode" value="selected"><span>指定节点</span></label>
            </div>
            <div v-if="!draft.kernelGlobal" class="policy-scope-selector">
              <div class="policy-scope-toolbar"><input v-model.trim="kernelNodeSearch" type="search" autocomplete="off" placeholder="搜索节点" aria-label="搜索 Kernel 下发节点"><span><button class="compact-command" type="button" @click="selectAllKernelNodes">全选</button><button class="compact-command" type="button" @click="clearKernelNodes">清空</button></span></div>
              <div class="policy-scope-node-list"><label v-for="node in visibleKernelNodes" :key="node.id" class="policy-scope-node"><input type="checkbox" :checked="draft.nodeIds.includes(node.id)" @change="toggleNode(node.id)"><span><strong>{{ node.name }}</strong><code>{{ node.routerId }}</code></span></label><span v-if="!visibleKernelNodes.length" class="code-reference-empty">没有匹配的节点</span></div>
              <p v-if="!draft.nodeIds.length" class="field-error" role="alert">请至少选择一个节点</p>
            </div>
          </div>
          <div class="field"><label>Linux 路由表</label><input v-model.number="draft.table" type="number" min="1" max="4294967295" placeholder="留空使用 main"></div>
          <div class="field"><label>扫描周期（秒）</label><input v-model.number="draft.scanTime" type="number" min="1" max="86400"></div>
          <label class="toggle-row full-width"><span>持久化内核路由</span><input v-model="draft.persist" type="checkbox"><i></i></label>
          <div class="field full-width"><span class="field-label">地址族</span><div class="address-family-options" role="group" aria-label="Kernel 地址族"><label><input v-model="draft.ipv4" type="checkbox"><span>IPv4</span></label><label><input v-model="draft.ipv6" type="checkbox"><span>IPv6</span></label></div><small class="field-help">导入策略共用一份设置；导出策略可按 IPv4/IPv6 分别配置。</small></div>
          <PolicyEditor :family="draft.ipv4 ? 'ipv4' : 'ipv6'" direction="import" :policy="draft.importPolicy" :export-define-id="null" :functions="kernelFunctions" :filters="kernelFilters" :defines="defines" :disabled="pending" :show-policy-action="false" @update:policy="draft.importPolicy = $event" />
          <section v-for="family in enabledKernelFamilies" :key="`kernel-export-${family}`" class="kernel-export-policy full-width">
            <div class="kernel-export-policy-head"><div><span class="field-label">{{ family === 'ipv4' ? 'IPv4' : 'IPv6' }} 导出策略</span><small class="field-help">选择快速设置源地址，或打开可视化编辑器。</small></div></div>
            <div class="segmented-control kernel-export-mode" role="radiogroup" :aria-label="`${family} Kernel 导出策略模式`">
              <label><input v-model="draft.exportPolicies[family].mode" type="radio" :name="`kernelExportMode-${family}`" value="krt_prefsrc"><span>快速设置 krt_prefsrc</span></label>
              <label><input v-model="draft.exportPolicies[family].mode" type="radio" :name="`kernelExportMode-${family}`" value="visual"><span>可视化编辑</span></label>
            </div>
            <div v-if="draft.exportPolicies[family].mode === 'krt_prefsrc'" class="field kernel-prefsrc-field">
              <label :for="`kernelPrefSrc-${family}`">源地址（{{ family === 'ipv4' ? 'IPv4' : 'IPv6' }}）</label>
              <input :id="`kernelPrefSrc-${family}`" v-model.trim="draft.exportPolicies[family].prefSrc" :placeholder="family === 'ipv4' ? '例如 192.0.2.1' : '例如 2001:db8::1'" :inputmode="family === 'ipv4' ? 'decimal' : 'text'">
              <small class="field-help">生成 `krt_prefsrc` 并接受路由；地址必须与地址族匹配。</small>
            </div>
            <PolicyEditor v-else :family="family" direction="export" :policy="draft.exportPolicies[family].policy" :export-define-id="null" :functions="kernelFunctions" :filters="kernelFilters" :defines="defines" :disabled="pending" :show-policy-action="false" :allow-export-cidr="false" @update:policy="draft.exportPolicies[family].policy = $event" />
          </section>
        </template>
        <section class="system-protocol-preview full-width" aria-labelledby="systemProtocolPreviewTitle">
          <div class="system-protocol-preview-head"><div><span class="eyebrow">GENERATED CONFIGURATION</span><h3 id="systemProtocolPreviewTitle">配置预览</h3></div><small>表单修改后实时更新</small></div>
          <pre>{{ configPreview }}</pre>
        </section>
        <label class="toggle-row full-width"><span>启用资源</span><input v-model="draft.enabled" type="checkbox"><i></i></label>
      </div>
      <div class="dialog-actions split-actions"><button v-if="editing" class="text-danger-button" type="button" :disabled="pending" @click="remove">删除资源</button><span></span><button class="secondary-button" type="button" :disabled="pending" @click="close">取消</button><button class="primary-button" type="submit" :disabled="pending">{{ pending ? '正在应用' : '保存并应用' }}</button></div>
    </form>
  </dialog>
</template>
