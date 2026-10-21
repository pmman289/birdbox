<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RESOURCE_PAGE_SIZES, resourcePageButtons } from '../shared/resource-list';
const props = defineProps<{ page: number; pageSize: number; pageCount: number; total: number; start: number; end: number }>();
const emit = defineEmits<{ page: [value: number]; size: [value: number] }>();
const jump = ref(props.page);
watch(() => [props.page, props.pageCount], () => { jump.value = props.page; });
const buttons = computed(() => resourcePageButtons(props.page, props.pageCount));
function go() { emit('page', Math.min(props.pageCount, Math.max(1, Math.trunc(Number(jump.value)) || 1))); }
</script>

<template>
  <footer class="resource-pagination" aria-label="资源列表分页">
    <div class="resource-page-summary"><span role="status" aria-live="polite">共 {{ total }} 项<span v-if="total">，当前 {{ start }}–{{ end }} 项</span></span><label for="resourcePageSize">每页<select id="resourcePageSize" :value="pageSize" @change="emit('size', Number(($event.target as HTMLSelectElement).value))"><option v-for="size in RESOURCE_PAGE_SIZES" :key="size" :value="size">{{ size }} 条</option></select></label></div>
    <div class="resource-page-controls">
      <nav class="resource-page-buttons" aria-label="页码"><button type="button" class="secondary-button" aria-label="上一页" :disabled="page <= 1" @click="emit('page', page - 1)">‹</button><template v-for="button in buttons" :key="button"><button v-if="typeof button === 'number'" type="button" class="secondary-button" :class="{ active: page === button }" :aria-label="`第 ${button} 页`" :aria-current="page === button ? 'page' : undefined" @click="emit('page', button)">{{ button }}</button><span v-else class="resource-page-gap" aria-hidden="true">…</span></template><button type="button" class="secondary-button" aria-label="下一页" :disabled="page >= pageCount" @click="emit('page', page + 1)">›</button></nav>
      <form class="resource-page-jump" @submit.prevent="go"><label for="resourcePageJump">跳至</label><input id="resourcePageJump" v-model="jump" type="number" inputmode="numeric" min="1" :max="pageCount" required :aria-label="`跳转页码，共 ${pageCount} 页`"><span>/ {{ pageCount }} 页</span><button type="submit" class="secondary-button">前往</button></form>
    </div>
  </footer>
</template>
