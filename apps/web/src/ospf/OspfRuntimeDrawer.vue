<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

export interface RuntimeNeighbor {
  version: "ospfv2" | "ospfv3";
  routerId: string;
  state: string;
  interface: string;
  address: string;
  deadTime: number | null;
}
export interface RuntimeRoute {
  version: "ospfv2" | "ospfv3";
  prefix: string;
  summary: string;
  details: string;
}
export interface RuntimeArea {
  area: string;
  links: Array<{ id: string; localInterface: string; remoteInterface: string; cost: number; hello: number; dead: number; options?: { type?: string } }>;
  options: { stub?: boolean; nssa?: boolean; networks?: unknown[]; external?: unknown[]; stubnets?: unknown[] };
}

const props = defineProps<{
  open: boolean;
  kind: "neighbors" | "routes" | "areas" | null;
  nodeName: string;
  routerId: string;
  neighbors: RuntimeNeighbor[];
  routes: RuntimeRoute[];
  routesTruncated: boolean;
  neighborCount: number;
  routeCount: number;
  neighborDetailsUnavailable: boolean;
  routeDetailsUnavailable: boolean;
  areas: RuntimeArea[];
  error?: string | null;
}>();
const emit = defineEmits<{ close: []; "select-node": [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const title = () => props.kind === "neighbors" ? "OSPF 邻居详情" : props.kind === "routes" ? "OSPF 路由详情" : "OSPF Area 详情";
function close(): void { emit("close"); }
watch(() => props.open, async (open) => {
  await nextTick();
  if (open && dialog.value && !dialog.value.open) dialog.value.showModal();
  if (!open && dialog.value?.open) dialog.value.close();
});
</script>

<template>
  <dialog ref="dialog" class="route-dialog ospf-runtime-dialog" aria-labelledby="ospfRuntimeDialogTitle" @cancel.prevent="close" @close="close">
    <div class="route-dialog-shell">
      <header class="route-dialog-head">
        <div><p class="eyebrow">OSPF RUNTIME</p><h2 id="ospfRuntimeDialogTitle">{{ title() }}</h2><span>{{ nodeName }} · {{ routerId }}</span></div>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭 OSPF 运行详情" @click="close">×</button>
      </header>
      <div v-if="error" class="ospf-runtime-drawer-error" role="alert">
        <span>{{ error }}</span>
        <button class="secondary-button compact-button" type="button" @click="emit('select-node')">跳转到节点配置</button>
      </div>
      <div v-if="kind === 'neighbors'" class="ospf-runtime-detail-body">
        <div v-if="neighbors.length === 0" class="route-dialog-state">{{ neighborDetailsUnavailable ? `运行状态显示 ${neighborCount} 个邻居，但当前实例未返回明细，请刷新服务后重试` : "当前没有邻居信息" }}</div>
        <div v-else class="ospf-runtime-table-wrap"><table class="ospf-runtime-table"><thead><tr><th>协议</th><th>Router ID</th><th>状态</th><th>接口</th><th>邻居地址</th><th>Dead</th></tr></thead><tbody><tr v-for="(neighbor, index) in neighbors" :key="`${neighbor.version}-${neighbor.routerId}-${neighbor.address}-${index}`"><td>{{ neighbor.version === 'ospfv2' ? 'OSPFv2' : 'OSPFv3' }}</td><td>{{ neighbor.routerId }}</td><td><span :class="neighbor.state.toLowerCase().startsWith('full') ? 'runtime-state-up' : 'runtime-state-warn'">{{ neighbor.state }}</span></td><td>{{ neighbor.interface }}</td><td>{{ neighbor.address }}</td><td>{{ neighbor.deadTime ?? '-' }}</td></tr></tbody></table></div>
      </div>
      <div v-else-if="kind === 'routes'" class="ospf-runtime-detail-body">
        <div v-if="routes.length === 0" class="route-dialog-state">{{ routeDetailsUnavailable ? `运行状态显示 ${routeCount} 条 OSPF 路由，但当前实例未返回明细，请刷新服务后重试` : "当前没有已导入的 OSPF 路由" }}</div>
        <div v-else class="ospf-runtime-route-list"><article v-for="(route, index) in routes" :key="`${route.version}-${route.prefix}-${index}`"><header><strong>{{ route.prefix }}</strong><span>{{ route.version === 'ospfv2' ? 'OSPFv2 / IPv4' : 'OSPFv3 / IPv6' }}</span></header><p>{{ route.summary }}</p><pre v-if="route.details">{{ route.details }}</pre></article><p v-if="routesTruncated" class="field-hint">路由数量较多，仅显示前 200 条。</p></div>
      </div>
      <div v-else class="ospf-runtime-detail-body"><div v-if="areas.length === 0" class="route-dialog-state">当前节点未配置 Area</div><div v-else class="ospf-area-detail-list"><article v-for="item in areas" :key="item.area"><header><strong>Area {{ item.area }}</strong><span>{{ item.links.length }} 条链路</span></header><div v-for="link in item.links" :key="link.id" class="ospf-area-detail-link"><span>{{ link.localInterface }} ↔ {{ link.remoteInterface }}</span><span>Cost {{ link.cost }} · Hello {{ link.hello }} · Dead {{ link.dead }}</span><span>类型：{{ link.options?.type ?? 'ptp' }}</span></div><p v-if="item.options.stub || item.options.nssa || item.options.networks?.length || item.options.external?.length || item.options.stubnets?.length" class="field-hint">{{ item.options.stub ? 'Stub ' : '' }}{{ item.options.nssa ? 'NSSA ' : '' }}{{ item.options.networks?.length ? `Networks ${item.options.networks.length} ` : '' }}{{ item.options.external?.length ? `External ${item.options.external.length} ` : '' }}{{ item.options.stubnets?.length ? `Stubnet ${item.options.stubnets.length}` : '' }}</p></article></div></div>
    </div>
  </dialog>
</template>
