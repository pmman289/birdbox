import { createHash } from "node:crypto";
import net from "node:net";
import type { ChannelPolicy, OspfAreaOptions, OspfDomain, OspfInterfaceOptions, OspfLink, OspfNodeConfig, OspfPasswordOptions, OspfProtocolOptions, OspfVersion, OspfVirtualLink } from "../packages/contracts/src/inventory.js";
import { assertValidation, normalizeId, normalizeLabel } from "./bird-normalize-common.js";

type RecordValue = Record<string, unknown>;
const versions: OspfVersion[] = ["ospfv2", "ospfv3"];

function record(value: unknown, label: string): RecordValue {
  assertValidation(value && typeof value === "object" && !Array.isArray(value), `${label}必须是对象`);
  return value as RecordValue;
}
function policy(value: unknown, defaultAction: "all" | "none"): ChannelPolicy {
  const input = value == null ? {} : record(value, "OSPF 策略");
  const mode = input.mode === "custom" || input.mode === "combined" ? input.mode : "form";
  const formAction = input.formAction === "all" || input.formAction === "none" || input.formAction === "cidr" ? input.formAction : defaultAction;
  const steps = Array.isArray(input.steps) ? input.steps.filter((step) => step && typeof step === "object").map((step) => {
    const item = step as RecordValue;
    if (item.type === "function") {
      const action: "accept" | "reject" | "execute" = item.action === "reject" || item.action === "execute" ? item.action : "accept";
      return { type: "function" as const, functionId: String(item.functionId ?? ""), action };
    }
    return { type: "form" as const };
  }) : [{ type: "form" as const }];
  return { mode, steps, filterId: input.filterId == null ? null : String(input.filterId), formAction };
}

function interfaceOptions(value: unknown, label: string): OspfInterfaceOptions {
  const input = value == null ? {} : record(value, label);
  const options: OspfInterfaceOptions = {
    instanceId: input.instanceId == null || input.instanceId === "" ? null : Number(input.instanceId),
    stub: input.stub === true,
    poll: input.poll == null || input.poll === "" ? null : Number(input.poll),
    retransmit: input.retransmit == null || input.retransmit === "" ? null : Number(input.retransmit),
    transmitDelay: input.transmitDelay == null || input.transmitDelay === "" ? null : Number(input.transmitDelay),
    priority: input.priority == null || input.priority === "" ? null : Number(input.priority),
    wait: input.wait == null || input.wait === "" ? null : Number(input.wait),
    deadMode: input.deadMode === "seconds" ? "seconds" : "count",
    rxBuffer: input.rxBuffer === "large" || input.rxBuffer === "normal" ? input.rxBuffer : (input.rxBuffer == null || input.rxBuffer === "" ? null : Number(input.rxBuffer)),
    txLength: input.txLength == null || input.txLength === "" ? null : Number(input.txLength),
    type: input.type === "broadcast" || input.type === "nbma" || input.type === "ptmp" ? input.type : "ptp",
    linkLsaSuppression: input.linkLsaSuppression === true,
    strictNonbroadcast: input.strictNonbroadcast === true,
    realBroadcast: input.realBroadcast === true,
    ptpNetmask: input.ptpNetmask == null ? false : input.ptpNetmask === true,
    ptpAddress: input.ptpAddress == null ? false : input.ptpAddress === true,
    secondary: input.secondary === true,
    checkLink: input.checkLink == null ? true : input.checkLink === true,
    bfd: input.bfd == null ? undefined : input.bfd === true,
    ecmpWeight: input.ecmpWeight == null || input.ecmpWeight === "" ? null : Number(input.ecmpWeight),
    ttlSecurity: input.ttlSecurity === "on" || input.ttlSecurity === "tx-only" ? input.ttlSecurity : "off",
    txClass: input.txClass == null || input.txClass === "" ? null : Number(input.txClass),
    txDscp: input.txDscp == null || input.txDscp === "" ? null : Number(input.txDscp),
    txPriority: input.txPriority == null || input.txPriority === "" ? null : Number(input.txPriority),
    password: input.password == null ? null : String(input.password),
    passwordOptions: input.passwordOptions && typeof input.passwordOptions === "object" && !Array.isArray(input.passwordOptions) ? { ...(input.passwordOptions as RecordValue) } as OspfPasswordOptions : {},
    neighbors: Array.isArray(input.neighbors) ? input.neighbors.filter((x) => x && typeof x === "object").map((x) => ({ address: String((x as RecordValue).address ?? "").trim(), eligible: (x as RecordValue).eligible === true })).filter((x) => x.address) : [],
  };
  assertValidation(options.instanceId == null || Number.isInteger(options.instanceId) && options.instanceId >= 0 && options.instanceId <= 255, `${label} Instance ID 无效`);
  assertValidation(options.poll == null || Number.isInteger(options.poll) && options.poll >= 1, `${label} Poll 无效`);
  assertValidation(options.retransmit == null || Number.isInteger(options.retransmit) && options.retransmit > 1, `${label} Retransmit 必须大于 1`);
  assertValidation(options.transmitDelay == null || Number.isInteger(options.transmitDelay) && options.transmitDelay >= 1, `${label} Transmit Delay 无效`);
  assertValidation(options.wait == null || Number.isInteger(options.wait) && options.wait > 1, `${label} Wait 必须大于 1`);
  assertValidation(options.txLength == null || Number.isInteger(options.txLength) && options.txLength >= 256 && options.txLength <= 65535, `${label} TX Length 无效`);
  assertValidation(options.priority == null || Number.isInteger(options.priority) && options.priority >= 0 && options.priority <= 255, `${label} Priority 无效`);
  assertValidation(options.ecmpWeight == null || Number.isInteger(options.ecmpWeight) && options.ecmpWeight >= 1 && options.ecmpWeight <= 256, `${label} ECMP 权重无效`);
  assertValidation(options.txClass == null || Number.isInteger(options.txClass) && options.txClass >= 0 && options.txClass <= 255, `${label} TX Class 无效`);
  assertValidation(options.txPriority == null || Number.isInteger(options.txPriority) && options.txPriority >= 0 && options.txPriority <= 7, `${label} TX Priority 无效`);
  assertValidation(options.rxBuffer == null || options.rxBuffer === "normal" || options.rxBuffer === "large" || Number.isInteger(options.rxBuffer) && options.rxBuffer >= 256 && options.rxBuffer <= 65535, `${label} RX Buffer 无效`);
  assertValidation(options.txDscp == null || Number.isInteger(options.txDscp) && options.txDscp >= 0 && options.txDscp <= 63, `${label} TX DSCP 无效`);
  assertValidation(options.type !== "nbma" || (options.neighbors?.length ?? 0) > 0, `${label} NBMA 必须配置至少一个实际邻居地址`);
  for (const neighbor of options.neighbors ?? []) assertValidation(net.isIP(neighbor.address) !== 0, `${label} 邻居地址无效`);
  return options;
}

function sharedInterfaceOptionsSignature(options: OspfInterfaceOptions): string {
  const { neighbors: _neighbors, ...shared } = options;
  return JSON.stringify(shared);
}

const ospfPasswordAlgorithms = new Set(["keyed-md5", "keyed-sha1", "hmac-sha1", "hmac-sha256", "hmac-sha384", "hmac-sha512"]);

function validatePasswordOptions(options: OspfPasswordOptions, label: string): void {
  assertValidation(options.id == null || Number.isInteger(options.id) && options.id >= 0 && options.id <= 255, `${label} Key ID 无效`);
  assertValidation(options.algorithm == null || ospfPasswordAlgorithms.has(String(options.algorithm)), `${label} 认证算法无效`);
  const times: Partial<Record<"generateFrom" | "generateTo" | "acceptFrom" | "acceptTo" | "from" | "to", number>> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === "id" || key === "algorithm" || value == null || value === "") continue;
    assertValidation(typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value), `${label} 时间字段无效`);
    assertValidation(/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(value), `${label} 时间字段格式无效`);
    const timestamp = Date.parse(`${value}Z`);
    assertValidation(Number.isFinite(timestamp), `${label} 时间字段无效`);
    assertValidation(new Date(timestamp).toISOString().slice(0, 19).replace("T", " ") === value, `${label} 时间字段无效`);
    if (key === "generateFrom" || key === "generateTo" || key === "acceptFrom" || key === "acceptTo" || key === "from" || key === "to") {
      times[key] = timestamp;
    }
  }
  for (const [from, to] of [["generateFrom", "generateTo"], ["acceptFrom", "acceptTo"], ["from", "to"]] as const) {
    assertValidation(times[from] == null || times[to] == null || times[from]! <= times[to]!, `${label} 时间窗口顺序无效`);
  }
}

function validatePasswordForVersion(options: OspfPasswordOptions, authentication: string, versions: OspfVersion[], label: string): void {
  validatePasswordOptions(options, label);
  if (authentication === "simple") assertValidation(options.algorithm == null, `${label} Simple 认证不能配置算法`);
  if (versions.includes("ospfv3")) {
    assertValidation(options.algorithm == null || String(options.algorithm).startsWith("hmac-"), `${label} OSPFv3 只能使用 HMAC 算法`);
  }
}

export function ospfLinkOptions(link: OspfLink, nodeId: string): OspfInterfaceOptions {
  return (link.fromNodeId === nodeId ? link.localOptions : link.remoteOptions) ?? link.options ?? { type: "ptp", checkLink: true, deadMode: "count", ttlSecurity: "off", neighbors: [] };
}

function nodeConfig(value: unknown, index: number): OspfNodeConfig {
  const input = record(value, `OSPF 节点配置 ${index + 1}`);
  const configEnabled = input.enabled !== false;
  const selected = Array.isArray(input.versions) ? input.versions.filter((v): v is OspfVersion => versions.includes(v as OspfVersion)) : ["ospfv2" as OspfVersion];
  const uniqueVersions = [...new Set(selected)] as OspfVersion[];
  assertValidation(uniqueVersions.length > 0, `OSPF 节点配置 ${index + 1} 至少启用一个协议版本`);
  const imports = input.importPolicies == null ? {} : record(input.importPolicies, "OSPF 导入策略");
  const exports = input.exportPolicies == null ? {} : record(input.exportPolicies, "OSPF 导出策略");
  const exportIds = input.exportDefineIds == null ? {} : record(input.exportDefineIds, "OSPF 导出 Define");
  const protocolInput = input.protocolOptions && typeof input.protocolOptions === "object" && !Array.isArray(input.protocolOptions) ? input.protocolOptions as RecordValue : {};
  const routerId = input.routerId == null || String(input.routerId).trim() === "" ? null : String(input.routerId).trim();
  assertValidation(routerId === null || net.isIP(routerId) === 4, `OSPF 节点配置 ${index + 1} Router ID 必须是有效的 IPv4 地址`);
  const protocolOptions: OspfProtocolOptions = {
    rfc1583compat: protocolInput.rfc1583compat === true,
    rfc5838: protocolInput.rfc5838 !== false,
    instanceId: protocolInput.instanceId == null || protocolInput.instanceId === "" ? null : Number(protocolInput.instanceId),
    stubRouter: protocolInput.stubRouter === true,
    tick: protocolInput.tick == null || protocolInput.tick === "" ? null : Number(protocolInput.tick),
    ecmp: protocolInput.ecmp == null ? null : protocolInput.ecmp === true,
    ecmpLimit: protocolInput.ecmpLimit == null || protocolInput.ecmpLimit === "" ? null : Number(protocolInput.ecmpLimit),
    mergeExternal: protocolInput.mergeExternal === true,
    gracefulRestartMode: protocolInput.gracefulRestartMode === "off" || protocolInput.gracefulRestartMode === "aware" ? protocolInput.gracefulRestartMode : (protocolInput.gracefulRestartMode === "on" ? "on" : (input.gracefulRestart === true ? "on" : "aware")),
    gracefulRestartTime: protocolInput.gracefulRestartTime == null || protocolInput.gracefulRestartTime === "" ? null : Number(protocolInput.gracefulRestartTime),
  };
  assertValidation(protocolOptions.instanceId == null || Number.isInteger(protocolOptions.instanceId) && protocolOptions.instanceId >= 0 && protocolOptions.instanceId <= 255, `OSPF 节点配置 ${index + 1} Instance ID 无效`);
  assertValidation(protocolOptions.tick == null || Number.isInteger(protocolOptions.tick) && protocolOptions.tick >= 1, `OSPF 节点配置 ${index + 1} Tick 无效`);
  assertValidation(protocolOptions.ecmpLimit == null || Number.isInteger(protocolOptions.ecmpLimit) && protocolOptions.ecmpLimit >= 1, `OSPF 节点配置 ${index + 1} ECMP 限制无效`);
  assertValidation(protocolOptions.gracefulRestartTime == null || Number.isInteger(protocolOptions.gracefulRestartTime) && protocolOptions.gracefulRestartTime >= 1 && protocolOptions.gracefulRestartTime <= 1800, `OSPF 节点配置 ${index + 1} Graceful Restart 时间无效`);
  if (configEnabled && uniqueVersions.includes("ospfv3") && protocolOptions.rfc5838) {
    assertValidation(protocolOptions.instanceId == null || protocolOptions.instanceId <= 31, `OSPF 节点配置 ${index + 1} OSPFv3 Instance ID 必须在 0-31 范围内`);
  }
  const areaInput = input.areaOptions && typeof input.areaOptions === "object" && !Array.isArray(input.areaOptions) ? input.areaOptions as RecordValue : {};
  const areaOptions: Record<string, OspfAreaOptions> = {};
  for (const [area, raw] of Object.entries(areaInput)) {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as RecordValue : {};
    const list = (key: string) => Array.isArray(item[key]) ? (item[key] as unknown[]).filter((x) => x && typeof x === "object").map((x) => x as RecordValue) : [];
    areaOptions[area] = {
      stub: item.stub === true,
      nssa: item.nssa === true,
      summary: item.summary == null ? null : item.summary === true,
      defaultNssa: item.defaultNssa === true,
      defaultCost: item.defaultCost == null || item.defaultCost === "" ? null : Number(item.defaultCost),
      defaultCost2: item.defaultCost2 == null || item.defaultCost2 === "" ? null : Number(item.defaultCost2),
      translator: item.translator === true,
      translatorStability: item.translatorStability == null || item.translatorStability === "" ? null : Number(item.translatorStability),
      networks: list("networks").map((x) => ({ prefix: String(x.prefix ?? "").trim(), hidden: x.hidden === true })).filter((x) => x.prefix),
      external: list("external").map((x) => ({ prefix: String(x.prefix ?? "").trim(), hidden: x.hidden === true, tag: x.tag == null || x.tag === "" ? null : Number(x.tag) })).filter((x) => x.prefix),
      stubnets: list("stubnets").map((x) => ({ prefix: String(x.prefix ?? "").trim(), hidden: x.hidden === true, summary: x.summary === true, cost: x.cost == null || x.cost === "" ? null : Number(x.cost) })).filter((x) => x.prefix),
    };
    assertValidation(net.isIP(area) === 4, `OSPF Area ${area} 必须是 IPv4 Area ID`);
    assertValidation(!(areaOptions[area]!.stub && areaOptions[area]!.nssa), `OSPF Area ${area} 不能同时配置 Stub 和 NSSA`);
    assertValidation(area !== "0.0.0.0" || (!areaOptions[area]!.stub && !areaOptions[area]!.nssa), "OSPF Backbone Area 不能配置 Stub 或 NSSA");
    assertValidation(areaOptions[area]!.summary !== true || areaOptions[area]!.stub || areaOptions[area]!.nssa, `OSPF Area ${area} 的 Summary 仅适用于 Stub 或 NSSA Area`);
    for (const [label, value] of [["Default Cost", areaOptions[area]!.defaultCost], ["Default Cost2", areaOptions[area]!.defaultCost2]] as const) {
      assertValidation(value == null || Number.isInteger(value) && value >= 1 && value <= 16777214, `OSPF Area ${area} ${label} 无效`);
    }
    assertValidation(areaOptions[area]!.defaultCost2 == null || areaOptions[area]!.nssa || areaOptions[area]!.defaultNssa, `OSPF Area ${area} 的 Default Cost2 仅适用于 NSSA 默认路由`);
    assertValidation(!areaOptions[area]!.defaultNssa || areaOptions[area]!.nssa, `OSPF Area ${area} 的 Default NSSA 仅适用于 NSSA Area`);
    assertValidation(!areaOptions[area]!.defaultNssa || areaOptions[area]!.summary === true, `OSPF Area ${area} 的 Default NSSA 需要启用 Summary`);
    assertValidation(areaOptions[area]!.translatorStability == null || Number.isInteger(areaOptions[area]!.translatorStability) && areaOptions[area]!.translatorStability >= 1 && areaOptions[area]!.translatorStability <= 65535, `OSPF Area ${area} Translator Stability 无效`);
    for (const item of [...(areaOptions[area]!.networks ?? []), ...(areaOptions[area]!.external ?? []), ...(areaOptions[area]!.stubnets ?? [])]) {
      const [address, length] = item.prefix.split("/");
      const family = net.isIP(address ?? "");
      assertValidation((family === 4 || family === 6) && length !== undefined && /^\d+$/.test(length) && Number(length) <= (family === 4 ? 32 : 128), `OSPF Area ${area} 前缀无效`);
    }
    for (const external of areaOptions[area]!.external ?? []) {
      // BIRD's area external syntax accepts either `hidden` or `tag`, but
      // does not accept both modifiers on the same prefix. Reject the
      // ambiguous combination before it can reach a deployment preflight.
      assertValidation(!(external.hidden && external.tag != null), `OSPF Area ${area} External 前缀不能同时配置 Hidden 和 Tag`);
      assertValidation(external.tag == null || Number.isInteger(external.tag) && external.tag >= 0 && external.tag <= 4294967295, `OSPF Area ${area} External Tag 无效`);
    }
    for (const stubnet of areaOptions[area]!.stubnets ?? []) assertValidation(stubnet.cost == null || Number.isInteger(stubnet.cost) && stubnet.cost >= 1 && stubnet.cost <= 16777215, `OSPF Area ${area} Stubnet Cost 无效`);
  }
  const virtualLinks: OspfVirtualLink[] = (Array.isArray(input.virtualLinks) ? input.virtualLinks : []).filter((x) => x && typeof x === "object").map((x, i) => {
    const item = x as RecordValue;
    const id = String(item.id ?? "").trim();
    assertValidation(id.length > 0, `OSPF 虚链路 ${i + 1} Router ID 不能为空`);
    const area = String(item.area ?? "0.0.0.0").trim();
    assertValidation(net.isIP(id) === 4 && net.isIP(area) === 4 && area !== "0.0.0.0", `OSPF 虚链路 ${i + 1} Router ID 和传输 Area 必须是非 Backbone IPv4 地址`);
    const passwordOptions: OspfPasswordOptions = item.passwordOptions && typeof item.passwordOptions === "object" && !Array.isArray(item.passwordOptions) ? { ...(item.passwordOptions as RecordValue) } as OspfPasswordOptions : {};
    validatePasswordOptions(passwordOptions, `OSPF 虚链路 ${i + 1}`);
    const result: OspfVirtualLink = { id, area, instanceId: item.instanceId == null || item.instanceId === "" ? null : Number(item.instanceId), hello: item.hello == null || item.hello === "" ? null : Number(item.hello), retransmit: item.retransmit == null || item.retransmit === "" ? null : Number(item.retransmit), wait: item.wait == null || item.wait === "" ? null : Number(item.wait), dead: item.dead == null || item.dead === "" ? null : Number(item.dead), authentication: item.authentication === "simple" || item.authentication === "cryptographic" ? item.authentication : "none", password: item.password == null ? null : String(item.password), passwordOptions };
    assertValidation(result.hello == null || Number.isInteger(result.hello) && result.hello >= 1 && result.hello <= 65535, `OSPF 虚链路 ${i + 1} Hello 无效`);
    for (const [label, value] of [["Retransmit", result.retransmit], ["Wait", result.wait], ["Dead", result.dead]] as const) {
      assertValidation(value == null || Number.isInteger(value) && value > 1 && value <= 65535, `OSPF 虚链路 ${i + 1} ${label} 必须大于 1`);
    }
    assertValidation(result.instanceId == null || Number.isInteger(result.instanceId) && result.instanceId >= 0 && result.instanceId <= 255, `OSPF 虚链路 ${i + 1} Instance ID 无效`);
    if (configEnabled && result.authentication && result.authentication !== "none") {
      assertValidation(Boolean(result.password), `OSPF 虚链路 ${i + 1} 启用认证时必须配置密码`);
      validatePasswordForVersion(passwordOptions, result.authentication, uniqueVersions, `OSPF 虚链路 ${i + 1}`);
    }
    return result;
  });
  assertValidation(new Set(virtualLinks.map((link) => `${link.id}:${link.area}`)).size === virtualLinks.length, "OSPF 虚链路不能重复");
  if (configEnabled && uniqueVersions.includes("ospfv3")) {
    for (const [index, link] of virtualLinks.entries()) {
      assertValidation(link.authentication !== "simple", `OSPF 虚链路 ${index + 1} 在 OSPFv3 中不能使用 Simple 认证`);
    }
  }
  return {
    nodeId: normalizeId(input.nodeId, "OSPF 节点 ID"),
    enabled: input.enabled !== false,
    versions: uniqueVersions,
    routerId,
    importPolicies: (() => {
      const result = { ospfv2: policy(imports.ospfv2, "all"), ospfv3: policy(imports.ospfv3, "all") };
      assertValidation(result.ospfv2.formAction !== "cidr" && result.ospfv3.formAction !== "cidr", `OSPF 节点配置 ${index + 1} 导入策略不支持 CIDR Define`);
      return result;
    })(),
    exportPolicies: { ospfv2: policy(exports.ospfv2, "none"), ospfv3: policy(exports.ospfv3, "none") },
    exportDefineIds: { ospfv2: exportIds.ospfv2 == null ? null : String(exportIds.ospfv2), ospfv3: exportIds.ospfv3 == null ? null : String(exportIds.ospfv3) },
    bfd: input.bfd === true,
    gracefulRestart: input.gracefulRestart === true,
    redistributeStatic: input.redistributeStatic === true,
    protocolOptions,
    areaOptions,
    virtualLinks,
  };
}

export function normalizeOspfDomain(inputValue: unknown): OspfDomain {
  const input = record(inputValue, "OSPF 域参数不能为空");
  const nodeConfigs = (Array.isArray(input.nodeConfigs) ? input.nodeConfigs : []).map(nodeConfig);
  assertValidation(new Set(nodeConfigs.map((item) => item.nodeId)).size === nodeConfigs.length, "OSPF 域节点配置不能重复");
  const links: OspfLink[] = (Array.isArray(input.links) ? input.links : []).map((value, index) => {
    const item = record(value, `OSPF 链路 ${index + 1}`);
    const cost = Number(item.cost ?? 10); const hello = Number(item.hello ?? 10); const dead = Number(item.dead ?? 40);
    assertValidation(Number.isInteger(cost) && cost >= 1 && cost <= 65535, `OSPF 链路 ${index + 1} Cost 无效`);
    assertValidation(Number.isInteger(hello) && hello >= 1 && hello <= 65535, `OSPF 链路 ${index + 1} Hello 无效`);
    assertValidation(Number.isInteger(dead) && dead >= hello && dead <= 65535, `OSPF 链路 ${index + 1} Dead 无效`);
    const authentication = item.authentication === "simple" || item.authentication === "md5" || item.authentication === "ipsec" ? item.authentication : "none";
    // Keep the legacy IPsec value readable so an older inventory can still
    // load and be edited. The renderer rejects it before deployment because
    // BIRD has no corresponding OSPF directive; this avoids silently
    // downgrading an existing authenticated link to cryptographic/none.
    const legacyOptions = item.options && typeof item.options === "object" && !Array.isArray(item.options) ? item.options : null;
    const localOptions = interfaceOptions(item.localOptions ?? legacyOptions, `OSPF 链路 ${index + 1} 本端接口`);
    const remoteOptions = interfaceOptions(item.remoteOptions ?? legacyOptions, `OSPF 链路 ${index + 1} 对端接口`);
    const fromConfig = nodeConfigs.find((config) => config.nodeId === String(item.fromNodeId ?? item.from));
    const toConfig = nodeConfigs.find((config) => config.nodeId === String(item.toNodeId ?? item.to));
    assertValidation(fromConfig && toConfig, `OSPF 链路 ${index + 1} 的链路两端节点必须加入当前域`);
    if (fromConfig?.enabled !== false && fromConfig?.versions.includes("ospfv3") && fromConfig.protocolOptions?.rfc5838 !== false) {
      assertValidation(localOptions.instanceId == null || localOptions.instanceId <= 31, `OSPF 链路 ${index + 1} 本端 OSPFv3 Instance ID 必须在 0-31 范围内`);
    }
    if (toConfig?.enabled !== false && toConfig?.versions.includes("ospfv3") && toConfig.protocolOptions?.rfc5838 !== false) {
      assertValidation(remoteOptions.instanceId == null || remoteOptions.instanceId <= 31, `OSPF 链路 ${index + 1} 对端 OSPFv3 Instance ID 必须在 0-31 范围内`);
    }
    if (authentication !== "none") {
      if (fromConfig?.enabled !== false) validatePasswordForVersion(localOptions.passwordOptions ?? {}, authentication, fromConfig!.versions, `OSPF 链路 ${index + 1} 本端`);
      if (toConfig?.enabled !== false) validatePasswordForVersion(remoteOptions.passwordOptions ?? {}, authentication, toConfig!.versions, `OSPF 链路 ${index + 1} 对端`);
    }
    for (const [label, options] of [["本端", localOptions], ["对端", remoteOptions]] as const) {
      if (options.deadMode === "count") {
        assertValidation(dead % hello === 0 && dead / hello > 1, `OSPF 链路 ${index + 1} ${label} Dead 必须是 Hello 的整数倍且 Count 大于 1`);
      } else {
        assertValidation(dead > 1, `OSPF 链路 ${index + 1} ${label} Dead 必须大于 1`);
      }
    }
    if (authentication !== "none") {
      const endpointEnabled = (nodeId: string) => nodeConfigs.find((config) => config.nodeId === nodeId)?.enabled !== false;
      assertValidation(!endpointEnabled(String(item.fromNodeId ?? item.from)) || Boolean(localOptions.password), `OSPF 链路 ${index + 1} 启用认证时必须配置本端密码`);
      assertValidation(!endpointEnabled(String(item.toNodeId ?? item.to)) || Boolean(remoteOptions.password), `OSPF 链路 ${index + 1} 启用认证时必须配置对端密码`);
    }
    if (authentication === "simple" && ((fromConfig?.enabled !== false && fromConfig?.versions.includes("ospfv3")) || (toConfig?.enabled !== false && toConfig?.versions.includes("ospfv3")))) {
      assertValidation(false, `OSPF 链路 ${index + 1} 在 OSPFv3 中不能使用 Simple 认证`);
    }
    const validateNeighborFamily = (
      options: OspfInterfaceOptions,
      config: OspfNodeConfig | undefined,
      label: string,
    ): void => {
      if (!config || config.enabled === false) return;
      if (options.type !== "nbma" && options.type !== "ptmp") return;
      for (const version of config.versions) {
        const family = version === "ospfv2" ? 4 : 6;
        const matching = (options.neighbors ?? []).filter((neighbor) => net.isIP(neighbor.address) === family);
        // BIRD accepts an address from the other family syntactically, but it
        // can never form an adjacency for that protocol. Reject that silent
        // failure and require one address of the configured family for NBMA.
        assertValidation(
          (options.neighbors?.length ?? 0) === 0 || matching.length > 0,
          `${label} ${version} 邻居地址必须使用${family === 4 ? "IPv4" : "IPv6"}`,
        );
        assertValidation(
          options.type !== "nbma" || matching.length > 0,
          `${label} ${version} NBMA 必须配置至少一个${family === 4 ? "IPv4" : "IPv6"}邻居地址`,
        );
      }
    };
    validateNeighborFamily(localOptions, fromConfig, `OSPF 链路 ${index + 1} 本端`);
    validateNeighborFamily(remoteOptions, toConfig, `OSPF 链路 ${index + 1} 对端`);
    return {
      id: normalizeId(item.id, `OSPF 链路 ${index + 1} ID`),
      fromNodeId: normalizeId(item.fromNodeId ?? item.from, "OSPF 链路本端节点"),
      toNodeId: normalizeId(item.toNodeId ?? item.to, "OSPF 链路对端节点"),
      area: String(item.area ?? "0.0.0.0").trim(),
      localInterface: String(item.localInterface ?? "").trim(),
      remoteInterface: String(item.remoteInterface ?? "").trim(),
      cost, hello, dead, passive: item.passive === true || item.mode === "passive", authentication,
      options: localOptions,
      localOptions,
      remoteOptions,
    };
  });
  const areasByNode = new Map<string, Set<string>>();
  for (const config of nodeConfigs) areasByNode.set(config.nodeId, new Set(Object.keys(config.areaOptions ?? {})));
  for (const link of links) {
    areasByNode.get(link.fromNodeId)?.add(link.area);
    areasByNode.get(link.toNodeId)?.add(link.area);
  }
  for (const config of nodeConfigs) {
    if (!config.virtualLinks?.length) continue;
    assertValidation(areasByNode.get(config.nodeId)?.has("0.0.0.0") === true, `OSPF 节点 ${config.nodeId} 配置虚链路时必须配置 Backbone Area 0.0.0.0`);
  }
  const layoutInput = input.layout && typeof input.layout === "object" && !Array.isArray(input.layout) ? input.layout as RecordValue : {};
  const nodeConfigIds = new Set(nodeConfigs.map((config) => config.nodeId));
  // Layout is auxiliary UI state. Drop coordinates for nodes no longer in the
  // domain so stale entries cannot make an otherwise valid inventory unreadable.
  const layout = Object.fromEntries(Object.entries(layoutInput).flatMap(([id, value]) => {
    if (!nodeConfigIds.has(id) || !value || typeof value !== "object" || Array.isArray(value)) return [];
    const position = value as RecordValue;
    const x = Number(position.x ?? 0);
    const y = Number(position.y ?? 0);
    // Layout is UI-only state. Ignore malformed coordinates instead of
    // persisting NaN/Infinity, which JSON serializes as null and can break
    // topology rendering on the next load.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    return [[id, { x: Math.round(x), y: Math.round(y), locked: position.locked === true }]];
  }));
  assertValidation(new Set(links.map((item) => item.id)).size === links.length, "OSPF 链路 ID 重复");
  const pairCosts = new Map<string, number>();
  const usedInterfaces = new Map<string, OspfLink>();
  for (const link of links) {
    assertValidation(link.fromNodeId !== link.toNodeId, "OSPF 链路不能连接同一节点");
    assertValidation(link.localInterface && link.remoteInterface, "OSPF 链路必须配置两端接口");
    assertValidation(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(link.localInterface) && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(link.remoteInterface), `OSPF 链路 ${link.id} 接口名称无效`);
    assertValidation(net.isIP(link.area) === 4, `OSPF 链路 ${link.id} Area 必须是 IPv4 Area ID`);
    const pair = [link.fromNodeId, link.toNodeId].sort().join(":");
    const knownCost = pairCosts.get(pair); assertValidation(knownCost === undefined || knownCost === link.cost, `OSPF 节点对 ${pair} 的 Cost 必须一致`); pairCosts.set(pair, link.cost);
    const endpointEntries: Array<[string, OspfInterfaceOptions, OspfLink]> = [
      [`${link.fromNodeId}:${link.localInterface}`, link.localOptions ?? link.options ?? {}, link],
      [`${link.toNodeId}:${link.remoteInterface}`, link.remoteOptions ?? link.options ?? {}, link],
    ];
    for (const [key, currentOptions, current] of endpointEntries) {
      const previous = usedInterfaces.get(key);
      if (!previous) {
        usedInterfaces.set(key, { ...current, options: currentOptions });
        continue;
      }
      const previousOptions = previous.options ?? {};
      // A shared interface is valid for NBMA/PtMP where each neighbor is
      // represented inside one BIRD interface block. Other network types
      // would produce ambiguous per-interface parameters.
      assertValidation(
        (previousOptions.type === "nbma" || previousOptions.type === "ptmp") &&
        (currentOptions.type === "nbma" || currentOptions.type === "ptmp") &&
        previous.area === current.area && previous.cost === current.cost &&
        previous.hello === current.hello && previous.dead === current.dead &&
        previous.passive === current.passive && previous.authentication === current.authentication,
        `OSPF 接口 ${key} 只能在 NBMA/PtMP 同参数链路间复用`,
      );
      assertValidation(sharedInterfaceOptionsSignature(previousOptions) === sharedInterfaceOptionsSignature(currentOptions), `OSPF 接口 ${key} 的共享链路高级参数必须一致`);
    }
  }
  return { id: normalizeId(input.id, "OSPF 域 ID"), name: normalizeLabel(input.name, "OSPF 域名称"), nodeConfigs, links, layout };
}

export function ospfDomainNodeIds(domain: OspfDomain): string[] {
  return [...new Set([...domain.nodeConfigs.map((item) => item.nodeId), ...domain.links.flatMap((item) => [item.fromNodeId, item.toNodeId])])];
}

/**
 * Return whether an enabled node config would have at least one BIRD OSPF
 * area to render. BIRD rejects an OSPF protocol block with no areas, so this
 * predicate is shared by the renderer and inventory symbol validation.
 */
export function ospfNodeHasAreas(domain: OspfDomain, nodeId: string): boolean {
  const config = domain.nodeConfigs.find((item) => item.nodeId === nodeId);
  if (!config || !config.enabled) return false;
  return Object.keys(config.areaOptions ?? {}).length > 0
    || domain.links.some((link) => link.fromNodeId === nodeId || link.toNodeId === nodeId)
    || (config.virtualLinks?.length ?? 0) > 0;
}

export function ospfProtocolName(domain: OspfDomain, version: OspfVersion): string {
  const base = `birdbox_ospf_${domain.id}_${version}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (base.length <= 60) return base;
  const suffix = `${version === "ospfv2" ? "v2" : "v3"}_${createHash("sha256").update(`${domain.id}:${version}`).digest("hex").slice(0, 8)}`;
  return `${base.slice(0, 60 - suffix.length - 1)}_${suffix}`;
}
