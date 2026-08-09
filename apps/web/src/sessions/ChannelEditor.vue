<script setup lang="ts">
import { computed, watch } from "vue";

import type {
  AddressFamily,
  BgpChannel,
  BgpOptions,
  Peer,
  PolicyDefine,
  PolicyFilter,
  PolicyFunction,
} from "@birdbox/contracts/inventory";

import NullableNumberInput from "../shared/NullableNumberInput.vue";
import OptionalTextInput from "../shared/OptionalTextInput.vue";
import PolicyEditor from "./PolicyEditor.vue";
import { channelUsesCrossFamilyTransport } from "./session-draft";

const props = defineProps<{
  family: AddressFamily;
  peer: Peer;
  bgp: BgpOptions;
  functions: PolicyFunction[];
  filters: PolicyFilter[];
  defines: PolicyDefine[];
  active: boolean;
}>();

const emit = defineEmits<{
  "open-policy-action": [direction: "import" | "export"];
}>();

const model = defineModel<BgpChannel>({ required: true });
const label = computed(() => props.family === "ipv4" ? "IPv4" : "IPv6");
const disabled = computed(() => !model.value.enabled);
const capabilitiesEnabled = computed(() => props.bgp.capabilities !== "off");
const multihop = computed(() => props.bgp.connectionMode === "multihop");
const automaticExtendedNextHop = computed(() => model.value.enabled && channelUsesCrossFamilyTransport(props.peer, props.family));
const extendedNextHopLabel = computed(() => automaticExtendedNextHop.value ? "Extended Next Hop · 自动" : "Extended Next Hop");

watch(automaticExtendedNextHop, (automatic) => {
  if (automatic) model.value.extendedNextHop = true;
}, { immediate: true });

watch([capabilitiesEnabled, () => model.value.extendedNextHop], ([capabilities, extended]) => {
  if (!capabilities || !extended) model.value.requireExtendedNextHop = false;
});

watch([capabilitiesEnabled, () => model.value.addPaths], ([capabilities, addPaths]) => {
  if (!capabilities || addPaths === "off") model.value.requireAddPaths = false;
});

watch(multihop, (enabled) => {
  if (enabled && model.value.gateway === "direct") model.value.gateway = "default";
});

watch(() => props.bgp.disableAfterError, (disabledAfterError) => {
  if (disabledAfterError && model.value.importLimit.action === "restart") model.value.importLimit.action = "disable";
});
</script>

<template>
  <section class="afi-channel-panel" :class="{ active }" :data-family="family" role="tabpanel" :hidden="!active">
    <div class="channel-enable-row">
      <div><span>{{ label }}</span><h3>{{ label }} Channel</h3></div>
      <label class="compact-toggle"><span>启用</span><input v-model="model.enabled" type="checkbox"><i aria-hidden="true"></i></label>
    </div>
    <div class="channel-content" :class="{ disabled }">
      <PolicyEditor
        :family="family"
        direction="import"
        :policy="model.importPolicy"
        :export-define-id="model.exportDefineId"
        :functions="functions"
        :filters="filters"
        :defines="defines"
        :disabled="disabled"
        @update:policy="model.importPolicy = $event"
        @open-policy-action="emit('open-policy-action', 'import')"
      />
      <PolicyEditor
        :family="family"
        direction="export"
        :policy="model.exportPolicy"
        :export-define-id="model.exportDefineId"
        :functions="functions"
        :filters="filters"
        :defines="defines"
        :disabled="disabled"
        @update:policy="model.exportPolicy = $event"
        @update:export-define-id="model.exportDefineId = $event"
        @open-policy-action="emit('open-policy-action', 'export')"
      />

      <section class="session-options">
        <div class="option-heading"><span>{{ label }}</span><h3>Channel 限制</h3></div>
        <div class="limit-grid">
          <div class="field"><label>Import Limit</label><NullableNumberInput v-model="model.importLimit.value" min="1" placeholder="关闭" :disabled="disabled" /></div>
          <div class="field"><label>动作</label><select v-model="model.importLimit.action" :disabled="disabled"><option value="disable">disable</option><option value="restart" :disabled="bgp.disableAfterError">restart</option><option value="block">block</option><option value="warn">warn</option></select></div>
          <div class="field"><label>Export Limit</label><NullableNumberInput v-model="model.exportLimit.value" min="1" placeholder="关闭" :disabled="disabled" /></div>
          <div class="field"><label>动作</label><select v-model="model.exportLimit.action" :disabled="disabled"><option value="disable">disable</option><option value="restart">restart</option><option value="block">block</option><option value="warn">warn</option></select></div>
        </div>
      </section>

      <details class="channel-advanced-settings">
        <summary><span>{{ label }} 高级配置</span><small>Address family</small></summary>
        <div class="advanced-content"><div class="option-grid">
          <div class="field"><label>Table</label><OptionalTextInput v-model="model.table" pattern="[A-Za-z_][A-Za-z0-9_]*" :disabled="disabled" /></div>
          <div class="field"><label>Preference</label><NullableNumberInput v-model="model.preference" min="0" max="4294967295" :disabled="disabled" /></div>
          <div class="field"><label>RPKI Reload</label><select v-model="model.rpkiReload" :disabled="disabled"><option value="default">默认</option><option value="on">启用</option><option value="off">关闭</option></select></div>
          <div class="field"><label>Receive Limit</label><NullableNumberInput v-model="model.receiveLimit.value" min="1" placeholder="关闭" :disabled="disabled" /></div>
          <div class="field"><label>Receive 动作</label><select v-model="model.receiveLimit.action" :disabled="disabled"><option value="disable">disable</option><option value="restart">restart</option><option value="block">block</option><option value="warn">warn</option></select></div>
          <div class="field"><label>Next Hop Keep</label><select v-model="model.nextHopKeep" :disabled="disabled"><option value="default">默认</option><option value="on">全部</option><option value="ibgp">iBGP</option><option value="ebgp">eBGP</option><option value="off">关闭</option></select></div>
          <div class="field"><label>Next Hop Self</label><select v-model="model.nextHopSelf" :disabled="disabled"><option value="default">默认</option><option value="on">全部</option><option value="ibgp">iBGP</option><option value="ebgp">eBGP</option><option value="off">关闭</option></select></div>
          <div class="field"><label>Next Hop Address</label><OptionalTextInput v-model="model.nextHopAddress" :disabled="disabled" /></div>
          <div class="field"><label>Next Hop Prefer</label><select v-model="model.nextHopPrefer" :disabled="disabled"><option value="default">自动</option><option value="global">Global</option><option value="local">Link-local</option></select></div>
          <div v-if="family === 'ipv6'" class="field"><label>Link-local Next Hop</label><select v-model="model.linkLocalNextHopFormat" :disabled="disabled"><option value="default">默认 Native</option><option value="native">Native</option><option value="single">Single</option><option value="double">Double</option></select></div>
          <div class="field"><label>Gateway</label><select v-model="model.gateway" :disabled="disabled"><option value="default">自动</option><option value="direct" :disabled="multihop">direct</option><option value="recursive">recursive</option></select></div>
          <div class="field"><label>IGP Table</label><OptionalTextInput v-model="model.igpTable" pattern="[A-Za-z_][A-Za-z0-9_]*" :disabled="disabled" /></div>
          <div class="field"><label>Add Paths</label><select v-model="model.addPaths" :disabled="disabled"><option value="off">关闭</option><option value="on">RX + TX</option><option value="rx">RX</option><option value="tx">TX</option></select></div>
          <div class="field"><label>AIGP</label><select v-model="model.aigp" :disabled="disabled"><option value="default">默认</option><option value="on">启用</option><option value="originate">Originate</option><option value="off">关闭</option></select></div>
          <div class="field"><label>Cost</label><NullableNumberInput v-model="model.cost" min="1" max="4294967295" :disabled="disabled" /></div>
          <div class="field"><label>Channel GR</label><select v-model="model.gracefulRestart" :disabled="disabled"><option value="default">默认</option><option value="on">启用</option><option value="off">关闭</option></select></div>
          <div class="field"><label>Channel LLGR</label><select v-model="model.longLivedGracefulRestart" :disabled="disabled"><option value="default">默认</option><option value="on">启用</option><option value="off">关闭</option></select></div>
          <div class="field"><label>Channel Stale Time</label><NullableNumberInput v-model="model.longLivedStaleTime" min="0" max="16777215" :disabled="disabled" /></div>
          <div class="field"><label>Min Channel Stale</label><NullableNumberInput v-model="model.minLongLivedStaleTime" min="0" max="16777215" :disabled="disabled" /></div>
          <div class="field"><label>Max Channel Stale</label><NullableNumberInput v-model="model.maxLongLivedStaleTime" min="0" max="16777215" :disabled="disabled" /></div>
          <label class="compact-toggle"><span>Keep Filtered</span><input v-model="model.importKeepFiltered" type="checkbox" :disabled="disabled"><i aria-hidden="true"></i></label>
          <label class="compact-toggle"><span>Mandatory</span><input v-model="model.mandatory" type="checkbox" :disabled="disabled"><i aria-hidden="true"></i></label>
          <label class="compact-toggle"><span>Import Table</span><input v-model="model.importTable" type="checkbox" :disabled="disabled"><i aria-hidden="true"></i></label>
          <label class="compact-toggle"><span>Export Table</span><input v-model="model.exportTable" type="checkbox" :disabled="disabled"><i aria-hidden="true"></i></label>
          <label class="compact-toggle"><span>Secondary</span><input v-model="model.secondary" type="checkbox" :disabled="disabled"><i aria-hidden="true"></i></label>
          <label class="compact-toggle" :class="{ automatic: automaticExtendedNextHop }" :title="automaticExtendedNextHop ? `${peer.address.includes(':') ? 'IPv6' : 'IPv4'} 邻居承载 ${label} Channel，已自动启用` : ''"><span>{{ extendedNextHopLabel }}</span><input v-model="model.extendedNextHop" type="checkbox" :disabled="disabled || automaticExtendedNextHop"><i aria-hidden="true"></i></label>
          <label v-if="family === 'ipv4'" class="compact-toggle"><span>Require Extended Next Hop</span><input v-model="model.requireExtendedNextHop" type="checkbox" :disabled="disabled || !capabilitiesEnabled || !model.extendedNextHop"><i aria-hidden="true"></i></label>
          <label class="compact-toggle"><span>Require Add Paths</span><input v-model="model.requireAddPaths" type="checkbox" :disabled="disabled || !capabilitiesEnabled || model.addPaths === 'off'"><i aria-hidden="true"></i></label>
          <div class="field full-width"><label>{{ label }} Channel Block</label><textarea v-model="model.raw" class="compact-code-editor" spellcheck="false" placeholder="debug { routes };" :disabled="disabled"></textarea></div>
        </div></div>
      </details>
    </div>
  </section>
</template>
