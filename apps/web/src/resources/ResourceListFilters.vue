<script setup lang="ts">
import type { ManagedNode } from '@birdbox/contracts/inventory';
import type { ResourceWorkspaceTarget } from '../shared/events';
import { activeResourceFilters, familyResourceKinds, GLOBAL_SCOPE, resourceTypeOptions, scopedResourceKinds, type ResourceListQuery } from '../shared/resource-list';
const props = defineProps<{ kind: ResourceWorkspaceTarget; nodes: ManagedNode[] }>();
const query = defineModel<ResourceListQuery>({ required: true });
const emit = defineEmits<{ reset: [] }>();
</script>

<template>
  <form class="resource-list-filters" role="search" aria-label="资源筛选" @submit.prevent>
    <label class="resource-search-field" for="resourceKeyword">关键词
      <span class="resource-search-input"><span aria-hidden="true">⌕</span><input id="resourceKeyword" v-model="query.keyword" type="search" autocomplete="off" placeholder="搜索名称、标识、地址或路由表"></span>
    </label>
    <label v-if="kind !== 'nodes'" for="resourceNodeFilter">节点范围
      <select id="resourceNodeFilter" v-model="query.nodeId"><option value="">全部节点</option><option v-if="scopedResourceKinds.has(kind)" :value="GLOBAL_SCOPE">仅全局资源</option><option v-for="node in props.nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select>
    </label>
    <label v-if="kind !== 'peers'" for="resourceStatusFilter">{{ kind === 'nodes' ? '连接状态' : '配置状态' }}
      <select id="resourceStatusFilter" v-model="query.status"><option value="">全部状态</option><template v-if="kind === 'nodes'"><option value="online">在线</option><option value="offline">离线</option><option value="unknown">未检查</option></template><template v-else><option value="enabled">已启用</option><option value="disabled">已停用</option></template></select>
    </label>
    <label v-if="familyResourceKinds.has(kind)" for="resourceFamilyFilter">地址族
      <select id="resourceFamilyFilter" v-model="query.family"><option value="">全部地址族</option><option value="ipv4">IPv4</option><option value="ipv6">IPv6</option><option v-if="['directs', 'kernels', 'rpki'].includes(kind)" value="dual">双栈</option></select>
    </label>
    <label v-if="resourceTypeOptions[kind]" for="resourceTypeFilter">{{ resourceTypeOptions[kind]!.label }}
      <select id="resourceTypeFilter" v-model="query.type"><option value="">全部类型</option><option v-for="option in resourceTypeOptions[kind]!.options" :key="option.value" :value="option.value">{{ option.label }}</option></select>
    </label>
    <button class="secondary-button resource-filter-reset" type="button" :disabled="!activeResourceFilters(query) && query.sort === 'inventory'" @click="emit('reset')">重置筛选</button>
  </form>
</template>
