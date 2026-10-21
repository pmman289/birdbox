<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AddressFamily, StaticRoute, StaticRouteFilterOperation, StaticRouteForwarding } from "@birdbox/contracts/inventory";
import { cloneReactive } from "../shared/clone-reactive";
import { routeForwarding } from "../shared/static-route-sources";
import StaticRouteOperationRow from "./StaticRouteOperationRow.vue";
const props = defineProps<{
  modelValue: StaticRoute[]; family: AddressFamily; origins?: Record<string, string>;
  references?: Array<{ id: string; label: string; symbol: string; insertion: string; kind: string }>;
}>();
const emit = defineEmits<{ 'update:modelValue': [routes: StaticRoute[]]; 'apply-forwarding': [value: StaticRouteForwarding] }>();
const activeRouteId = ref<string | null>(null);
const referenceSearch = ref("");
const filteredReferences = computed(() => (props.references ?? []).filter(item => `${item.label} ${item.symbol}`.toLocaleLowerCase().includes(referenceSearch.value.toLocaleLowerCase())));
const currentRoute = computed(() => props.modelValue.find(route => route.id === activeRouteId.value) ?? props.modelValue[0]);
function applyForwarding() {
  if (!currentRoute.value || !window.confirm("将当前条目的转发配置应用到当前全部条目？各条目的启停与路由属性保持原样。")) return;
  const forwarding = routeForwarding(currentRoute.value);
  emit('update:modelValue', props.modelValue.map(route => ({ ...route, ...cloneReactive(forwarding), enabled: route.enabled })));
  emit('apply-forwarding', forwarding);
}
function copyAttributes() {
  if (!currentRoute.value || !window.confirm("用当前条目的路由属性覆盖当前全部条目的属性？")) return;
  const filter = cloneReactive(currentRoute.value.filter);
  emit('update:modelValue', props.modelValue.map(route => ({ ...route, filter: cloneReactive(filter) })));
}
function clearAttributes() {
  if (!window.confirm("清空当前全部条目的路由属性与自定义源码？")) return;
  emit('update:modelValue', props.modelValue.map(route => ({ ...route, filter: { operations: [], custom: '' } })));
}
function insertReference(route: StaticRoute, insertion: string) {
  const textarea = document.getElementById(`staticRouteCustom_${route.id}`) as HTMLTextAreaElement | null;
  if (!textarea) return;
  textarea.setRangeText(insertion, textarea.selectionStart, textarea.selectionEnd, 'end');
  route.filter.custom = textarea.value; textarea.focus();
}
watch(() => props.modelValue.map(route => route.id), (ids, previous = []) => {
  const added = ids.find(id => !previous.includes(id));
  if (added) activeRouteId.value = added;
  else if (!ids.includes(activeRouteId.value ?? '')) activeRouteId.value = ids[0] ?? null;
}, { immediate: true });
function toggle(event: Event, id: string) {
  if ((event.target as HTMLDetailsElement).open) activeRouteId.value = id;
  else if (activeRouteId.value === id) activeRouteId.value = null;
}
function routeSummary(route: StaticRoute): string {
  if (route.type === 'recursive') return `递归 · ${route.recursiveVia || '待填写地址'}`;
  if (route.type !== 'via') return route.type;
  if (route.nextHops.length > 1) return `ECMP · ${route.nextHops.length} 个下一跳`;
  return route.nextHops[0]?.address || route.nextHops[0]?.interface || '待填写下一跳';
}
const nextHop = () => ({ address: "", interface: "", weight: 1, bfd: false, onlink: false });
function add() {
  const id = `route_${Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, "0")).join("")}`;
  emit('update:modelValue', [...props.modelValue, { id, prefix: "", type: "via", nextHops: [nextHop()], recursiveVia: "", filter: { operations: [], custom: "" }, enabled: true }]);
}
function changeType(route: StaticRoute) { if (route.type === 'via' && !route.nextHops.length) route.nextHops.push(nextHop()); }
function operation(route: StaticRoute, type: StaticRouteFilterOperation['type']) {
  route.filter.operations.push(type === 'set' ? { type, attribute: 'preference', value: 200 } : type === 'community' ? { type, list: 'standard', operation: 'add', value: [65000, 100] } : { type, asn: 65000, count: 1 });
}
function move(route: StaticRoute, index: number, direction: 'up' | 'down') {
  const target = index + (direction === 'up' ? -1 : 1); if (target < 0 || target >= route.filter.operations.length) return;
  [route.filter.operations[index], route.filter.operations[target]] = [route.filter.operations[target]!, route.filter.operations[index]!];
}
</script>
<template>
  <section class="static-direct-routes" aria-label="静态路由条目">
    <div class="static-section-heading"><div><h3>路由条目 <span class="protocol-count">{{ modelValue.length }}</span></h3><p>相同前缀可使用 Preference 区分主备。</p></div><button id="addStaticRouteButton" type="button" class="secondary-button" @click="add">添加路由</button></div>
    <p v-if="!modelValue.length" class="static-empty">还没有路由。点击“添加路由”，或在上方关联 CIDR Define。</p>
    <details v-if="modelValue.length" class="static-batch-actions protocol-disclosure"><summary>批量操作 · 当前 {{ modelValue.length }} 条路由</summary><p class="protocol-help">以当前展开条目 {{ currentRoute?.prefix || '（待填写）' }} 为模板。转发配置包含 ECMP、递归、接口及 BFD；批量设置后，Define 后续新增网段沿用此转发配置。</p><div class="static-operation-actions"><button id="applyStaticBulkActionButton" type="button" class="secondary-button compact-command" @click="applyForwarding">统一转发配置</button><button id="copyStaticRouteBlockButton" type="button" class="secondary-button compact-command" @click="copyAttributes">复制当前属性到全部</button><button id="clearStaticRouteBlocksButton" type="button" class="text-danger-button" @click="clearAttributes">清空全部属性</button></div></details>
    <article v-for="(route, index) in modelValue" :key="route.id" class="static-route-card" :data-testid="origins?.[route.id] ? 'static-define-route' : 'static-direct-route'" :data-static-route-id="route.id">
      <details class="static-route-entry" :open="activeRouteId === route.id" @toggle="toggle($event, route.id)">
        <summary class="static-route-summary"><span class="static-route-index">{{ index + 1 }}</span><span class="static-route-summary-copy"><strong>{{ route.prefix || '新路由 · 填写目标网段' }}</strong><small>{{ origins?.[route.id] ? `Define · ${origins[route.id]}` : '直接添加' }} · {{ routeSummary(route) }}</small></span><span class="protocol-count">{{ route.enabled ? '启用' : '停用' }}</span></summary>
        <div class="static-route-body">
      <div class="static-section-heading"><strong>编辑路由 {{ index + 1 }}</strong><button v-if="origins?.[route.id]" type="button" class="secondary-button compact-command" @click="route.enabled = !route.enabled">{{ route.enabled ? '停用此路由' : '启用此路由' }}</button><button v-else type="button" class="text-danger-button" :aria-label="`删除路由 ${index + 1}`" @click="emit('update:modelValue', modelValue.filter(item => item.id !== route.id))">删除路由</button></div>
      <div class="static-input-grid"><label>目标网段<input v-model.trim="route.prefix" :readonly="Boolean(origins?.[route.id])" aria-label="目标网段" :placeholder="family === 'ipv4' ? '192.0.2.0/24' : '2001:db8::/48'" required></label><label>转发方式<select v-model="route.type" aria-label="转发方式" @change="changeType(route)"><option value="via">通过下一跳 / 接口</option><option value="recursive">递归下一跳</option><option value="blackhole">丢弃（blackhole）</option><option value="unreachable">返回不可达（unreachable）</option><option value="prohibit">禁止访问（prohibit）</option></select></label></div>
      <p v-if="origins?.[route.id]" class="protocol-help">网段由 {{ origins[route.id] }} 维护。可在资源管理中修改 Define，或在这里单独停用此路由。</p>
      <template v-if="route.type === 'via'">
        <section v-for="(hop, hopIndex) in route.nextHops" :key="hopIndex" class="static-next-hop">
          <div class="static-section-heading"><strong>下一跳 {{ hopIndex + 1 }}</strong><button v-if="route.nextHops.length > 1" type="button" class="text-danger-button" :aria-label="`删除下一跳 ${hopIndex + 1}`" @click="route.nextHops.splice(hopIndex, 1)">删除下一跳</button></div>
          <div class="static-input-grid"><label>下一跳地址<input v-model.trim="hop.address" aria-label="下一跳地址" :placeholder="family === 'ipv4' ? '192.0.2.1（仅接口路由可留空）' : 'fe80::1（需指定接口）'"></label><label>出口接口（可选）<input v-model.trim="hop.interface" aria-label="出口接口" placeholder="例如 eth0；仅接口路由可不填地址"></label></div>
          <details class="protocol-inline-disclosure"><summary>下一跳高级选项</summary><div class="static-input-grid"><label>权重<input v-model.number="hop.weight" aria-label="下一跳权重" type="number" min="1" max="256" required></label><label class="protocol-checkbox"><input v-model="hop.bfd" type="checkbox" :disabled="hop.onlink">使用 BFD 检测下一跳</label><label class="protocol-checkbox"><input v-model="hop.onlink" type="checkbox" :disabled="hop.bfd">Onlink（需要地址和接口）</label></div><small>BFD 会话建立后才发布此下一跳；多下一跳路由仅撤销失效的下一跳。</small></details>
        </section>
        <button type="button" class="secondary-button" @click="route.nextHops.push(nextHop())">添加下一跳（ECMP）</button>
      </template>
      <label v-if="route.type === 'recursive'">递归下一跳地址<input v-model.trim="route.recursiveVia" aria-label="递归下一跳地址" required></label>
      <details class="static-route-attributes protocol-inline-disclosure"><summary>路由属性与高级设置 · {{ route.filter.operations.length }} 项操作</summary>
        <label class="protocol-checkbox"><input v-model="route.enabled" type="checkbox">启用此路由</label>
        <div class="static-operation-actions"><button type="button" class="secondary-button compact-command" @click="operation(route, 'set')">设置属性</button><button type="button" class="secondary-button compact-command" @click="operation(route, 'community')">添加 Community 操作</button><button type="button" class="secondary-button compact-command" @click="operation(route, 'prepend')">添加 AS prepend</button></div>
        <StaticRouteOperationRow v-for="(item, i) in route.filter.operations" :key="i" :operation="item" :index="i" :total="route.filter.operations.length" @update="route.filter.operations[i] = $event" @remove="route.filter.operations.splice(i, 1)" @move="move(route, i, $event)" @apply-all="modelValue.forEach(other => { if (other.id !== route.id) other.filter.operations.push(cloneReactive(item)); })" />
        <label>自定义 per-route 源码<textarea :id="`staticRouteCustom_${route.id}`" v-model="route.filter.custom" class="compact-code-editor" spellcheck="false" placeholder="ospf_metric1 = 100;" /></label>
        <details v-if="references?.length" class="static-route-references protocol-inline-disclosure"><summary>插入 Define / Function 引用</summary><input v-model="referenceSearch" type="search" aria-label="搜索路由可用资源" placeholder="搜索 Define / Function"><div class="static-reference-list"><button v-for="item in filteredReferences" :key="item.id" type="button" class="secondary-button compact-command" @click="insertReference(route, item.insertion)">{{ item.label }} · {{ item.symbol }}</button><p v-if="!filteredReferences.length" class="protocol-help">没有匹配的资源</p></div></details>
      </details>
        </div>
      </details>
    </article>
  </section>
</template>
<style scoped>
.static-direct-routes { min-width: 0; margin-top: 20px; }
.static-section-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.static-section-heading h3 { margin: 0; font-size: 13px; }
.static-section-heading p, .static-empty { color: var(--muted); font-size: 12px; line-height: 1.6; }
.static-batch-actions { margin-top: 14px; }
.static-reference-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.static-route-references > input { margin-top: 10px; }
.static-route-card { min-width: 0; border: 1px solid var(--line); border-radius: 6px; margin-top: 10px; overflow: clip; }
.static-route-entry > summary { display: flex; align-items: center; gap: 12px; list-style: none; padding: 12px 14px; background: var(--surface-soft); }
.static-route-entry > summary::-webkit-details-marker { display: none; }
.static-route-entry > summary::after { content: '⌄'; color: var(--muted); }
.static-route-entry[open] > summary::after { transform: rotate(180deg); }
.static-route-entry[open] > summary { border-bottom: 1px solid var(--line); }
.static-route-summary-copy { min-width: 0; flex: 1; display: grid; gap: 4px; }
.static-route-summary-copy strong { font: 650 12px/1.5 ui-monospace, monospace; overflow-wrap: anywhere; }
.static-route-summary-copy small { font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.static-route-index { color: var(--muted); font: 11px ui-monospace, monospace; }
.static-route-body { padding: 16px; }
.static-input-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 14px 0; }
label:not(.protocol-checkbox) { display: grid; gap: 6px; min-width: 0; color: var(--ink-soft); font-size: 12px; font-weight: 650; }
.static-next-hop { border-top: 1px solid var(--line); padding: 16px 0 4px; margin-top: 14px; }
.static-next-hop strong { font-size: 12px; }
.static-route-body > label { margin-top: 14px; }
.static-operation-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0; }
.static-route-attributes { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); }
.static-route-attributes > .protocol-checkbox { margin-top: 14px; }
.static-route-attributes > label:not(.protocol-checkbox) { margin-top: 16px; }
.static-next-hop small { display: block; color: var(--muted); font-size: 11px; line-height: 1.6; margin-top: 8px; }
@media (max-width: 600px) {
  .static-input-grid { grid-template-columns: minmax(0, 1fr); }
  .static-route-body { padding: 12px; }
  .static-route-entry > summary { padding: 12px; gap: 8px; }
}
</style>
