<script setup lang="ts">
import type { StaticRouteFilterOperation } from "@birdbox/contracts/inventory";

const props = defineProps<{ operation: StaticRouteFilterOperation; index: number; total: number }>();
const emit = defineEmits<{
  update: [operation: StaticRouteFilterOperation];
  remove: [];
  move: [direction: "up" | "down"];
  applyAll: [];
}>();

function defaultOperation(type: StaticRouteFilterOperation["type"]): StaticRouteFilterOperation {
  if (type === "community") return { type, list: "standard", operation: "add", value: [65000, 100] };
  if (type === "prepend") return { type, asn: 65000, count: 1 };
  return { type: "set", attribute: "preference", value: 100 };
}

function changeType(event: Event): void {
  const target = event.target as HTMLSelectElement;
  emit("update", defaultOperation(target.value as StaticRouteFilterOperation["type"]));
}

function changeSetAttribute(event: Event): void {
  if (props.operation.type !== "set") return;
  const attribute = (event.target as HTMLSelectElement).value;
  if (attribute === "bgp_origin") emit("update", { type: "set", attribute, value: "igp" });
  else emit("update", { type: "set", attribute: attribute as "preference" | "igp_metric" | "bgp_local_pref" | "bgp_med", value: 100 });
}

function updateSetValue(event: Event): void {
  if (props.operation.type !== "set") return;
  if (props.operation.attribute === "bgp_origin") {
    const value = (event.target as HTMLSelectElement).value as "igp" | "egp" | "incomplete";
    emit("update", { ...props.operation, value });
  } else {
    emit("update", { ...props.operation, value: (event.target as HTMLInputElement).valueAsNumber });
  }
}

function changeCommunityList(event: Event): void {
  if (props.operation.type !== "community") return;
  const list = (event.target as HTMLSelectElement).value as "standard" | "large";
  const value = list === "large" ? [65000, 1, 2] : [65000, 100];
  emit("update", props.operation.operation === "empty" ? { ...props.operation, list } : { ...props.operation, list, value });
}

function changeCommunityOperation(event: Event): void {
  if (props.operation.type !== "community") return;
  const operation = (event.target as HTMLSelectElement).value as "add" | "delete" | "empty";
  if (operation === "empty") emit("update", { type: "community", list: props.operation.list, operation });
  else emit("update", {
    type: "community",
    list: props.operation.list,
    operation,
    value: "value" in props.operation ? [...props.operation.value] : props.operation.list === "large" ? [65000, 1, 2] : [65000, 100],
  });
}

function updateCommunityPart(partIndex: number, event: Event): void {
  if (props.operation.type !== "community" || props.operation.operation === "empty") return;
  const value = [...props.operation.value];
  value[partIndex] = (event.target as HTMLInputElement).valueAsNumber;
  emit("update", { ...props.operation, value });
}

function updatePrepend(field: "asn" | "count", event: Event): void {
  if (props.operation.type !== "prepend") return;
  emit("update", { ...props.operation, [field]: (event.target as HTMLInputElement).valueAsNumber });
}
</script>

<template>
  <div class="static-filter-operation-row" :data-static-operation-index="index">
    <code class="static-filter-operation-index">{{ index + 1 }}</code>
    <select :value="operation.type" :aria-label="`第 ${index + 1} 项快捷操作`" @change="changeType">
      <option value="set">设置属性</option><option value="community">Community</option><option value="prepend">AS prepend</option>
    </select>
    <div class="static-filter-operation-fields">
      <template v-if="operation.type === 'set'">
        <select :value="operation.attribute" :aria-label="`第 ${index + 1} 项属性`" @change="changeSetAttribute">
          <option value="preference">Preference</option><option value="igp_metric">IGP Metric</option><option value="bgp_local_pref">BGP Local Pref</option><option value="bgp_med">BGP MED</option><option value="bgp_origin">BGP Origin</option>
        </select>
        <select v-if="operation.attribute === 'bgp_origin'" :value="operation.value" :aria-label="`第 ${index + 1} 项值`" @change="updateSetValue"><option value="igp">IGP</option><option value="egp">EGP</option><option value="incomplete">INCOMPLETE</option></select>
        <input v-else :value="operation.value" type="number" min="0" max="4294967295" required :aria-label="`第 ${index + 1} 项值`" @input="updateSetValue">
      </template>
      <template v-else-if="operation.type === 'community'">
        <select :value="operation.list" :aria-label="`第 ${index + 1} 项 Community 类型`" @change="changeCommunityList"><option value="standard">Standard</option><option value="large">Large</option></select>
        <select :value="operation.operation" :aria-label="`第 ${index + 1} 项 Community 动作`" @change="changeCommunityOperation"><option value="add">add</option><option value="delete">delete</option><option value="empty">empty</option></select>
        <template v-if="operation.operation !== 'empty'"><input v-for="(part, partIndex) in operation.value" :key="partIndex" :value="part" type="number" min="0" :max="operation.list === 'large' ? 4294967295 : 65535" required :aria-label="`第 ${index + 1} 项 Community 第 ${partIndex + 1} 段`" @input="updateCommunityPart(partIndex, $event)"></template>
      </template>
      <template v-else>
        <input :value="operation.asn" type="number" min="1" max="4294967295" required :aria-label="`第 ${index + 1} 项 ASN`" @input="updatePrepend('asn', $event)">
        <input :value="operation.count" type="number" min="1" max="20" required :aria-label="`第 ${index + 1} 项次数`" @input="updatePrepend('count', $event)">
      </template>
    </div>
    <div class="static-filter-operation-actions">
      <button type="button" class="compact-icon" title="应用到全部条目" :aria-label="`应用第 ${index + 1} 项到全部条目`" @click="emit('applyAll')">↳</button>
      <button type="button" class="compact-icon" title="上移" :aria-label="`上移第 ${index + 1} 项`" :disabled="index === 0" @click="emit('move', 'up')">↑</button>
      <button type="button" class="compact-icon" title="下移" :aria-label="`下移第 ${index + 1} 项`" :disabled="index === total - 1" @click="emit('move', 'down')">↓</button>
      <button type="button" class="compact-icon" title="删除" :aria-label="`删除第 ${index + 1} 项`" @click="emit('remove')">×</button>
    </div>
  </div>
</template>
