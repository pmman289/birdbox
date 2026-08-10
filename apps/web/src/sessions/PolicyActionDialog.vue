<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

import type { ResourceMutationResponse } from "@birdbox/contracts/api";
import type {
  AddressFamily,
  PolicyFunction,
} from "@birdbox/contracts/inventory";

import {
  setDashboardSnapshot,
  useDashboardStore,
} from "../dashboard/dashboard-store";
import { api } from "../shared/api-client";
import { dispatchToast } from "../shared/events";
import { uniqueBirdName } from "../shared/resource-names";

type Direction = "import" | "export";
type ActionType = "local_pref" | "prepend" | "community";

const props = defineProps<{
  localAsn: number | null;
  nodeId?: string | null;
}>();
const emit = defineEmits<{ saved: [resource: PolicyFunction] }>();
const { dashboard } = useDashboardStore();
const dialog = ref<HTMLDialogElement | null>(null);
const form = ref<HTMLFormElement | null>(null);
const family = ref<AddressFamily>("ipv4");
const direction = ref<Direction>("import");
const name = ref("");
const label = ref("");
const condition = ref("");
const action = ref<ActionType>("local_pref");
const localPref = ref<number | null>(null);
const prependMode = ref<"local" | "custom">("local");
const prependAsn = ref<number | null>(null);
const prependCount = ref(1);
const communityOperation = ref<"add" | "delete" | "empty">("add");
const communityKind = ref<"standard" | "large">("standard");
const communityValues = ref("");
const pending = ref(false);
const errorMessage = ref("");

const availableDefines = computed(() => {
  const value = dashboard.value;
  const nodeId = props.nodeId ?? value?.node?.id;
  if (!value || !nodeId) return [];
  const type = family.value === "ipv4" ? "cidr4" : "cidr6";
  return value.inventory.defines.filter(
    (resource) =>
      resource.type === type &&
      resource.enabled &&
      (resource.nodeId === null || resource.nodeId === nodeId),
  );
});

const actionOptions = computed<Array<{ value: ActionType; label: string }>>(
  () =>
    direction.value === "import"
      ? [
          { value: "local_pref", label: "设置 Local Preference" },
          { value: "community", label: "修改 Community" },
        ]
      : [
          { value: "prepend", label: "AS Path Prepend" },
          { value: "community", label: "修改 Community" },
        ],
);

function defaultLabel(): string {
  if (action.value === "local_pref") return "设置 Local Preference";
  if (action.value === "prepend") return "AS Path Prepend";
  return `${direction.value === "import" ? "导入" : "导出"} Community 操作`;
}

function syncGeneratedName(): void {
  if (!dashboard.value) return;
  name.value = uniqueBirdName(
    dashboard.value.inventory,
    "fn",
    label.value || defaultLabel(),
  );
}

function reset(nextFamily: AddressFamily, nextDirection: Direction): void {
  family.value = nextFamily;
  direction.value = nextDirection;
  action.value = nextDirection === "import" ? "local_pref" : "prepend";
  label.value = defaultLabel();
  condition.value = "";
  localPref.value = null;
  prependMode.value = "local";
  prependAsn.value = null;
  prependCount.value = 1;
  communityOperation.value = "add";
  communityKind.value = "standard";
  communityValues.value = "";
  errorMessage.value = "";
  syncGeneratedName();
}

function open(nextFamily: AddressFamily, nextDirection: Direction): void {
  reset(nextFamily, nextDirection);
  dialog.value?.showModal();
  void nextTick(() =>
    form.value
      ?.querySelector<HTMLInputElement>("input:not([type=hidden])")
      ?.focus(),
  );
}

function close(): void {
  if (!pending.value) dialog.value?.close();
}

function insertDefine(symbol: string): void {
  if (symbol) condition.value = `net ~ ${symbol}`;
}

function parseCommunities(): string[] {
  const values = communityValues.value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!values.length) throw new Error("至少填写一个 Community");
  const large = communityKind.value === "large";
  const max = large ? 4294967295 : 65535;
  const expected = large ? 3 : 2;
  return values.map((value) => {
    const parts = value.split(":").map(Number);
    if (
      parts.length !== expected ||
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > max)
    ) {
      throw new Error(
        `${large ? "Large" : "Standard"} Community 格式不合法: ${value}`,
      );
    }
    return `(${parts.join(", ")})`;
  });
}

function buildSource(): string {
  const normalizedCondition = condition.value.trim().replace(/\s+/g, " ");
  if (!normalizedCondition) throw new Error("筛选表达式不能为空");
  const statements: string[] = [];
  if (action.value === "local_pref") {
    if (
      localPref.value === null ||
      !Number.isSafeInteger(localPref.value) ||
      localPref.value < 0 ||
      localPref.value > 4294967295
    ) {
      throw new Error("Local Preference 必须为 0 到 4294967295 的整数");
    }
    statements.push(`bgp_local_pref = ${localPref.value};`);
  } else if (action.value === "prepend") {
    const asn =
      prependMode.value === "local" ? props.localAsn : prependAsn.value;
    if (
      asn === null ||
      !Number.isSafeInteger(asn) ||
      asn < 1 ||
      asn > 4294967295
    )
      throw new Error("prepend ASN 不合法");
    if (
      !Number.isSafeInteger(prependCount.value) ||
      prependCount.value < 1 ||
      prependCount.value > 20
    )
      throw new Error("prepend 次数必须为 1 到 20 的整数");
    for (let index = 0; index < prependCount.value; index += 1)
      statements.push(`bgp_path.prepend(${asn});`);
  } else {
    const attribute =
      communityKind.value === "large" ? "bgp_large_community" : "bgp_community";
    if (communityOperation.value === "empty")
      statements.push(`${attribute}.empty;`);
    else
      for (const value of parseCommunities())
        statements.push(`${attribute}.${communityOperation.value}(${value});`);
  }
  return `function ${name.value}()\n{\n  if ${normalizedCondition} then {\n${statements.map((statement) => `    ${statement}`).join("\n")}\n  }\n}`;
}

async function save(): Promise<void> {
  if (pending.value || !form.value?.reportValidity()) return;
  const current = dashboard.value;
  const nodeId = props.nodeId ?? current?.node?.id;
  if (!current || !nodeId) return;
  pending.value = true;
  errorMessage.value = "";
  try {
    const result = await api<ResourceMutationResponse<PolicyFunction>>(
      "/api/functions",
      {
        method: "POST",
        body: JSON.stringify({
          nodeId,
          label: label.value,
          name: name.value,
          source: buildSource(),
          enabled: true,
        }),
      },
    );
    const visibleFunctions = result.inventory.functions.filter(
      (resource) =>
        resource.enabled &&
        (resource.nodeId === null || resource.nodeId === nodeId),
    );
    setDashboardSnapshot({
      ...current,
      inventory: result.inventory,
      functions: visibleFunctions,
      events: result.events,
    });
    emit("saved", result.resource);
    dialog.value?.close();
    dispatchToast(`已生成 Function ${result.resource.name}`, "success");
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : "生成 Function 失败";
  } finally {
    pending.value = false;
  }
}

defineExpose({ open });
</script>

<template>
  <dialog
    ref="dialog"
    class="editor-dialog policy-action-dialog"
    @cancel.prevent="close"
  >
    <form ref="form" @submit.prevent="save">
      <div class="dialog-head">
        <span class="dialog-icon">F</span>
        <div>
          <p class="eyebrow">POLICY ACTION</p>
          <h2>生成策略属性动作</h2>
        </div>
      </div>
      <div class="dialog-grid">
        <div class="field full-width">
          <label>显示名称 / 备注</label
          ><input
            v-model="label"
            maxlength="80"
            required
            @input="syncGeneratedName"
          />
        </div>
        <div class="field full-width">
          <label>BIRD Function 名称</label
          ><input
            v-model="name"
            pattern="[A-Za-z_][A-Za-z0-9_]*"
            maxlength="64"
            required
          />
        </div>
        <div class="field full-width">
          <label>筛选表达式</label
          ><textarea
            v-model="condition"
            class="compact-code-editor policy-action-condition"
            spellcheck="false"
            required
            placeholder="net ~ CUSTOMER_ROUTES"
          ></textarea
          ><small class="field-help"
            >填写 BIRD 表达式本身，不需要写 if 或 then。</small
          >
        </div>
        <div class="field full-width">
          <label>快速插入 CIDR Define</label
          ><select
            @change="
              insertDefine(($event.currentTarget as HTMLSelectElement).value)
            "
          >
            <option value="">不选择</option>
            <option
              v-for="resource in availableDefines"
              :key="resource.id"
              :value="resource.name"
            >
              {{ resource.name
              }}{{ resource.nodeId === null ? " · 所有节点" : "" }}
            </option>
          </select>
        </div>
        <div class="field full-width">
          <label>属性动作</label
          ><select
            v-model="action"
            @change="
              label = defaultLabel();
              syncGeneratedName();
            "
          >
            <option
              v-for="option in actionOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>
        <div v-if="action === 'local_pref'" class="field full-width">
          <label>Local Preference</label
          ><input
            v-model.number="localPref"
            type="number"
            min="0"
            max="4294967295"
            required
            placeholder="例如 200"
          />
        </div>
        <template v-if="action === 'prepend'">
          <div class="field">
            <label>prepend ASN</label
            ><select v-model="prependMode">
              <option value="local">本地 ASN</option>
              <option value="custom">自定义 ASN</option>
            </select>
          </div>
          <div class="field">
            <label>自定义 ASN</label
            ><input
              v-model.number="prependAsn"
              type="number"
              min="1"
              max="4294967295"
              :disabled="prependMode !== 'custom'"
              :required="prependMode === 'custom'"
            />
          </div>
          <div class="field">
            <label>次数</label
            ><input
              v-model.number="prependCount"
              type="number"
              min="1"
              max="20"
              required
            />
          </div>
        </template>
        <template v-if="action === 'community'">
          <div class="field">
            <label>Community 操作</label
            ><select v-model="communityOperation">
              <option value="add">添加</option>
              <option value="delete">删除指定值</option>
              <option value="empty">删除全部</option>
            </select>
          </div>
          <div class="field">
            <label>Community 类型</label
            ><select
              v-model="communityKind"
              :disabled="communityOperation === 'empty'"
            >
              <option value="standard">Standard</option>
              <option value="large">Large</option>
            </select>
          </div>
          <div class="field full-width">
            <label>Community 值</label
            ><textarea
              v-model="communityValues"
              class="compact-code-editor"
              spellcheck="false"
              :disabled="communityOperation === 'empty'"
              :required="communityOperation !== 'empty'"
              placeholder="65001:100&#10;65001:200"
            ></textarea>
          </div>
        </template>
        <p class="auth-error full-width" role="alert" :hidden="!errorMessage">
          {{ errorMessage }}
        </p>
      </div>
      <div class="dialog-actions">
        <button
          class="secondary-button"
          type="button"
          :disabled="pending"
          @click="close"
        >
          取消</button
        ><button class="primary-button" type="submit" :disabled="pending">
          {{ pending ? "正在生成" : "生成、预检并加入策略" }}
        </button>
      </div>
    </form>
  </dialog>
</template>
