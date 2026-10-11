<script setup lang="ts">
import { computed } from "vue";

interface DomainSummary {
  id: string;
  name: string;
}

interface NodeHealth {
  id: string;
  name: string;
  v2: string;
  v3: string;
  neighbors: number;
  routes: number;
  error?: string | null;
}

const props = defineProps<{
  domains: DomainSummary[];
  domainId: string | null;
  domainName: string;
  loadingState: "loading" | "ready" | "error";
  loadError: string;
  nodeCount: number;
  linkCount: number;
  nodes: NodeHealth[];
  actionPending: "preview" | "draft" | "save" | null;
  ready: boolean;
  dirty: boolean;
}>();

const emit = defineEmits<{
  "update:domainName": [value: string];
  select: [id: string];
  new: [];
  remove: [];
  retry: [];
  preview: [];
  runtime: [];
  draft: [];
  save: [];
} >();

const warningCount = computed(() => props.nodes.filter((node) => node.error || [node.v2, node.v3].some((state) => /未检查|未配置|down|idle|init|loading|error|timeout/i.test(state))).length);
const neighborCount = computed(() => props.nodes.reduce((total, node) => total + node.neighbors, 0));
const routeCount = computed(() => props.nodes.reduce((total, node) => total + node.routes, 0));
const statusLabel = computed(() => {
  if (props.loadingState === "loading") return "正在加载";
  if (props.loadingState === "error") return "加载失败";
  if (warningCount.value) return `${warningCount.value} 个节点需要关注`;
  if (!props.nodeCount) return "等待添加节点";
  return "运行正常";
});
</script>

<template>
  <div class="ospf-overview">
    <div class="section-heading ospf-overview-head">
      <div>
        <p class="eyebrow">INTERIOR GATEWAY PROTOCOL</p>
        <h2 id="ospfTitle">OSPF 管理</h2>
        <p class="section-note">按“选择节点 → 添加连接 → 检查 Area → 预检应用”完成配置；高级参数只在需要时展开。</p>
      </div>
      <div v-if="loadingState === 'loading'" class="ospf-load-status" role="status" aria-live="polite">正在加载 OSPF 域…</div>
      <div v-else-if="loadingState === 'error'" class="ospf-load-status error" role="alert">
        <span>OSPF 域加载失败：{{ loadError }}</span>
        <button class="secondary-button compact-button" type="button" @click="emit('retry')">重试</button>
      </div>
      <div class="ospf-actions" :aria-busy="actionPending !== null">
        <label class="ospf-domain-picker">OSPF 域
          <select :value="domainId ?? ''" :disabled="actionPending !== null || !ready" @change="emit('select', ($event.currentTarget as HTMLSelectElement).value)">
            <option value="" disabled>选择域</option>
            <option v-for="domain in domains" :key="domain.id" :value="domain.id">{{ domain.name }}</option>
          </select>
        </label>
        <input
          class="ospf-domain-name"
          :value="domainName"
          :disabled="actionPending !== null || !ready"
          aria-label="OSPF 域名称"
          placeholder="OSPF 域名称"
          @input="emit('update:domainName', ($event.currentTarget as HTMLInputElement).value)"
        />
        <button class="secondary-button compact-button" type="button" :disabled="actionPending !== null || !ready" @click="emit('new')">新建域</button>
        <button v-if="domainId" class="danger-button compact-button" type="button" :disabled="actionPending !== null || !ready" @click="emit('remove')">删除域</button>
        <button class="secondary-button" type="button" aria-label="预检配置" :disabled="actionPending !== null || !ready || !nodeCount" @click="emit('preview')">
          {{ actionPending === "preview" ? "正在预检" : "预检并查看变更" }}
        </button>
        <button class="secondary-button" type="button" :disabled="!ready || !nodeCount" @click="emit('runtime')">查看运行态</button>
        <button class="secondary-button" type="button" :disabled="actionPending !== null || !ready" @click="emit('draft')">
          {{ actionPending === "draft" ? "正在保存草稿" : "保存草稿" }}
        </button>
        <button class="primary-button" type="button" aria-label="保存并应用" :disabled="actionPending !== null || !ready || !nodeCount" @click="emit('save')">
          {{ actionPending === "save" ? "正在应用" : dirty ? "应用 · 有未保存修改" : "应用" }}
        </button>
      </div>
    </div>

    <div class="ospf-health-grid" aria-label="OSPF 健康总览">
      <article class="ospf-health-card" :class="{ warning: warningCount > 0 }">
        <span>域状态</span><strong>{{ statusLabel }}</strong><small>{{ nodeCount }} 个节点 · {{ linkCount }} 条链路</small>
      </article>
      <article class="ospf-health-card"><span>邻居</span><strong>{{ neighborCount }}</strong><small>当前运行态汇总</small></article>
      <article class="ospf-health-card"><span>OSPF 路由</span><strong>{{ routeCount }}</strong><small>v2/v3 合计</small></article>
      <article class="ospf-health-card" :class="{ warning: dirty }"><span>配置状态</span><strong>{{ dirty ? "有待应用修改" : "已同步" }}</strong><small>{{ dirty ? "预检后再应用" : "与已保存配置一致" }}</small></article>
    </div>
  </div>
</template>
