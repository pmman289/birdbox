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
  const input = record(value, "OSPF 策略");
  const mode = input.mode === "custom" || input.mode === "combined" ? input.mode : "form";
  const formAction = input.formAction === "none" || input.formAction === "cidr" ? input.formAction : defaultAction;
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
function nodeConfig(value: unknown, index: number): OspfNodeConfig {
  const input = record(value, `OSPF 节点配置 ${index + 1}`);
  const selected = Array.isArray(input.versions) ? input.versions.filter((v): v is OspfVersion => versions.includes(v as OspfVersion)) : ["ospfv2" as OspfVersion];
  const uniqueVersions = [...new Set(selected)] as OspfVersion[];
  assertValidation(uniqueVersions.length > 0, `OSPF 节点配置 ${index + 1} 至少启用一个协议版本`);
  const imports = record(input.importPolicies, "OSPF 导入策略");
  const exports = record(input.exportPolicies, "OSPF 导出策略");
  const exportIds = record(input.exportDefineIds, "OSPF 导出 Define");
  const protocolInput = input.protocolOptions && typeof input.protocolOptions === "object" && !Array.isArray(input.protocolOptions) ? input.protocolOptions as RecordValue : {};
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
  assertValidation(protocolOptions.gracefulRestartTime == null || Number.isInteger(protocolOptions.gracefulRestartTime) && protocolOptions.gracefulRestartTime >= 1, `OSPF 节点配置 ${index + 1} Graceful Restart 时间无效`);
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
    assertValidation(area !== "0.0.0.0" || (!areaOptions[area]!.stub && !areaOptions[area]!.nssa), "OSPF Backbone Area 不能配置 Stub 或 NSSA");
    for (const item of [...(areaOptions[area]!.networks ?? []), ...(areaOptions[area]!.external ?? []), ...(areaOptions[area]!.stubnets ?? [])]) {
      const [address, length] = item.prefix.split("/");
      assertValidation(net.isIP(address ?? "") === 4 && length !== undefined && /^\d+$/.test(length) && Number(length) <= 32, `OSPF Area ${area} 前缀无效`);
    }
    for (const external of areaOptions[area]!.external ?? []) assertValidation(external.tag == null || Number.isInteger(external.tag) && external.tag >= 0 && external.tag <= 4294967295, `OSPF Area ${area} External Tag 无效`);
    for (const stubnet of areaOptions[area]!.stubnets ?? []) assertValidation(stubnet.cost == null || Number.isInteger(stubnet.cost) && stubnet.cost >= 1 && stubnet.cost <= 16777215, `OSPF Area ${area} Stubnet Cost 无效`);
  }
  const virtualLinks: OspfVirtualLink[] = (Array.isArray(input.virtualLinks) ? input.virtualLinks : []).filter((x) => x && typeof x === "object").map((x, i) => {
    const item = x as RecordValue;
    const id = String(item.id ?? "").trim();
    assertValidation(id.length > 0, `OSPF 虚链路 ${i + 1} Router ID 不能为空`);
    const area = String(item.area ?? "0.0.0.0").trim();
    assertValidation(net.isIP(id) === 4 && net.isIP(area) === 4 && area !== "0.0.0.0", `OSPF 虚链路 ${i + 1} Router ID 和传输 Area 必须是非 Backbone IPv4 地址`);
    const passwordOptions: OspfPasswordOptions = item.passwordOptions && typeof item.passwordOptions === "object" && !Array.isArray(item.passwordOptions) ? { ...(item.passwordOptions as RecordValue) } as OspfPasswordOptions : {};
    const result: OspfVirtualLink = { id, area, instanceId: item.instanceId == null || item.instanceId === "" ? null : Number(item.instanceId), hello: item.hello == null || item.hello === "" ? null : Number(item.hello), retransmit: item.retransmit == null || item.retransmit === "" ? null : Number(item.retransmit), wait: item.wait == null || item.wait === "" ? null : Number(item.wait), dead: item.dead == null || item.dead === "" ? null : Number(item.dead), authentication: item.authentication === "simple" || item.authentication === "cryptographic" ? item.authentication : "none", password: item.password == null ? null : String(item.password), passwordOptions };
    for (const value of [result.hello, result.retransmit, result.wait, result.dead]) assertValidation(value == null || Number.isInteger(value) && value >= 1 && value <= 65535, `OSPF 虚链路 ${i + 1} 时间参数无效`);
    assertValidation(result.instanceId == null || Number.isInteger(result.instanceId) && result.instanceId >= 0 && result.instanceId <= 255, `OSPF 虚链路 ${i + 1} Instance ID 无效`);
    return result;
  });
  return {
    nodeId: normalizeId(input.nodeId, "OSPF 节点 ID"),
    enabled: input.enabled !== false,
    versions: uniqueVersions,
    routerId: input.routerId == null || String(input.routerId).trim() === "" ? null : String(input.routerId).trim(),
    importPolicies: { ospfv2: policy(imports.ospfv2, "all"), ospfv3: policy(imports.ospfv3, "all") },
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
    const optionsInput = item.options && typeof item.options === "object" && !Array.isArray(item.options) ? item.options as RecordValue : {};
    const options: OspfInterfaceOptions = {
      instanceId: optionsInput.instanceId == null || optionsInput.instanceId === "" ? null : Number(optionsInput.instanceId),
      stub: optionsInput.stub === true,
      poll: optionsInput.poll == null || optionsInput.poll === "" ? null : Number(optionsInput.poll),
      retransmit: optionsInput.retransmit == null || optionsInput.retransmit === "" ? null : Number(optionsInput.retransmit),
      transmitDelay: optionsInput.transmitDelay == null || optionsInput.transmitDelay === "" ? null : Number(optionsInput.transmitDelay),
      priority: optionsInput.priority == null || optionsInput.priority === "" ? null : Number(optionsInput.priority),
      wait: optionsInput.wait == null || optionsInput.wait === "" ? null : Number(optionsInput.wait),
      deadMode: optionsInput.deadMode === "seconds" ? "seconds" : "count",
      rxBuffer: optionsInput.rxBuffer === "large" || optionsInput.rxBuffer === "normal" ? optionsInput.rxBuffer : (optionsInput.rxBuffer == null || optionsInput.rxBuffer === "" ? null : Number(optionsInput.rxBuffer)),
      txLength: optionsInput.txLength == null || optionsInput.txLength === "" ? null : Number(optionsInput.txLength),
      type: optionsInput.type === "broadcast" || optionsInput.type === "nbma" || optionsInput.type === "ptmp" ? optionsInput.type : (optionsInput.type === "ptp" ? "ptp" : undefined),
      linkLsaSuppression: optionsInput.linkLsaSuppression === true,
      strictNonbroadcast: optionsInput.strictNonbroadcast === true,
      realBroadcast: optionsInput.realBroadcast === true,
      ptpNetmask: optionsInput.ptpNetmask == null ? false : optionsInput.ptpNetmask === true,
      ptpAddress: optionsInput.ptpAddress == null ? false : optionsInput.ptpAddress === true,
      secondary: optionsInput.secondary === true,
      checkLink: optionsInput.checkLink == null ? true : optionsInput.checkLink === true,
      bfd: optionsInput.bfd == null ? undefined : optionsInput.bfd === true,
      ecmpWeight: optionsInput.ecmpWeight == null || optionsInput.ecmpWeight === "" ? null : Number(optionsInput.ecmpWeight),
      ttlSecurity: optionsInput.ttlSecurity === "on" || optionsInput.ttlSecurity === "tx-only" ? optionsInput.ttlSecurity : "off",
      txClass: optionsInput.txClass == null || optionsInput.txClass === "" ? null : Number(optionsInput.txClass),
      txDscp: optionsInput.txDscp == null || optionsInput.txDscp === "" ? null : Number(optionsInput.txDscp),
      txPriority: optionsInput.txPriority == null || optionsInput.txPriority === "" ? null : Number(optionsInput.txPriority),
      password: optionsInput.password == null ? null : String(optionsInput.password),
      passwordOptions: optionsInput.passwordOptions && typeof optionsInput.passwordOptions === "object" && !Array.isArray(optionsInput.passwordOptions) ? { ...(optionsInput.passwordOptions as RecordValue) } as OspfPasswordOptions : {},
      neighbors: Array.isArray(optionsInput.neighbors) ? optionsInput.neighbors.filter((x) => x && typeof x === "object").map((x) => ({ address: String((x as RecordValue).address ?? "").trim(), eligible: (x as RecordValue).eligible === true })).filter((x) => x.address) : [],
    };
    assertValidation(options.instanceId == null || Number.isInteger(options.instanceId) && options.instanceId >= 0 && options.instanceId <= 255, `OSPF 链路 ${index + 1} Instance ID 无效`);
    for (const value of [options.poll, options.retransmit, options.transmitDelay, options.wait, options.txLength]) assertValidation(value == null || Number.isInteger(value) && value >= 1, `OSPF 链路 ${index + 1} 时间或长度参数无效`);
    assertValidation(options.priority == null || Number.isInteger(options.priority) && options.priority >= 0 && options.priority <= 255, `OSPF 链路 ${index + 1} Priority 无效`);
    assertValidation(options.ecmpWeight == null || Number.isInteger(options.ecmpWeight) && options.ecmpWeight >= 1 && options.ecmpWeight <= 256, `OSPF 链路 ${index + 1} ECMP 权重无效`);
    assertValidation(options.txClass == null || Number.isInteger(options.txClass) && options.txClass >= 0 && options.txClass <= 255, `OSPF 链路 ${index + 1} TX Class 无效`);
    assertValidation(options.txPriority == null || Number.isInteger(options.txPriority) && options.txPriority >= 0 && options.txPriority <= 7, `OSPF 链路 ${index + 1} TX Priority 无效`);
    assertValidation(options.rxBuffer == null || options.rxBuffer === "normal" || options.rxBuffer === "large" || Number.isInteger(options.rxBuffer) && options.rxBuffer >= 256, `OSPF 链路 ${index + 1} RX Buffer 无效`);
    for (const neighbor of options.neighbors ?? []) assertValidation(net.isIP(neighbor.address) !== 0, `OSPF 链路 ${index + 1} 邻居地址无效`);
    return {
      id: normalizeId(item.id, `OSPF 链路 ${index + 1} ID`),
      fromNodeId: normalizeId(item.fromNodeId ?? item.from, "OSPF 链路本端节点"),
      toNodeId: normalizeId(item.toNodeId ?? item.to, "OSPF 链路对端节点"),
      area: String(item.area ?? "0.0.0.0").trim(),
      localInterface: String(item.localInterface ?? "").trim(),
      remoteInterface: String(item.remoteInterface ?? "").trim(),
      cost, hello, dead, passive: item.passive === true || item.mode === "passive", authentication, options,
    };
  });
  const layoutInput = input.layout && typeof input.layout === "object" && !Array.isArray(input.layout) ? input.layout as RecordValue : {};
  const layout = Object.fromEntries(Object.entries(layoutInput).map(([id, value]) => {
    const position = record(value, "OSPF 拓扑坐标");
    return [id, { x: Math.round(Number(position.x ?? 0)), y: Math.round(Number(position.y ?? 0)), locked: position.locked === true }];
  }));
  assertValidation(new Set(links.map((item) => item.id)).size === links.length, "OSPF 链路 ID 重复");
  const pairCosts = new Map<string, number>(); const usedInterfaces = new Set<string>();
  for (const link of links) {
    assertValidation(link.fromNodeId !== link.toNodeId, "OSPF 链路不能连接同一节点");
    assertValidation(link.localInterface && link.remoteInterface, "OSPF 链路必须配置两端接口");
    assertValidation(net.isIP(link.area) === 4, `OSPF 链路 ${link.id} Area 必须是 IPv4 Area ID`);
    const pair = [link.fromNodeId, link.toNodeId].sort().join(":");
    const knownCost = pairCosts.get(pair); assertValidation(knownCost === undefined || knownCost === link.cost, `OSPF 节点对 ${pair} 的 Cost 必须一致`); pairCosts.set(pair, link.cost);
    const leftKey = `${link.fromNodeId}:${link.localInterface}`; const rightKey = `${link.toNodeId}:${link.remoteInterface}`;
    assertValidation(!usedInterfaces.has(leftKey) && !usedInterfaces.has(rightKey), `OSPF 接口不能被多个链路复用`); usedInterfaces.add(leftKey); usedInterfaces.add(rightKey);
  }
  return { id: normalizeId(input.id, "OSPF 域 ID"), name: normalizeLabel(input.name, "OSPF 域名称"), nodeConfigs, links, layout };
}

export function ospfDomainNodeIds(domain: OspfDomain): string[] {
  return [...new Set([...domain.nodeConfigs.map((item) => item.nodeId), ...domain.links.flatMap((item) => [item.fromNodeId, item.toNodeId])])];
}

export function ospfProtocolName(domain: OspfDomain, version: OspfVersion): string {
  const base = `birdbox_ospf_${domain.id}_${version}`.replace(/[^A-Za-z0-9_]/g, "_");
  return base.slice(0, 60);
}
