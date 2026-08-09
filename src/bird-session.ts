import type {
  AddressFamily,
  BgpChannel,
  BgpOptions,
  BgpSession,
  ChannelLimit,
  ChannelPolicy,
  PolicyFormStep,
  PolicyFunctionStep,
} from "../packages/contracts/src/inventory.js";
import {
  RUNTIME,
  assertValidation,
  normalizeAsn,
  normalizeEnum,
  normalizeId,
  normalizeIPAddress,
  normalizeIPv4,
  normalizeOptionalInteger,
  normalizeOptionalName,
  normalizeOptionalString,
  normalizePort,
} from "./bird-normalize-common.js";
import { normalizeBirdBlockSource } from "./bird-source.js";

type UnknownRecord = Record<string, unknown>;
type PolicyDirection = "import" | "export";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_PROTOCOL_NAMES = new Set(["birdbox_device", "birdbox_static", "birdbox_static4", "birdbox_static6", "birdbox_bfd"]);
const POLICY_MODES = new Set(["form", "combined", "custom"] as const);
const FUNCTION_STEP_ACTIONS = new Set(["accept", "reject", "execute"] as const);
const SWITCH_SETTINGS = new Set(["default", "on", "off"] as const);
const GRACEFUL_RESTART_MODES = new Set(["default", "off", "aware", "on"] as const);
const BFD_MODES = new Set(["off", "on", "graceful", "custom"] as const);
const NEXT_HOP_MODES = new Set(["default", "off", "on", "ibgp", "ebgp"] as const);
const NEXT_HOP_PREFER_MODES = new Set(["default", "global", "local"] as const);
const LINK_LOCAL_NEXT_HOP_FORMATS = new Set(["default", "native", "single", "double"] as const);
const BGP_AUTHENTICATION_MODES = new Set(["none", "md5", "ao"] as const);
const LIMIT_ACTIONS = new Set(["warn", "block", "restart", "disable"] as const);
const LOCAL_ROLES = new Set(["", "provider", "rs_server", "rs_client", "customer", "peer"] as const);
const MAX_GRACEFUL_RESTART_TIME = 4095;
const MAX_LONG_LIVED_STALE_TIME = 16777215;

function record(value: unknown, message: string): UnknownRecord {
  assertValidation(value && typeof value === "object" && !Array.isArray(value), message);
  return value as UnknownRecord;
}

function optionalRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function normalizeLimit(inputValue: unknown, label: string): ChannelLimit {
  const input = optionalRecord(inputValue);
  return {
    value: normalizeOptionalInteger(input.value, `${label}数量`, 1),
    action: normalizeEnum(input.action, LIMIT_ACTIONS, "disable", `${label}动作`),
  };
}

function normalizePolicy(inputValue: unknown, label: string, direction: PolicyDirection): ChannelPolicy {
  const input = optionalRecord(inputValue);
  const mode = normalizeEnum(input.mode, POLICY_MODES, "form", `${label}模式`);
  let rawSteps: unknown[];
  if (Array.isArray(input.steps)) {
    rawSteps = input.steps;
  } else {
    const functionIds = input.functionIds ?? [];
    assertValidation(Array.isArray(functionIds), `${label} Function 列表不合法`);
    rawSteps = functionIds.map((functionId) => ({ functionId, action: "execute" }));
  }
  if (mode === "combined" && !rawSteps.some((step) => optionalRecord(step).type === "form")) {
    rawSteps = [...rawSteps, { type: "form" }];
  }
  const steps: Array<PolicyFunctionStep | PolicyFormStep> = rawSteps.map((stepValue) => {
    const step = record(stepValue, `${label} Function 步骤不合法`);
    if (step.type === "form") return { type: "form" };
    return {
      type: "function",
      functionId: normalizeId(step.functionId, `${label} Function ID`),
      action: normalizeEnum(step.action, FUNCTION_STEP_ACTIONS, "execute", `${label} Function 动作`),
    };
  });
  const filterId = input.filterId === null || input.filterId === undefined || input.filterId === ""
    ? null
    : normalizeId(input.filterId, `${label} Filter ID`);
  const functionSteps = steps.filter((step): step is PolicyFunctionStep => step.type === "function");
  const formStepCount = steps.filter((step) => step.type === "form").length;
  assertValidation(functionSteps.length <= 16, `${label}最多可组合 16 个 Function`);
  assertValidation(new Set(functionSteps.map((step) => step.functionId)).size === functionSteps.length, `${label}包含重复 Function`);
  if (mode === "combined") assertValidation(formStepCount === 1, `${label}组合模式必须包含一个表单策略步骤`);
  if (mode === "custom") assertValidation(filterId !== null, `${label}自定义模式必须选择 Filter`);
  const formAction = direction === "import"
    ? normalizeEnum(input.formAction, new Set(["all", "none"] as const), "all", "导入表单动作")
    : normalizeEnum(input.formAction, new Set(["all", "none", "cidr"] as const), "none", "导出表单动作");
  return {
    mode,
    steps: mode === "combined" ? steps : [],
    filterId: mode === "custom" ? filterId : null,
    formAction,
  };
}

function normalizeBgpOptions(inputValue: unknown, legacyMultihop: unknown): BgpOptions {
  const input = optionalRecord(inputValue);
  const connectionMode = normalizeEnum(
    input.connectionMode,
    new Set(["direct", "multihop"] as const),
    legacyMultihop === false ? "direct" : "multihop",
    "连接方式",
  );
  const multihopTtl = normalizeOptionalInteger(input.multihopTtl ?? 10, "Multihop TTL", 1, 255);
  assertValidation(multihopTtl !== null, "Multihop TTL 不能为空");
  const errorWaitMin = normalizeOptionalInteger(input.errorWaitMin, "错误等待下限", 1, 86400);
  const errorWaitMax = normalizeOptionalInteger(input.errorWaitMax, "错误等待上限", 1, 86400);
  assertValidation((errorWaitMin === null) === (errorWaitMax === null), "错误等待时间必须同时填写下限和上限");
  assertValidation(errorWaitMin === null || errorWaitMax === null || errorWaitMin <= errorWaitMax, "错误等待范围必须从小到大");
  const checkLink = normalizeEnum(input.checkLink, SWITCH_SETTINGS, "default", "链路检查设置");
  assertValidation(connectionMode !== "multihop" || checkLink !== "on", "Multihop 会话不能启用链路检查");
  const interfaceName = normalizeOptionalString(input.interface, "接口名称", 80);
  assertValidation(connectionMode !== "multihop" || interfaceName === null, "Multihop 会话不能绑定接口");
  const passive = input.passive === true;
  const onlink = input.onlink === true;
  assertValidation(connectionMode !== "multihop" || !onlink, "Multihop 会话不能启用 Onlink");
  assertValidation(!onlink || passive || interfaceName !== null, "主动 Onlink 会话必须指定接口");
  const routeRefresh = normalizeEnum(input.routeRefresh, SWITCH_SETTINGS, "default", "Route Refresh 设置");
  const enhancedRouteRefresh = normalizeEnum(input.enhancedRouteRefresh, SWITCH_SETTINGS, "default", "Enhanced Route Refresh 设置");
  assertValidation(routeRefresh !== "off" || enhancedRouteRefresh !== "on", "关闭 Route Refresh 时不能启用 Enhanced Route Refresh");
  const allowLocalAs = input.allowLocalAs === "all"
    ? "all"
    : normalizeOptionalInteger(input.allowLocalAs, "允许本地 ASN 次数", 1, 255);
  const bfd = normalizeEnum(input.bfd, BFD_MODES, "off", "BFD 模式");
  const bfdOptions = normalizeBirdBlockSource(input.bfdOptions, "BFD 会话参数");
  assertValidation(bfd !== "custom" || bfdOptions.length > 0, "Custom BFD 至少需要一条会话参数");
  const password = normalizeOptionalString(input.password, "TCP MD5 密码", 80);
  const aoKeys = normalizeBirdBlockSource(input.aoKeys, "TCP-AO Keys");
  const authentication = normalizeEnum(
    input.authentication,
    BGP_AUTHENTICATION_MODES,
    password ? "md5" : aoKeys ? "ao" : "none",
    "BGP 认证方式",
  );
  assertValidation(authentication !== "md5" || password !== null, "TCP MD5 认证必须填写密码");
  assertValidation(authentication !== "ao" || aoKeys.length > 0, "TCP-AO 认证必须填写 Keys 配置");
  assertValidation(authentication === "md5" || password === null, "只有 TCP MD5 认证可以填写密码");
  assertValidation(authentication === "ao" || aoKeys.length === 0, "只有 TCP-AO 认证可以填写 Keys 配置");

  const gracefulRestart = normalizeEnum(input.gracefulRestart, GRACEFUL_RESTART_MODES, "default", "Graceful Restart 设置");
  const gracefulRestartTime = normalizeOptionalInteger(input.gracefulRestartTime, "Graceful Restart 时间", 0, MAX_GRACEFUL_RESTART_TIME);
  const minGracefulRestartTime = normalizeOptionalInteger(input.minGracefulRestartTime, "最小 Graceful Restart 时间", 0, MAX_GRACEFUL_RESTART_TIME);
  const maxGracefulRestartTime = normalizeOptionalInteger(input.maxGracefulRestartTime, "最大 Graceful Restart 时间", 0, MAX_GRACEFUL_RESTART_TIME);
  assertValidation(minGracefulRestartTime === null || maxGracefulRestartTime === null || minGracefulRestartTime <= maxGracefulRestartTime, "Graceful Restart 时间范围必须从小到大");
  const longLivedGracefulRestart = normalizeEnum(input.longLivedGracefulRestart, GRACEFUL_RESTART_MODES, "default", "Long-lived Graceful Restart 设置");
  const longLivedStaleTime = normalizeOptionalInteger(input.longLivedStaleTime, "Long-lived stale 时间", 0, MAX_LONG_LIVED_STALE_TIME);
  const minLongLivedStaleTime = normalizeOptionalInteger(input.minLongLivedStaleTime, "最小 Long-lived stale 时间", 0, MAX_LONG_LIVED_STALE_TIME);
  const maxLongLivedStaleTime = normalizeOptionalInteger(input.maxLongLivedStaleTime, "最大 Long-lived stale 时间", 0, MAX_LONG_LIVED_STALE_TIME);
  assertValidation(minLongLivedStaleTime === null || maxLongLivedStaleTime === null || minLongLivedStaleTime <= maxLongLivedStaleTime, "Long-lived stale 时间范围必须从小到大");
  assertValidation(gracefulRestart !== "off" || !["on", "aware"].includes(longLivedGracefulRestart), "Long-lived Graceful Restart 依赖 Graceful Restart");

  const holdTime = normalizeOptionalInteger(input.holdTime, "Hold Time", 0, 65535);
  assertValidation(holdTime === null || holdTime === 0 || holdTime >= 3, "Hold Time 必须为 0 或 3 到 65535");
  const keepaliveTime = normalizeOptionalInteger(input.keepaliveTime, "Keepalive Time", 1, 65535);
  const minHoldTime = normalizeOptionalInteger(input.minHoldTime, "最小 Hold Time", 0, 65535);
  const minKeepaliveTime = normalizeOptionalInteger(input.minKeepaliveTime, "最小 Keepalive Time", 0, 65535);
  const effectiveHoldTime = holdTime ?? 240;
  const effectiveKeepaliveTime = keepaliveTime ?? Math.floor(effectiveHoldTime / 3);
  assertValidation(keepaliveTime === null || keepaliveTime <= effectiveHoldTime, "Keepalive Time 不能大于 Hold Time");
  assertValidation(minHoldTime === null || minHoldTime <= effectiveHoldTime, "最小 Hold Time 不能大于 Hold Time");
  assertValidation(minKeepaliveTime === null || minKeepaliveTime <= effectiveKeepaliveTime, "最小 Keepalive Time 不能大于 Keepalive Time");

  const capabilities = normalizeEnum(input.capabilities, SWITCH_SETTINGS, "default", "Capabilities 设置");
  const requireRouteRefresh = input.requireRouteRefresh === true;
  const requireEnhancedRouteRefresh = input.requireEnhancedRouteRefresh === true;
  const requireAs4 = input.requireAs4 === true;
  const requireExtendedMessages = input.requireExtendedMessages === true;
  const requireHostname = input.requireHostname === true;
  const requireGracefulRestart = input.requireGracefulRestart === true;
  const requireLongLivedGracefulRestart = input.requireLongLivedGracefulRestart === true;
  assertValidation(!requireRouteRefresh || routeRefresh !== "off", "Require Route Refresh 需要启用 Route Refresh");
  assertValidation(!requireEnhancedRouteRefresh || (routeRefresh !== "off" && enhancedRouteRefresh !== "off"), "Require Enhanced Route Refresh 需要启用 Route Refresh 与 Enhanced Route Refresh");
  assertValidation(!requireAs4 || input.enableAs4 !== "off", "Require AS4 需要启用 AS4");
  assertValidation(!requireExtendedMessages || input.extendedMessages === true, "Require Extended Messages 需要启用 Extended Messages");
  assertValidation(!requireHostname || input.advertiseHostname === true, "Require Hostname 需要启用 Advertise Hostname");
  assertValidation(!requireGracefulRestart || gracefulRestart !== "off", "Require Graceful Restart 需要启用 Graceful Restart");
  assertValidation(!requireLongLivedGracefulRestart || (gracefulRestart !== "off" && longLivedGracefulRestart !== "off"), "Require LLGR 需要启用 GR 与 LLGR");
  assertValidation(capabilities !== "off" || ![
    requireRouteRefresh,
    requireEnhancedRouteRefresh,
    requireAs4,
    requireExtendedMessages,
    requireHostname,
    requireGracefulRestart,
    requireLongLivedGracefulRestart,
  ].some(Boolean), "关闭 Capabilities 时不能要求远端能力");

  const confederation = normalizeOptionalInteger(input.confederation, "Confederation ASN", 1);
  const confederationMember = input.confederationMember === true;
  assertValidation(!confederationMember || confederation !== null, "Confederation Member 必须设置 Confederation ASN");
  const localRole = normalizeEnum(input.localRole, LOCAL_ROLES, "", "本地 BGP Role");
  const requireRoles = input.requireRoles === true;
  assertValidation(!requireRoles || localRole !== "", "Require Roles 必须设置 Local Role");
  return {
    connectionMode,
    multihopTtl,
    passive,
    bfd,
    bfdOptions,
    ttlSecurity: input.ttlSecurity === true,
    description: normalizeOptionalString(input.description, "会话描述", 200),
    routerId: input.routerId === null || input.routerId === undefined || input.routerId === ""
      ? null
      : normalizeIPv4(input.routerId, "会话 Router ID"),
    vrf: normalizeOptionalString(input.vrf, "VRF", 80),
    interface: interfaceName,
    onlink,
    authentication,
    password: authentication === "md5" ? password : null,
    aoKeys: authentication === "ao" ? aoKeys : "",
    setkey: normalizeEnum(input.setkey, SWITCH_SETTINGS, "default", "Setkey 设置"),
    strictBind: input.strictBind === true,
    freeBind: input.freeBind === true,
    checkLink,
    rsClient: input.rsClient === true,
    confederation,
    confederationMember,
    allowLocalPref: input.allowLocalPref === true,
    allowMed: input.allowMed === true,
    allowLocalAs,
    allowAsSets: normalizeEnum(input.allowAsSets, SWITCH_SETTINGS, "default", "AS_SET 设置"),
    enforceFirstAs: input.enforceFirstAs === true,
    routeRefresh,
    enhancedRouteRefresh,
    requireRouteRefresh,
    requireEnhancedRouteRefresh,
    gracefulRestart,
    gracefulRestartTime,
    minGracefulRestartTime,
    maxGracefulRestartTime,
    requireGracefulRestart,
    longLivedGracefulRestart,
    longLivedStaleTime,
    minLongLivedStaleTime,
    maxLongLivedStaleTime,
    requireLongLivedGracefulRestart,
    interpretCommunities: normalizeEnum(input.interpretCommunities, SWITCH_SETTINGS, "default", "Well-known Community 设置"),
    enableAs4: normalizeEnum(input.enableAs4, SWITCH_SETTINGS, "default", "AS4 设置"),
    requireAs4,
    extendedMessages: input.extendedMessages === true,
    requireExtendedMessages,
    capabilities,
    advertiseHostname: input.advertiseHostname === true,
    requireHostname,
    disableAfterError: input.disableAfterError === true,
    disableAfterCease: normalizeEnum(input.disableAfterCease, SWITCH_SETTINGS, "default", "Disable After Cease 设置"),
    holdTime,
    minHoldTime,
    startupHoldTime: normalizeOptionalInteger(input.startupHoldTime, "启动 Hold Time", 0, 65535),
    keepaliveTime,
    minKeepaliveTime,
    sendHoldTime: normalizeOptionalInteger(input.sendHoldTime, "Send Hold Time", 0, 65535),
    connectDelayTime: normalizeOptionalInteger(input.connectDelayTime, "连接延迟", 0, 86400),
    connectRetryTime: normalizeOptionalInteger(input.connectRetryTime, "连接重试时间", 1, 86400),
    errorWaitMin,
    errorWaitMax,
    errorForgetTime: normalizeOptionalInteger(input.errorForgetTime, "错误遗忘时间", 1, 86400),
    pathMetric: normalizeEnum(input.pathMetric, SWITCH_SETTINGS, "default", "AS Path 选路设置"),
    medMetric: input.medMetric === true,
    deterministicMed: input.deterministicMed === true,
    igpMetric: normalizeEnum(input.igpMetric, SWITCH_SETTINGS, "default", "IGP Metric 设置"),
    preferOlder: input.preferOlder === true,
    defaultMed: normalizeOptionalInteger(input.defaultMed, "默认 MED"),
    defaultLocalPref: normalizeOptionalInteger(input.defaultLocalPref, "默认 Local Preference"),
    localRole,
    requireRoles,
    raw: normalizeBirdBlockSource(input.raw, "额外 BGP 协议指令"),
  };
}

function normalizeChannelOptions(family: AddressFamily, input: UnknownRecord): Omit<BgpChannel, "enabled" | "importPolicy" | "exportPolicy" | "exportDefineId"> {
  const label = family === "ipv4" ? "IPv4" : "IPv6";
  const nextHopKeep = normalizeEnum(input.nextHopKeep, NEXT_HOP_MODES, "default", "Next Hop Keep 设置");
  const nextHopSelf = normalizeEnum(input.nextHopSelf, NEXT_HOP_MODES, "default", "Next Hop Self 设置");
  assertValidation(
    [nextHopKeep, nextHopSelf].filter((item) => item !== "default" && item !== "off").length <= 1,
    "Next Hop Keep 与 Next Hop Self 不能同时启用",
  );
  const extendedNextHop = input.extendedNextHop === true;
  const requireExtendedNextHop = input.requireExtendedNextHop === true;
  assertValidation(!requireExtendedNextHop || family === "ipv4", "Require Extended Next Hop 只适用于 IPv4 Channel");
  assertValidation(!requireExtendedNextHop || extendedNextHop, "Require Extended Next Hop 需要启用 Extended Next Hop");
  const addPaths = normalizeEnum(input.addPaths, new Set(["off", "on", "rx", "tx"] as const), "off", "Add Paths 设置");
  const requireAddPaths = input.requireAddPaths === true;
  assertValidation(!requireAddPaths || addPaths !== "off", "Require Add Paths 需要启用 Add Paths");
  const minLongLivedStaleTime = normalizeOptionalInteger(input.minLongLivedStaleTime, "Channel 最小 LLGR Stale 时间", 0, MAX_LONG_LIVED_STALE_TIME);
  const maxLongLivedStaleTime = normalizeOptionalInteger(input.maxLongLivedStaleTime, "Channel 最大 LLGR Stale 时间", 0, MAX_LONG_LIVED_STALE_TIME);
  assertValidation(minLongLivedStaleTime === null || maxLongLivedStaleTime === null || minLongLivedStaleTime <= maxLongLivedStaleTime, "Channel LLGR Stale 时间范围必须从小到大");
  return {
    table: normalizeOptionalName(input.table, `${label} 路由表名称`),
    preference: normalizeOptionalInteger(input.preference, "Channel Preference"),
    importKeepFiltered: input.importKeepFiltered === true,
    rpkiReload: normalizeEnum(input.rpkiReload, SWITCH_SETTINGS, "default", "RPKI Reload 设置"),
    importLimit: normalizeLimit(input.importLimit, "Import Limit"),
    receiveLimit: normalizeLimit(input.receiveLimit, "Receive Limit"),
    exportLimit: normalizeLimit(input.exportLimit, "Export Limit"),
    mandatory: input.mandatory === true,
    nextHopKeep,
    nextHopSelf,
    nextHopAddress: input.nextHopAddress === null || input.nextHopAddress === undefined || input.nextHopAddress === ""
      ? null
      : normalizeIPAddress(input.nextHopAddress, "Next Hop 地址"),
    nextHopPrefer: normalizeEnum(input.nextHopPrefer, NEXT_HOP_PREFER_MODES, "default", "Next Hop Prefer 设置"),
    linkLocalNextHopFormat: normalizeEnum(input.linkLocalNextHopFormat, LINK_LOCAL_NEXT_HOP_FORMATS, "default", "Link-local Next Hop 格式"),
    gateway: normalizeEnum(input.gateway, new Set(["default", "direct", "recursive"] as const), "default", "Gateway 模式"),
    igpTable: normalizeOptionalName(input.igpTable, "IGP 路由表名称"),
    importTable: input.importTable === true,
    exportTable: input.exportTable === true,
    secondary: input.secondary === true,
    extendedNextHop,
    requireExtendedNextHop,
    addPaths,
    requireAddPaths,
    aigp: normalizeEnum(input.aigp, new Set(["default", "off", "on", "originate"] as const), "default", "AIGP 设置"),
    cost: normalizeOptionalInteger(input.cost, "Channel Cost", 1),
    gracefulRestart: normalizeEnum(input.gracefulRestart, SWITCH_SETTINGS, "default", "Channel Graceful Restart 设置"),
    longLivedGracefulRestart: normalizeEnum(input.longLivedGracefulRestart, SWITCH_SETTINGS, "default", "Channel LLGR 设置"),
    longLivedStaleTime: normalizeOptionalInteger(input.longLivedStaleTime, "Channel LLGR Stale 时间", 0, MAX_LONG_LIVED_STALE_TIME),
    minLongLivedStaleTime,
    maxLongLivedStaleTime,
    raw: normalizeBirdBlockSource(input.raw, `额外 ${label} Channel 指令`),
  };
}

function normalizeChannel(family: AddressFamily, inputValue: unknown, defaultEnabled: boolean): BgpChannel {
  const input = optionalRecord(inputValue);
  const exportDefineId = input.exportDefineId === null || input.exportDefineId === undefined || input.exportDefineId === ""
    ? null
    : normalizeId(input.exportDefineId, `导出 IPv${family === "ipv4" ? 4 : 6} CIDR Define ID`);
  const importPolicy = normalizePolicy(input.importPolicy, `${family === "ipv4" ? "IPv4" : "IPv6"} 导入策略`, "import");
  const exportPolicyInput = optionalRecord(input.exportPolicy);
  const exportPolicy = normalizePolicy({
    ...exportPolicyInput,
    formAction: exportPolicyInput.formAction ?? (exportDefineId === null ? "none" : "cidr"),
  }, `${family === "ipv4" ? "IPv4" : "IPv6"} 导出策略`, "export");
  assertValidation(exportPolicy.formAction !== "cidr" || exportDefineId !== null, "导出指定 CIDR 模式必须选择 CIDR Define");
  return {
    enabled: input.enabled === undefined ? defaultEnabled : input.enabled === true,
    importPolicy,
    exportPolicy,
    exportDefineId,
    ...normalizeChannelOptions(family, input),
  };
}

export function normalizeSession(inputValue: unknown): BgpSession {
  const input = record(inputValue, "会话参数不能为空");
  const protocolName = String(input.protocolName ?? "").trim();
  assertValidation(NAME_RE.test(protocolName), "协议名称只能包含字母、数字和下划线，且必须以字母或下划线开头");
  assertValidation(!RESERVED_PROTOCOL_NAMES.has(protocolName), "协议名称与 Birdbox 内部协议冲突");
  const legacyIpv4 = {
    ...optionalRecord(input.ipv4),
    enabled: true,
    exportDefineId: input.exportDefineId,
    importPolicy: input.importPolicy,
    exportPolicy: input.exportPolicy,
  };
  const channelInput = input.channels && typeof input.channels === "object" && !Array.isArray(input.channels)
    ? input.channels as UnknownRecord
    : { ipv4: legacyIpv4, ipv6: { enabled: true } };
  const channels: Record<AddressFamily, BgpChannel> = {
    ipv4: normalizeChannel("ipv4", channelInput.ipv4, true),
    ipv6: normalizeChannel("ipv6", channelInput.ipv6, true),
  };
  assertValidation(channels.ipv4.enabled || channels.ipv6.enabled, "IPv4 与 IPv6 Channel 至少启用一个");
  const bgp = normalizeBgpOptions(input.bgp, input.multihop);
  for (const channel of Object.values(channels)) {
    assertValidation(bgp.connectionMode !== "multihop" || channel.gateway !== "direct", "Multihop 会话不能使用 Direct Gateway");
    assertValidation(bgp.capabilities !== "off" || !(channel.mandatory || channel.requireExtendedNextHop || channel.requireAddPaths), "关闭 Capabilities 时不能要求 Channel 能力");
  }
  return {
    id: normalizeId(input.id, "会话 ID"),
    nodeId: normalizeId(input.nodeId, "节点 ID"),
    peerId: normalizeId(input.peerId, "Peer ID"),
    protocolName,
    localAddress: input.localAddress === null || input.localAddress === undefined || input.localAddress === ""
      ? null
      : normalizeIPAddress(input.localAddress, "会话本地地址"),
    localAsn: normalizeAsn(input.localAsn, "会话本地 ASN "),
    localPort: normalizePort(input.localPort, "会话本地端口", RUNTIME.defaultBgpPort),
    bgp,
    channels,
    enabled: input.enabled !== false,
  };
}
