<script setup lang="ts">
import { computed, ref } from "vue";

import type { ManagedNode } from "@birdbox/contracts/inventory";

const props = withDefaults(defineProps<{
  id: string;
  nodes: ManagedNode[];
  invalid?: boolean;
}>(), { invalid: false });
const emit = defineEmits<{ change: [] }>();
const model = defineModel<string[] | null>({ required: true });
const search = ref("");

const allNodes = computed(() => model.value === null);
const selectedNodeIds = computed({
  get: () => model.value ?? [],
  set: (value: string[]) => {
    model.value = value;
    emit("change");
  },
});
const visibleNodes = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return query
    ? props.nodes.filter((node) => `${node.name} ${node.id}`.toLocaleLowerCase().includes(query))
    : props.nodes;
});

function setMode(mode: "all" | "selected"): void {
  model.value = mode === "all" ? null : (model.value ?? []);
  emit("change");
}

function setAllNodes(selected: boolean): void {
  model.value = selected ? props.nodes.map((node) => node.id) : [];
  emit("change");
}
</script>

<template>
  <div :id="id" class="field full-width policy-scope-field" :class="{ 'field-invalid': invalid }" :aria-invalid="invalid ? 'true' : undefined" tabindex="-1">
    <div class="policy-scope-heading"><span class="field-label">可用范围</span><span>{{ allNodes ? "所有节点" : `已选择 ${selectedNodeIds.length} 个节点` }}</span></div>
    <div class="segmented-control" role="radiogroup" aria-label="资源可用范围"><label><input type="radio" :name="`${id}Mode`" value="all" :checked="allNodes" @change="setMode('all')"><span>所有节点</span></label><label><input type="radio" :name="`${id}Mode`" value="selected" :checked="!allNodes" @change="setMode('selected')"><span>指定节点</span></label></div>
    <div v-if="!allNodes" class="policy-scope-selector">
      <div class="policy-scope-toolbar"><input :id="`${id}Search`" v-model.trim="search" type="search" autocomplete="off" placeholder="搜索节点"><span><button class="compact-command" type="button" @click="setAllNodes(true)">全选</button><button class="compact-command" type="button" @click="setAllNodes(false)">清空</button></span></div>
      <div class="policy-scope-node-list">
        <label v-for="node in visibleNodes" :key="node.id" class="policy-scope-node"><input v-model="selectedNodeIds" type="checkbox" :value="node.id"><span><strong>{{ node.name }}</strong><code>{{ node.id }}</code></span></label>
        <span v-if="!visibleNodes.length" class="code-reference-empty">没有匹配的节点</span>
      </div>
      <p v-if="invalid" class="field-error" role="alert">请至少选择一个节点</p>
    </div>
  </div>
</template>
