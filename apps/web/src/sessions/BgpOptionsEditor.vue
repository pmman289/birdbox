<script setup lang="ts">
import { computed, watch } from "vue";

import type { BgpOptions, BgpSessionType } from "@birdbox/contracts/inventory";

import NullableNumberInput from "../shared/NullableNumberInput.vue";
import OptionalTextInput from "../shared/OptionalTextInput.vue";

const model = defineModel<BgpOptions>({ required: true });
const props = withDefaults(defineProps<{ sessionType?: BgpSessionType }>(), {
  sessionType: "ebgp",
});
const multihop = computed(() => model.value.connectionMode === "multihop");
const customBfd = computed(() => model.value.bfd === "custom");
const md5 = computed(() => model.value.authentication === "md5");
const ao = computed(() => model.value.authentication === "ao");
const capabilities = computed(() => model.value.capabilities !== "off");

watch(multihop, (enabled) => {
  if (!enabled) return;
  model.value.interface = null;
  model.value.onlink = false;
  if (model.value.checkLink === "on") model.value.checkLink = "default";
});

watch(
  () => model.value.authentication,
  (mode) => {
    if (mode !== "md5") model.value.password = null;
    if (mode !== "ao") model.value.aoKeys = "";
  },
);

watch(
  [capabilities, () => model.value.routeRefresh],
  ([enabled, routeRefresh]) => {
    if (!enabled || routeRefresh === "off")
      model.value.requireRouteRefresh = false;
  },
);

watch(
  [
    capabilities,
    () => model.value.routeRefresh,
    () => model.value.enhancedRouteRefresh,
  ],
  ([enabled, routeRefresh, enhanced]) => {
    if (!enabled || routeRefresh === "off" || enhanced === "off")
      model.value.requireEnhancedRouteRefresh = false;
  },
);

watch(
  [capabilities, () => model.value.gracefulRestart],
  ([enabled, graceful]) => {
    if (!enabled || graceful === "off")
      model.value.requireGracefulRestart = false;
  },
);

watch(
  [
    capabilities,
    () => model.value.gracefulRestart,
    () => model.value.longLivedGracefulRestart,
  ],
  ([enabled, graceful, longLived]) => {
    if (!enabled || graceful === "off" || longLived === "off")
      model.value.requireLongLivedGracefulRestart = false;
  },
);

watch([capabilities, () => model.value.enableAs4], ([enabled, as4]) => {
  if (!enabled || as4 === "off") model.value.requireAs4 = false;
});

watch(
  [capabilities, () => model.value.extendedMessages],
  ([enabled, extended]) => {
    if (!enabled || !extended) model.value.requireExtendedMessages = false;
  },
);

watch(
  [capabilities, () => model.value.advertiseHostname],
  ([enabled, hostname]) => {
    if (!enabled || !hostname) model.value.requireHostname = false;
  },
);

watch([capabilities, () => model.value.localRole], ([enabled, role]) => {
  if (!enabled || !role) model.value.requireRoles = false;
});

function updateAllowLocalAs(event: Event): void {
  const input = (event.currentTarget as HTMLInputElement).value
    .trim()
    .toLowerCase();
  if (!input) model.value.allowLocalAs = null;
  else if (input === "all") model.value.allowLocalAs = "all";
  else {
    const parsed = Number(input);
    model.value.allowLocalAs = Number.isSafeInteger(parsed) ? parsed : null;
  }
}
</script>

<template>
  <section class="session-options" aria-labelledby="commonBgpTitle">
    <div class="option-heading">
      <span>{{ props.sessionType === "ibgp" ? "iBGP" : "eBGP" }}</span>
      <h3 id="commonBgpTitle">常用会话参数</h3>
    </div>
    <div class="option-grid">
      <div class="field">
        <label>连接方式</label
        ><select v-model="model.connectionMode">
          <option value="direct">Direct</option>
          <option value="multihop">Multihop</option>
        </select>
      </div>
      <div class="field">
        <label>Multihop TTL</label
        ><input
          v-model.number="model.multihopTtl"
          type="number"
          min="1"
          max="255"
          :disabled="!multihop"
          :required="multihop"
        />
      </div>
      <div class="field">
        <label>BFD</label
        ><select v-model="model.bfd">
          <option value="off">关闭</option>
          <option value="on">启用</option>
          <option value="graceful">Graceful</option>
          <option value="custom">Custom</option>
        </select>
      </div>
      <div class="field">
        <label>Hold Time</label
        ><NullableNumberInput
          v-model="model.holdTime"
          min="0"
          max="65535"
          placeholder="默认 240"
        />
      </div>
      <div class="field">
        <label>Keepalive</label
        ><NullableNumberInput
          v-model="model.keepaliveTime"
          min="1"
          max="65535"
          placeholder="自动"
        />
      </div>
      <label class="compact-toggle"
        ><span>Passive</span><input v-model="model.passive" type="checkbox" /><i
          aria-hidden="true"
        ></i
      ></label>
      <label class="compact-toggle"
        ><span>TTL Security</span
        ><input v-model="model.ttlSecurity" type="checkbox" /><i
          aria-hidden="true"
        ></i
      ></label>
    </div>
  </section>

  <details class="advanced-settings">
    <summary><span>高级配置</span><small>BIRD 2.19.1</small></summary>
    <div class="advanced-content">
      <section class="advanced-group">
        <h3>连接与套接字</h3>
        <div class="option-grid">
          <div class="field full-width">
            <label>Description</label
            ><OptionalTextInput v-model="model.description" maxlength="200" />
          </div>
          <div class="field">
            <label>Router ID</label
            ><OptionalTextInput v-model="model.routerId" />
          </div>
          <div class="field">
            <label>VRF</label
            ><OptionalTextInput
              v-model="model.vrf"
              maxlength="80"
              placeholder="default 或 VRF 名称"
            />
          </div>
          <div class="field">
            <label>Interface</label
            ><OptionalTextInput
              v-model="model.interface"
              maxlength="80"
              :disabled="multihop"
            />
          </div>
          <div class="field">
            <label>TCP Authentication</label
            ><select v-model="model.authentication">
              <option value="none">无认证</option>
              <option value="md5">TCP MD5</option>
              <option value="ao">TCP-AO</option>
            </select>
          </div>
          <div v-if="md5" class="field">
            <label>TCP MD5 Password</label
            ><OptionalTextInput
              v-model="model.password"
              type="password"
              maxlength="80"
              autocomplete="new-password"
              required
            />
          </div>
          <div class="field">
            <label>Setkey</label
            ><select v-model="model.setkey" :disabled="!md5">
              <option value="default">默认</option>
              <option value="on">启用</option>
              <option value="off">关闭</option>
            </select>
          </div>
          <div v-if="ao" class="field full-width">
            <label>TCP-AO Keys</label
            ><textarea
              v-model="model.aoKeys"
              class="compact-code-editor"
              spellcheck="false"
              required
              placeholder='key {&#10;  id 1;&#10;  secret "shared-secret";&#10;  algorithm hmac sha256;&#10;  preferred;&#10; };'
            ></textarea>
          </div>
          <div v-if="customBfd" class="field full-width">
            <label>BFD Session Options</label
            ><textarea
              v-model="model.bfdOptions"
              class="compact-code-editor"
              spellcheck="false"
              required
              placeholder="interval 100 ms;&#10;multiplier 3;"
            ></textarea>
          </div>
          <div class="field">
            <label>Check Link</label
            ><select v-model="model.checkLink">
              <option value="default">自动</option>
              <option value="on" :disabled="multihop">启用</option>
              <option value="off">关闭</option>
            </select>
          </div>
          <label class="compact-toggle"
            ><span>Strict Bind</span
            ><input v-model="model.strictBind" type="checkbox" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Free Bind</span
            ><input v-model="model.freeBind" type="checkbox" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Onlink</span
            ><input
              v-model="model.onlink"
              type="checkbox"
              :disabled="multihop" /><i aria-hidden="true"></i
          ></label>
        </div>
      </section>

      <section v-if="props.sessionType === 'ebgp'" class="advanced-group">
        <h3>eBGP 属性与角色</h3>
        <div class="option-grid">
          <div class="field">
            <label>Local Role</label
            ><select v-model="model.localRole">
              <option value="">未设置</option>
              <option value="provider">provider</option>
              <option value="rs_server">rs_server</option>
              <option value="rs_client">rs_client</option>
              <option value="customer">customer</option>
              <option value="peer">peer</option>
            </select>
          </div>
          <div class="field">
            <label>Allow Local AS</label
            ><input
              :value="model.allowLocalAs ?? ''"
              placeholder="次数或 all"
              @input="updateAllowLocalAs"
            />
          </div>
          <div class="field">
            <label>AS_SET</label
            ><select v-model="model.allowAsSets">
              <option value="default">默认</option>
              <option value="on">允许</option>
              <option value="off">拒绝</option>
            </select>
          </div>
          <div class="field">
            <label>Confederation ASN</label
            ><NullableNumberInput
              v-model="model.confederation"
              min="1"
              max="4294967295"
            />
          </div>
          <label class="compact-toggle"
            ><span>Route Server Client</span
            ><input v-model="model.rsClient" type="checkbox" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Confederation Member</span
            ><input v-model="model.confederationMember" type="checkbox" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>允许 Local Pref</span
            ><input v-model="model.allowLocalPref" type="checkbox" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>允许 MED</span
            ><input v-model="model.allowMed" type="checkbox" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Enforce First AS</span
            ><input v-model="model.enforceFirstAs" type="checkbox" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Require Roles</span
            ><input
              v-model="model.requireRoles"
              type="checkbox"
              :disabled="!capabilities || !model.localRole" /><i
              aria-hidden="true"
            ></i
          ></label>
        </div>
      </section>

      <section class="advanced-group">
        <h3>能力与重启</h3>
        <div class="option-grid">
          <div class="field">
            <label>Route Refresh</label
            ><select v-model="model.routeRefresh">
              <option value="default">默认</option>
              <option value="on">启用</option>
              <option value="off">关闭</option>
            </select>
          </div>
          <div class="field">
            <label>Enhanced Refresh</label
            ><select v-model="model.enhancedRouteRefresh">
              <option value="default">默认</option>
              <option value="on">启用</option>
              <option value="off">关闭</option>
            </select>
          </div>
          <div class="field">
            <label>Graceful Restart</label
            ><select v-model="model.gracefulRestart">
              <option value="default">默认</option>
              <option value="aware">Aware</option>
              <option value="on">启用</option>
              <option value="off">关闭</option>
            </select>
          </div>
          <div class="field">
            <label>Restart Time</label
            ><NullableNumberInput
              v-model="model.gracefulRestartTime"
              min="0"
              max="4095"
              placeholder="默认 120"
            />
          </div>
          <div class="field">
            <label>Min Restart Time</label
            ><NullableNumberInput
              v-model="model.minGracefulRestartTime"
              min="0"
              max="4095"
            />
          </div>
          <div class="field">
            <label>Max Restart Time</label
            ><NullableNumberInput
              v-model="model.maxGracefulRestartTime"
              min="0"
              max="4095"
            />
          </div>
          <div class="field">
            <label>Long-lived GR</label
            ><select v-model="model.longLivedGracefulRestart">
              <option value="default">默认</option>
              <option value="aware">Aware</option>
              <option value="on">启用</option>
              <option value="off">关闭</option>
            </select>
          </div>
          <div class="field">
            <label>LLGR Stale Time</label
            ><NullableNumberInput
              v-model="model.longLivedStaleTime"
              min="0"
              max="16777215"
              placeholder="默认 3600"
            />
          </div>
          <div class="field">
            <label>Min LLGR Stale</label
            ><NullableNumberInput
              v-model="model.minLongLivedStaleTime"
              min="0"
              max="16777215"
            />
          </div>
          <div class="field">
            <label>Max LLGR Stale</label
            ><NullableNumberInput
              v-model="model.maxLongLivedStaleTime"
              min="0"
              max="16777215"
            />
          </div>
          <div class="field">
            <label>Well-known Community</label
            ><select v-model="model.interpretCommunities">
              <option value="default">默认</option>
              <option value="on">处理</option>
              <option value="off">忽略</option>
            </select>
          </div>
          <div class="field">
            <label>AS4</label
            ><select v-model="model.enableAs4">
              <option value="default">默认</option>
              <option value="on">启用</option>
              <option value="off">关闭</option>
            </select>
          </div>
          <div class="field">
            <label>Capabilities</label
            ><select v-model="model.capabilities">
              <option value="default">默认</option>
              <option value="on">启用</option>
              <option value="off">关闭</option>
            </select>
          </div>
          <div class="field">
            <label>Disable After Cease</label
            ><select v-model="model.disableAfterCease">
              <option value="default">默认关闭</option>
              <option value="on">启用</option>
              <option value="off">显式关闭</option>
            </select>
          </div>
          <label class="compact-toggle"
            ><span>Extended Messages</span
            ><input v-model="model.extendedMessages" type="checkbox" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Advertise Hostname</span
            ><input v-model="model.advertiseHostname" type="checkbox" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Disable After Error</span
            ><input v-model="model.disableAfterError" type="checkbox" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Require Route Refresh</span
            ><input
              v-model="model.requireRouteRefresh"
              type="checkbox"
              :disabled="!capabilities || model.routeRefresh === 'off'" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Require Enhanced Refresh</span
            ><input
              v-model="model.requireEnhancedRouteRefresh"
              type="checkbox"
              :disabled="
                !capabilities ||
                model.routeRefresh === 'off' ||
                model.enhancedRouteRefresh === 'off'
              " /><i aria-hidden="true"></i
          ></label>
          <label class="compact-toggle"
            ><span>Require GR</span
            ><input
              v-model="model.requireGracefulRestart"
              type="checkbox"
              :disabled="!capabilities || model.gracefulRestart === 'off'" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Require LLGR</span
            ><input
              v-model="model.requireLongLivedGracefulRestart"
              type="checkbox"
              :disabled="
                !capabilities ||
                model.gracefulRestart === 'off' ||
                model.longLivedGracefulRestart === 'off'
              " /><i aria-hidden="true"></i
          ></label>
          <label class="compact-toggle"
            ><span>Require AS4</span
            ><input
              v-model="model.requireAs4"
              type="checkbox"
              :disabled="!capabilities || model.enableAs4 === 'off'" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Require Extended Messages</span
            ><input
              v-model="model.requireExtendedMessages"
              type="checkbox"
              :disabled="!capabilities || !model.extendedMessages" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Require Hostname</span
            ><input
              v-model="model.requireHostname"
              type="checkbox"
              :disabled="!capabilities || !model.advertiseHostname" /><i
              aria-hidden="true"
            ></i
          ></label>
        </div>
      </section>

      <section class="advanced-group">
        <h3>计时器与选路</h3>
        <div class="option-grid">
          <div class="field">
            <label>Min Hold</label
            ><NullableNumberInput
              v-model="model.minHoldTime"
              min="0"
              max="65535"
            />
          </div>
          <div class="field">
            <label>Startup Hold</label
            ><NullableNumberInput
              v-model="model.startupHoldTime"
              min="0"
              max="65535"
            />
          </div>
          <div class="field">
            <label>Min Keepalive</label
            ><NullableNumberInput
              v-model="model.minKeepaliveTime"
              min="0"
              max="65535"
            />
          </div>
          <div class="field">
            <label>Send Hold Time</label
            ><NullableNumberInput
              v-model="model.sendHoldTime"
              min="0"
              max="65535"
              placeholder="默认 2 × Hold"
            />
          </div>
          <div class="field">
            <label>Connect Delay</label
            ><NullableNumberInput
              v-model="model.connectDelayTime"
              min="0"
              max="86400"
            />
          </div>
          <div class="field">
            <label>Connect Retry</label
            ><NullableNumberInput
              v-model="model.connectRetryTime"
              min="1"
              max="86400"
            />
          </div>
          <div class="field">
            <label>Error Forget</label
            ><NullableNumberInput
              v-model="model.errorForgetTime"
              min="1"
              max="86400"
            />
          </div>
          <div class="field">
            <label>Error Wait Min</label
            ><NullableNumberInput
              v-model="model.errorWaitMin"
              min="1"
              max="86400"
            />
          </div>
          <div class="field">
            <label>Error Wait Max</label
            ><NullableNumberInput
              v-model="model.errorWaitMax"
              min="1"
              max="86400"
            />
          </div>
          <div class="field">
            <label>Path Metric</label
            ><select v-model="model.pathMetric">
              <option value="default">默认</option>
              <option value="on">启用</option>
              <option value="off">关闭</option>
            </select>
          </div>
          <div class="field">
            <label>IGP Metric</label
            ><select v-model="model.igpMetric">
              <option value="default">默认</option>
              <option value="on">启用</option>
              <option value="off">关闭</option>
            </select>
          </div>
          <div class="field">
            <label>Default MED</label
            ><NullableNumberInput
              v-model="model.defaultMed"
              min="0"
              max="4294967295"
            />
          </div>
          <div class="field">
            <label>Default Local Pref</label
            ><NullableNumberInput
              v-model="model.defaultLocalPref"
              min="0"
              max="4294967295"
            />
          </div>
          <label class="compact-toggle"
            ><span>MED Metric</span
            ><input v-model="model.medMetric" type="checkbox" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Deterministic MED</span
            ><input v-model="model.deterministicMed" type="checkbox" /><i
              aria-hidden="true"
            ></i
          ></label>
          <label class="compact-toggle"
            ><span>Prefer Older</span
            ><input v-model="model.preferOlder" type="checkbox" /><i
              aria-hidden="true"
            ></i
          ></label>
        </div>
      </section>

      <section class="advanced-group raw-options">
        <h3>额外 BIRD 指令</h3>
        <div class="field full-width">
          <label>Protocol Block</label
          ><textarea
            v-model="model.raw"
            class="compact-code-editor"
            spellcheck="false"
            placeholder="disable after cease on;"
          ></textarea>
        </div>
      </section>
    </div>
  </details>
</template>
