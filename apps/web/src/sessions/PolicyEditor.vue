<script setup lang="ts">
import { computed, ref } from "vue";

import type {
  AddressFamily,
  ChannelPolicy,
  PolicyDefine,
  PolicyFilter,
  PolicyFunction,
  PolicyFunctionStep,
} from "@birdbox/contracts/inventory";

import type { ResourceWorkspaceTarget } from "../shared/events";
import { resourceScopeShortLabel } from "../shared/resource-scope";

const props = defineProps<{
  family: AddressFamily;
  direction: "import" | "export";
  policy: ChannelPolicy;
  exportDefineId: string | null;
  functions: PolicyFunction[];
  filters: PolicyFilter[];
  defines: PolicyDefine[];
  disabled: boolean;
}>();

const emit = defineEmits<{
  "update:policy": [policy: ChannelPolicy];
  "update:exportDefineId": [defineId: string | null];
  "open-policy-action": [];
}>();
const selectedFunctionId = ref("");

const label = computed(() => props.family === "ipv4" ? "IPv4" : "IPv6");
const directionLabel = computed(() => props.direction === "import" ? "导入" : "导出");
const callableFunctions = computed(() => props.functions.filter((resource) => resource.callable));
const functionSteps = computed(() => props.policy.steps.filter((step): step is PolicyFunctionStep => step.type === "function"));
const selectedFunctionIds = computed(() => new Set(functionSteps.value.map((step) => step.functionId)));
const availableFunctions = computed(() => callableFunctions.value.filter((resource) => !selectedFunctionIds.value.has(resource.id)));
const functionMap = computed(() => new Map(callableFunctions.value.map((resource) => [resource.id, resource])));
const orderedSteps = computed(() => props.policy.steps.length
  ? props.policy.steps
  : [{ type: "form" as const }]);

function updatePolicy(patch: Partial<ChannelPolicy>): void {
  emit("update:policy", { ...props.policy, ...patch });
}

function setMode(mode: "combined" | "custom"): void {
  updatePolicy({
    mode,
    steps: mode === "combined"
      ? (props.policy.steps.some((step) => step.type === "form") ? props.policy.steps : [...props.policy.steps, { type: "form" }])
      : [],
    filterId: mode === "custom" ? props.policy.filterId : null,
  });
}

function setFormAction(value: string): void {
  const formAction = props.direction === "import"
    ? (value === "none" ? "none" : "all")
    : (value === "all" || value === "cidr" ? value : "none");
  updatePolicy({ formAction });
  if (props.direction === "export" && formAction !== "cidr") emit("update:exportDefineId", null);
}

function setFilter(value: string): void {
  updatePolicy({ filterId: value || null });
}

function setFunctionAction(functionId: string, action: PolicyFunctionStep["action"]): void {
  updatePolicy({
    steps: props.policy.steps.map((step) => step.type === "function" && step.functionId === functionId
      ? { ...step, action }
      : step),
  });
}

function addFunction(functionId: string): void {
  if (!functionId || selectedFunctionIds.value.has(functionId) || functionSteps.value.length >= 16) return;
  const formIndex = props.policy.steps.findIndex((step) => step.type === "form");
  const step: PolicyFunctionStep = { type: "function", functionId, action: "execute" };
  const steps = [...props.policy.steps];
  steps.splice(formIndex < 0 ? steps.length : formIndex, 0, step);
  if (!steps.some((item) => item.type === "form")) steps.push({ type: "form" });
  updatePolicy({ mode: "combined", steps });
  selectedFunctionId.value = "";
}

function removeFunction(functionId: string): void {
  updatePolicy({ steps: props.policy.steps.filter((step) => step.type !== "function" || step.functionId !== functionId) });
}

function moveStep(index: number, offset: -1 | 1): void {
  const target = index + offset;
  if (target < 0 || target >= props.policy.steps.length) return;
  const steps = [...props.policy.steps];
  const current = steps[index];
  const replacement = steps[target];
  if (!current || !replacement) return;
  steps[index] = replacement;
  steps[target] = current;
  updatePolicy({ steps });
}

function stepTitle(step: ChannelPolicy["steps"][number]): string {
  if (step.type === "form") return "系统策略";
  return functionMap.value.get(step.functionId)?.label ?? functionMap.value.get(step.functionId)?.name ?? step.functionId;
}

function stepSubtitle(step: ChannelPolicy["steps"][number]): string {
  if (step.type === "form") {
    if (props.direction === "import") return props.policy.formAction === "none" ? "不导入" : "导入所有";
    if (props.policy.formAction === "all") return "导出所有";
    if (props.policy.formAction === "cidr") return "指定 CIDR";
    return "不导出";
  }
  const resource = functionMap.value.get(step.functionId);
  return resource ? `${resource.name}() · ${resourceScopeShortLabel(resource)}` : step.functionId;
}

function openResource(target: ResourceWorkspaceTarget): void {
  window.dispatchEvent(new CustomEvent("birdbox:workspace-resource-open", { detail: { target } }));
}
</script>

<template>
  <section class="policy-block">
    <div class="policy-heading">
      <div><span>{{ direction }}</span><h3>{{ directionLabel }}策略</h3></div>
      <small v-if="direction === 'export'">{{ disabled || policy.mode === "custom" ? "可视化配置已暂停" : "可视化配置生效" }}</small>
    </div>
    <div class="segmented-control" role="radiogroup" :aria-label="`${label} ${directionLabel}策略模式`">
      <label><input type="radio" :name="`${family}-${direction}-mode`" value="combined" :checked="policy.mode !== 'custom'" :disabled="disabled" @change="setMode('combined')"><span>可视化</span></label>
      <label><input type="radio" :name="`${family}-${direction}-mode`" value="custom" :checked="policy.mode === 'custom'" :disabled="disabled" @change="setMode('custom')"><span>自定义</span></label>
    </div>

    <div v-if="policy.mode !== 'custom'" class="policy-mode-fields">
      <div class="field-label-row">
        <span>策略步骤</span>
        <span class="policy-step-actions">
          <button class="compact-command compact-action-button" type="button" title="添加路由属性动作" :disabled="disabled" @click="emit('open-policy-action')">+ 属性动作</button>
          <button class="compact-icon manage-hint" type="button" title="前往资源管理 Tab 管理 Function" aria-label="前往资源管理 Tab 管理 Function" @click="openResource('functions')">?</button>
        </span>
      </div>
      <div class="function-picker">
        <div v-for="(step, index) in orderedSteps" :key="step.type === 'form' ? 'form' : step.functionId" class="function-step selected" :class="{ 'form-step': step.type === 'form' }">
          <span class="step-order">{{ index + 1 }}</span>
          <span class="step-lock" :class="{ function: step.type === 'function' }" aria-hidden="true">{{ step.type === "form" ? "F" : "ƒ" }}</span>
          <span class="step-name"><strong>{{ stepTitle(step) }}</strong><small>{{ stepSubtitle(step) }}</small></span>
          <select v-if="step.type === 'function'" :value="step.action" :disabled="disabled" :aria-label="`${stepTitle(step)} 命中动作`" @change="setFunctionAction(step.functionId, ($event.currentTarget as HTMLSelectElement).value as PolicyFunctionStep['action'])">
            <option value="accept">accept</option><option value="reject">reject</option><option value="execute">仅执行</option>
          </select>
          <span v-else class="step-action-static">系统策略</span>
          <span class="step-moves">
            <button type="button" title="上移" aria-label="上移策略步骤" :disabled="disabled || index === 0" @click="moveStep(index, -1)">↑</button>
            <button type="button" title="下移" aria-label="下移策略步骤" :disabled="disabled || index === orderedSteps.length - 1" @click="moveStep(index, 1)">↓</button>
            <button v-if="step.type === 'function'" type="button" title="移除" aria-label="移除 Function" :disabled="disabled" @click="removeFunction(step.functionId)">×</button>
          </span>
        </div>
        <div class="function-step-add">
          <select v-model="selectedFunctionId" aria-label="可用 Function" :disabled="disabled || availableFunctions.length === 0">
            <option value="">选择可用 Function</option>
            <option v-for="resource in availableFunctions" :key="resource.id" :value="resource.id">{{ resource.label ?? resource.name }} · {{ resource.name }}()</option>
          </select>
          <button type="button" title="添加 Function" aria-label="添加 Function" :disabled="disabled || !selectedFunctionId" @click="addFunction(selectedFunctionId)">+</button>
        </div>
      </div>
      <div class="policy-form-fields single-field">
        <div class="field"><label>可视化策略动作</label>
          <select :value="policy.formAction" :disabled="disabled" @change="setFormAction(($event.currentTarget as HTMLSelectElement).value)">
            <template v-if="direction === 'import'"><option value="all">导入所有</option><option value="none">不导入</option></template>
            <template v-else><option value="none">不导出</option><option value="all">导出所有</option><option value="cidr">导出指定 CIDR Define</option></template>
          </select>
        </div>
      </div>
      <div v-if="direction === 'export' && policy.formAction === 'cidr'" class="policy-form-fields">
        <div class="field"><label>{{ label }} CIDR Define</label>
          <div class="select-actions prefix-select-actions">
            <select :value="exportDefineId ?? ''" :disabled="disabled" required @change="emit('update:exportDefineId', ($event.currentTarget as HTMLSelectElement).value || null)">
              <option value="">不导出 CIDR</option>
              <option v-for="resource in defines" :key="resource.id" :value="resource.id">{{ resource.label }} · {{ resource.name }} · {{ resourceScopeShortLabel(resource) }}</option>
            </select>
            <button class="compact-icon manage-hint" type="button" title="前往资源管理 Tab 管理 Define" aria-label="前往资源管理 Tab 管理 Define" @click="openResource('defines')">?</button>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="policy-mode-fields">
      <div class="field-label-row"><label>完整 Filter</label><button class="compact-icon manage-hint" type="button" title="前往资源管理 Tab 管理 Filter" aria-label="前往资源管理 Tab 管理 Filter" @click="openResource('filters')">?</button></div>
      <select :value="policy.filterId ?? ''" :disabled="disabled" required @change="setFilter(($event.currentTarget as HTMLSelectElement).value)">
        <option value="">选择 Filter</option>
        <option v-for="resource in filters" :key="resource.id" :value="resource.id">{{ resource.label ?? resource.name }} · {{ resource.name }} · {{ resourceScopeShortLabel(resource) }}</option>
      </select>
    </div>
  </section>
</template>
