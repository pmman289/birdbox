<script setup lang="ts">
import { computed, ref } from "vue";

import type {
  AddressFamily,
  BgpSession,
  Peer,
  PolicyDefine,
  PolicyFilter,
  PolicyFunction,
} from "@birdbox/contracts/inventory";
import { resourceAppliesToNode } from "@birdbox/contracts/resource-scope";

import BgpOptionsEditor from "../sessions/BgpOptionsEditor.vue";
import ChannelEditor from "../sessions/ChannelEditor.vue";

const props = defineProps<{
  nodeName: string;
  peer: Peer;
  defines: PolicyDefine[];
  functions: PolicyFunction[];
  filters: PolicyFilter[];
}>();

const emit = defineEmits<{
  "open-policy-action": [context: {
    family: AddressFamily;
    direction: "import" | "export";
  }];
}>();

const model = defineModel<BgpSession>({ required: true });
const activeFamily = ref<AddressFamily>("ipv4");
const families = ["ipv4", "ipv6"] as const satisfies readonly AddressFamily[];
const clusterInputId = computed(
  () => `ibgpCluster_${model.value.nodeId}_${model.value.id}`,
);

const visibleDefines = computed(() => {
  const type = activeFamily.value === "ipv4" ? "cidr4" : "cidr6";
  return props.defines.filter(
    (resource) =>
      resource.enabled &&
      resource.type === type &&
      resourceAppliesToNode(resource, model.value.nodeId),
  );
});

const visibleFunctions = computed(() =>
  props.functions.filter(
    (resource) =>
      resource.enabled &&
      resource.callable &&
      resourceAppliesToNode(resource, model.value.nodeId),
  ),
);

const visibleFilters = computed(() =>
  props.filters.filter(
    (resource) =>
      resource.enabled &&
      resourceAppliesToNode(resource, model.value.nodeId),
  ),
);
</script>

<template>
  <section class="ibgp-side-editor" :data-node-id="model.nodeId">
    <div class="subsection-head ibgp-side-heading">
      <div>
        <h3>{{ nodeName }}</h3>
        <span>连接到 {{ peer.name }} · {{ peer.address }}</span>
      </div>
      <span class="status-pill unconfigured">iBGP</span>
    </div>

    <div class="ibgp-form-grid">
      <div class="field">
        <label>协议名称</label
        ><input
          v-model.trim="model.protocolName"
          pattern="[A-Za-z_][A-Za-z0-9_]*"
          maxlength="48"
        />
      </div>
      <div class="field">
        <label>本地连接地址</label>
        <div class="field-readonly">{{ model.localAddress }}</div>
      </div>
      <div class="field">
        <label>本地端口</label
        ><input
          v-model.number="model.localPort"
          type="number"
          min="1"
          max="65535"
        />
      </div>
      <label class="compact-toggle"
        ><span>将对端作为 RR Client</span
        ><input v-model="model.bgp.rrClient" type="checkbox" /><i
          aria-hidden="true"
        ></i
      ></label>
      <div class="field full-width">
        <label :for="clusterInputId">本端 RR Cluster ID</label
        ><input
          :id="clusterInputId"
          v-model.trim="model.bgp.rrClusterId"
          placeholder="可选；同一 RR 集群通常保持一致"
        />
      </div>
    </div>

    <BgpOptionsEditor v-model="model.bgp" session-type="ibgp" />

    <div class="channel-editors ibgp-channel-editors">
      <nav class="afi-tabs" role="tablist" :aria-label="`${nodeName} Address Family`">
        <button
          v-for="family in families"
          :key="family"
          class="afi-tab"
          :class="{
            active: activeFamily === family,
            disabled: !model.channels[family].enabled,
          }"
          type="button"
          role="tab"
          :aria-selected="activeFamily === family"
          @click="activeFamily = family"
        >
          {{ family === "ipv4" ? "IPv4" : "IPv6" }}
          <span>{{ model.channels[family].enabled ? "开启" : "关闭" }}</span>
        </button>
      </nav>
      <ChannelEditor
        v-for="family in families"
        :key="family"
        v-model="model.channels[family]"
        :family="family"
        :peer="peer"
        :bgp="model.bgp"
        :functions="visibleFunctions"
        :filters="visibleFilters"
        :defines="visibleDefines"
        :active="activeFamily === family"
        @open-policy-action="
          emit('open-policy-action', { family, direction: $event })
        "
      />
    </div>
  </section>
</template>
