<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import type { OspfProtocolRuntime } from "@birdbox/contracts/api";

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
  protocols?: { v2?: OspfProtocolRuntime; v3?: OspfProtocolRuntime };
  error?: string | null;
}>();
const emit = defineEmits<{ close: []; "select-node": [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const protocolDetails = computed(() => ([{ label: "OSPFv2", data: props.protocols?.v2 }, { label: "OSPFv3", data: props.protocols?.v3 }]).filter(item => item.data));
const protocolState = { up: "运行中", down: "未运行", start: "启动中", disabled: "已停用", not_configured: "协议未加载", unknown: "未知", error: "检查失败" };
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
      <div v-if="protocolDetails.length" class="ospf-runtime-protocol-status" aria-label="OSPF 实际协议状态"><details v-for="protocol in protocolDetails" :key="protocol.label"><summary>{{ protocol.label }} 协议 · {{ protocolState[protocol.data!.state] }}</summary><p v-if="protocol.data?.error" class="field-error">{{ protocol.data.error }}</p><pre>{{ protocol.data?.raw || '没有可用协议详情' }}</pre></details></div>
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
      <div v-else class="ospf-runtime-detail-body">
        <section v-for="protocol in protocolDetails" :key="protocol.label" class="ospf-area-detail-list">
          <h3>{{ protocol.label }} · BIRD 实际 Area</h3>
          <p v-if="protocol.data?.error" role="alert">{{ protocol.data.error }}</p>
          <p v-else-if="protocol.data?.areaError" class="field-hint">{{ protocol.data.areaError }}</p>
          <p v-else-if="!protocol.data?.areas.length" class="field-hint">{{ protocol.data?.areasAvailable ? '实际 Area 数量为 0。' : 'BIRD 未提供 Area 统计，当前状态未知。' }}</p>
          <article v-for="item in protocol.data?.areas ?? []" :key="item.area"><header><strong>Area {{ item.area }}</strong><span>{{ item.type === 'nssa' ? 'NSSA' : item.type === 'stub' ? 'Stub' : item.type === 'normal' ? 'Normal' : '类型未知' }} · {{ item.interfaces ?? '未知' }} 个接口</span></header><p>邻居 {{ item.neighbors ?? '未知' }} · 完全邻接 {{ item.adjacentNeighbors ?? '未知' }}</p><details><summary>实际 Area 详情</summary><pre>{{ item.raw }}</pre></details></article>
        </section>
        <p v-if="!protocolDetails.length" class="field-hint">当前服务端未提供实际 Area 状态，请刷新或升级后检查。</p>
        <details><summary>当前草稿 Area · {{ areas.length }} 个（配置参考）</summary><p class="field-hint">此处包含未应用的编辑，仅供与上方实际状态对照。</p><div v-if="areas.length === 0" class="route-dialog-state">当前节点未配置 Area</div><div v-else class="ospf-area-detail-list"><article v-for="item in areas" :key="item.area"><header><strong>Area {{ item.area }}</strong><span>{{ item.links.length }} 条链路</span></header><div v-for="link in item.links" :key="link.id" class="ospf-area-detail-link"><span>{{ link.localInterface }} ↔ {{ link.remoteInterface }}</span><span>Cost {{ link.cost }} · Hello {{ link.hello }} · Dead {{ link.dead }}</span><span>类型：{{ link.options?.type ?? 'ptp' }}</span></div><p v-if="item.options.stub || item.options.nssa || item.options.networks?.length || item.options.external?.length || item.options.stubnets?.length" class="field-hint">{{ item.options.stub ? 'Stub ' : '' }}{{ item.options.nssa ? 'NSSA ' : '' }}{{ item.options.networks?.length ? `Networks ${item.options.networks.length} ` : '' }}{{ item.options.external?.length ? `External ${item.options.external.length} ` : '' }}{{ item.options.stubnets?.length ? `Stubnet ${item.options.stubnets.length}` : '' }}</p></article></div></details>
      </div>
    </div>
  </dialog>
</template>
