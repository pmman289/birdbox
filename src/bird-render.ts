import net from "node:net";

import type {
  AddressFamily,
  BgpChannel,
  BgpSession,
  ChannelLimit,
  ChannelPolicy,
  CidrDefine,
  ManagedNode,
  Peer,
  PolicyFilter,
  PolicyFunction,
  RpkiSource,
  SourcePolicyEgress,
  StaticRouteFilter,
  StaticRouteFilterOperation,
} from "../packages/contracts/src/inventory.js";
import { resourceAppliesToNode } from "../packages/contracts/src/resource-scope.js";
import {
  assertValidation,
  channelRequiresExtendedNextHop,
  ipFamily,
  isLinkLocalIPv6,
  normalizeNode,
  normalizePeer,
  splitScopedIPAddress,
} from "./bird-normalize-common.js";
import { normalizeDefine, normalizePolicyFilter, normalizePolicyFunction } from "./bird-policy-resources.js";
import { isExactPrefix } from "./bird-prefix.js";
import { normalizeRPKISource } from "./bird-rpki.js";
import { normalizeSession } from "./bird-session.js";
import { normalizeStaticProtocol, staticRouteDefinitionSignature } from "./bird-static.js";
import { normalizeSourcePolicyEgress, renderSourcePolicyEgress } from "./bird-source-policy.js";

const FAMILIES = ["ipv4", "ipv6"] as const satisfies readonly AddressFamily[];

interface StaticRouteDiagnosticLocation {
  resourceId: string;
  prefix: string;
  section: "route" | "custom" | "operation";
  operationIndex: number | null;
  line: number;
  column: number;
}

interface RenderedStaticRoute {
  prefix: string;
  action: string;
  routeFilter: StaticRouteFilter;
}

function birdString(value: unknown): string {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function indentBirdBlock(source: string, spaces: number): string {
  if (!source) return "";
  const indentation = " ".repeat(spaces);
  return `${source.split("\n").map((line) => `${indentation}${line}`).join("\n")}\n`;
}

function renderStaticRouteFilterOperation(operation: StaticRouteFilterOperation): string {
  if (operation.type === "set") {
    const value = operation.attribute === "bgp_origin" ? `ORIGIN_${operation.value.toUpperCase()}` : operation.value;
    return `${operation.attribute} = ${value};`;
  }
  if (operation.type === "community") {
    const attribute = operation.list === "large" ? "bgp_large_community" : "bgp_community";
    if (operation.operation === "empty") return `${attribute}.empty;`;
    return `${attribute}.${operation.operation}((${operation.value.join(", ")}));`;
  }
  return Array.from({ length: operation.count }, () => `bgp_path.prepend(${operation.asn});`).join("\n");
}

function renderStaticRoute(resourceId: string, prefix: string, action: string, routeFilter: StaticRouteFilter): string {
  if (!routeFilter.operations.length && !routeFilter.custom) return `  route ${prefix} ${action};\n`;
  let source = `  # birdbox-source static=${resourceId} cidr=${prefix} route\n` +
    `  route ${prefix} ${action} {\n`;
  routeFilter.operations.forEach((operation, index) => {
    source += `    # birdbox-source static=${resourceId} cidr=${prefix} operation=${index + 1}\n`;
    source += indentBirdBlock(renderStaticRouteFilterOperation(operation), 4);
  });
  if (routeFilter.custom) {
    source += `    # birdbox-source static=${resourceId} cidr=${prefix} custom\n`;
    source += indentBirdBlock(routeFilter.custom, 4);
  }
  return `${source}  };\n`;
}

export function locateStaticRouteDiagnostic(config: unknown, diagnostic: unknown): StaticRouteDiagnosticLocation | null {
  const location = String(diagnostic ?? "").match(/:(\d+):(\d+)(?:\s|$)/);
  if (!location) return null;
  const lines = String(config ?? "").split("\n");
  let cursor = Math.min(Number(location[1]) - 1, lines.length - 1);
  for (; cursor >= 0; cursor -= 1) {
    const marker = lines[cursor]?.match(/^\s*# birdbox-source static=([A-Za-z_][A-Za-z0-9_]*) cidr=(\S+) (route|custom|operation=(\d+))\s*$/);
    if (!marker) continue;
    return {
      resourceId: marker[1] ?? "",
      prefix: marker[2] ?? "",
      section: marker[3] === "route" ? "route" : marker[3] === "custom" ? "custom" : "operation",
      operationIndex: marker[4] ? Number(marker[4]) - 1 : null,
      line: Number(location[1]),
      column: Number(location[2]),
    };
  }
  return null;
}

function renderSetting(name: string, value: string, spaces = 2): string {
  return value === "default" ? "" : `${" ".repeat(spaces)}${name} ${value};\n`;
}

function renderLimit(name: string, limit: ChannelLimit): string {
  return limit.value === null ? "" : `    ${name} ${limit.value} action ${limit.action};\n`;
}

function renderBgpOptions(session: BgpSession): string {
  const options = session.bgp;
  let output = options.connectionMode === "multihop"
    ? `  multihop ${options.multihopTtl};\n`
    : "  direct;\n";
  if (options.description) output += `  description ${birdString(options.description)};\n`;
  if (options.routerId) output += `  router id ${options.routerId};\n`;
  if (options.vrf) output += options.vrf === "default" ? "  vrf default;\n" : `  vrf ${birdString(options.vrf)};\n`;
  if (options.interface) output += `  interface ${birdString(options.interface)};\n`;
  if (options.onlink) output += "  onlink on;\n";
  if (options.authentication !== "none") output += `  authentication ${options.authentication};\n`;
  if (options.authentication === "md5") output += `  password ${birdString(options.password)};\n`;
  if (options.authentication === "ao") output += `  keys {\n${indentBirdBlock(options.aoKeys, 4)}  };\n`;
  output += renderSetting("setkey", options.setkey);
  if (options.passive) output += "  passive on;\n";
  if (options.bfd === "custom") output += `  bfd {\n${indentBirdBlock(options.bfdOptions, 4)}  };\n`;
  else if (options.bfd !== "off") output += `  bfd ${options.bfd};\n`;
  if (options.ttlSecurity) output += "  ttl security on;\n";
  if (options.strictBind) output += "  strict bind on;\n";
  if (options.freeBind) output += "  free bind on;\n";
  output += renderSetting("check link", options.checkLink);
  if (options.rsClient) output += "  rs client;\n";
  if (options.rrClient) output += "  rr client;\n";
  if (options.rrClusterId) output += `  rr cluster id ${options.rrClusterId};\n`;
  if (options.confederation !== null) output += `  confederation ${options.confederation};\n`;
  if (options.confederationMember) output += "  confederation member on;\n";
  if (options.allowLocalPref) output += "  allow bgp_local_pref on;\n";
  if (options.allowMed) output += "  allow bgp_med on;\n";
  if (options.allowLocalAs === "all") output += "  allow local as;\n";
  else if (options.allowLocalAs !== null) output += `  allow local as ${options.allowLocalAs};\n`;
  output += renderSetting("allow as sets", options.allowAsSets);
  if (options.enforceFirstAs) output += "  enforce first as on;\n";
  output += renderSetting("enable route refresh", options.routeRefresh);
  if (options.requireRouteRefresh) output += "  require route refresh on;\n";
  output += renderSetting("enable enhanced route refresh", options.enhancedRouteRefresh);
  if (options.requireEnhancedRouteRefresh) output += "  require enhanced route refresh on;\n";
  output += renderSetting("graceful restart", options.gracefulRestart);
  if (options.gracefulRestartTime !== null) output += `  graceful restart time ${options.gracefulRestartTime};\n`;
  if (options.minGracefulRestartTime !== null) output += `  min graceful restart time ${options.minGracefulRestartTime};\n`;
  if (options.maxGracefulRestartTime !== null) output += `  max graceful restart time ${options.maxGracefulRestartTime};\n`;
  if (options.requireGracefulRestart) output += "  require graceful restart on;\n";
  output += renderSetting("long lived graceful restart", options.longLivedGracefulRestart);
  if (options.longLivedStaleTime !== null) output += `  long lived stale time ${options.longLivedStaleTime};\n`;
  if (options.minLongLivedStaleTime !== null) output += `  min long lived stale time ${options.minLongLivedStaleTime};\n`;
  if (options.maxLongLivedStaleTime !== null) output += `  max long lived stale time ${options.maxLongLivedStaleTime};\n`;
  if (options.requireLongLivedGracefulRestart) output += "  require long lived graceful restart on;\n";
  output += renderSetting("interpret communities", options.interpretCommunities);
  output += renderSetting("enable as4", options.enableAs4);
  if (options.requireAs4) output += "  require as4 on;\n";
  if (options.extendedMessages) output += "  enable extended messages on;\n";
  if (options.requireExtendedMessages) output += "  require extended messages on;\n";
  output += renderSetting("capabilities", options.capabilities);
  if (options.advertiseHostname) output += "  advertise hostname on;\n";
  if (options.requireHostname) output += "  require hostname on;\n";
  if (options.disableAfterError) output += "  disable after error on;\n";
  output += renderSetting("disable after cease", options.disableAfterCease);
  if (options.holdTime !== null) output += `  hold time ${options.holdTime};\n`;
  if (options.minHoldTime !== null) output += `  min hold time ${options.minHoldTime};\n`;
  if (options.startupHoldTime !== null) output += `  startup hold time ${options.startupHoldTime};\n`;
  if (options.keepaliveTime !== null) output += `  keepalive time ${options.keepaliveTime};\n`;
  if (options.minKeepaliveTime !== null) output += `  min keepalive time ${options.minKeepaliveTime};\n`;
  if (options.sendHoldTime !== null) output += `  send hold time ${options.sendHoldTime};\n`;
  if (options.connectDelayTime !== null) output += `  connect delay time ${options.connectDelayTime};\n`;
  if (options.connectRetryTime !== null) output += `  connect retry time ${options.connectRetryTime};\n`;
  if (options.errorWaitMin !== null) output += `  error wait time ${options.errorWaitMin}, ${options.errorWaitMax};\n`;
  if (options.errorForgetTime !== null) output += `  error forget time ${options.errorForgetTime};\n`;
  output += renderSetting("path metric", options.pathMetric);
  if (options.medMetric) output += "  med metric on;\n";
  if (options.deterministicMed) output += "  deterministic med on;\n";
  output += renderSetting("igp metric", options.igpMetric);
  if (options.preferOlder) output += "  prefer older on;\n";
  if (options.defaultMed !== null) output += `  default bgp_med ${options.defaultMed};\n`;
  if (options.defaultLocalPref !== null) output += `  default bgp_local_pref ${options.defaultLocalPref};\n`;
  if (options.localRole) output += `  local role ${options.localRole};\n`;
  if (options.requireRoles) output += "  require roles on;\n";
  output += indentBirdBlock(options.raw, 2);
  return output;
}

function renderChannelOptions(options: BgpChannel): string {
  let output = "";
  if (options.table) output += `    table ${options.table};\n`;
  if (options.preference !== null) output += `    preference ${options.preference};\n`;
  if (options.importKeepFiltered) output += "    import keep filtered on;\n";
  output += renderSetting("rpki reload", options.rpkiReload, 4);
  output += renderLimit("import limit", options.importLimit);
  output += renderLimit("receive limit", options.receiveLimit);
  output += renderLimit("export limit", options.exportLimit);
  if (options.mandatory) output += "    mandatory on;\n";
  output += renderSetting("next hop keep", options.nextHopKeep, 4);
  output += renderSetting("next hop self", options.nextHopSelf, 4);
  if (options.nextHopAddress) output += `    next hop address ${options.nextHopAddress};\n`;
  if (options.nextHopPrefer !== "default") output += `    next hop prefer ${options.nextHopPrefer};\n`;
  if (options.linkLocalNextHopFormat !== "default") output += `    link local next hop format ${options.linkLocalNextHopFormat};\n`;
  if (options.gateway !== "default") output += `    gateway ${options.gateway};\n`;
  if (options.igpTable) output += `    igp table ${options.igpTable};\n`;
  if (options.importTable) output += "    import table on;\n";
  if (options.exportTable) output += "    export table on;\n";
  if (options.secondary) output += "    secondary on;\n";
  if (options.extendedNextHop) output += "    extended next hop on;\n";
  if (options.requireExtendedNextHop) output += "    require extended next hop on;\n";
  if (options.addPaths !== "off") output += `    add paths ${options.addPaths};\n`;
  if (options.requireAddPaths) output += "    require add paths on;\n";
  if (options.aigp !== "default") output += `    aigp ${options.aigp};\n`;
  if (options.cost !== null) output += `    cost ${options.cost};\n`;
  output += renderSetting("graceful restart", options.gracefulRestart, 4);
  output += renderSetting("long lived graceful restart", options.longLivedGracefulRestart, 4);
  if (options.longLivedStaleTime !== null) output += `    long lived stale time ${options.longLivedStaleTime};\n`;
  if (options.minLongLivedStaleTime !== null) output += `    min long lived stale time ${options.minLongLivedStaleTime};\n`;
  if (options.maxLongLivedStaleTime !== null) output += `    max long lived stale time ${options.maxLongLivedStaleTime};\n`;
  output += indentBirdBlock(options.raw, 4);
  return output;
}

function renderRPKIInterval(keyword: string, value: number | null, keep: boolean): string {
  return value === null ? "" : `  ${keyword} ${keep ? "keep " : ""}${value};\n`;
}

function renderRPKISource(source: RpkiSource): string {
  if (source.sourceType === "file") {
    let output = "";
    if (source.roa4Table) {
      output += `\nprotocol static ${source.name}_v4 {\n`;
      output += `  roa4 { table ${source.roa4Table}; };\n`;
      output += `  include ${birdString(source.file4)};\n`;
      output += "}\n";
    }
    if (source.roa6Table) {
      output += `\nprotocol static ${source.name}_v6 {\n`;
      output += `  roa6 { table ${source.roa6Table}; };\n`;
      output += `  include ${birdString(source.file6)};\n`;
      output += "}\n";
    }
    return output;
  }
  let output = `\nprotocol rpki ${source.name} {\n`;
  if (source.roa4Table) output += `  roa4 { table ${source.roa4Table}; };\n`;
  if (source.roa6Table) output += `  roa6 { table ${source.roa6Table}; };\n`;
  output += `  remote ${net.isIP(source.remote) ? source.remote : birdString(source.remote)} port ${source.port};\n`;
  if (source.localAddress) output += `  local address ${source.localAddress};\n`;
  output += renderRPKIInterval("refresh", source.refresh, source.keepRefresh);
  output += renderRPKIInterval("retry", source.retry, source.keepRetry);
  output += renderRPKIInterval("expire", source.expire, source.keepExpire);
  if (source.ignoreMaxLength !== "default") output += `  ignore max length ${source.ignoreMaxLength};\n`;
  if (source.minVersion !== null) output += `  min version ${source.minVersion};\n`;
  if (source.maxVersion !== null) output += `  max version ${source.maxVersion};\n`;
  if (source.transport === "ssh") {
    output += "  transport ssh {\n";
    output += `    bird private key ${birdString(source.birdPrivateKey)};\n`;
    output += `    remote public key ${birdString(source.remotePublicKey)};\n`;
    output += `    user ${birdString(source.user)};\n`;
    output += "  };\n";
  } else if (source.authentication === "md5") {
    output += "  transport tcp {\n    authentication md5;\n";
    output += `    password ${birdString(source.password)};\n  };\n`;
  }
  output += "}\n";
  return output;
}

function renderPolicy(
  policy: ChannelPolicy,
  direction: "import" | "export",
  exportDefine: CidrDefine | null,
  functionMap: ReadonlyMap<string, PolicyFunction>,
  filterMap: ReadonlyMap<string, PolicyFilter>,
): string {
  if (policy.mode === "custom") {
    const filter = policy.filterId === null ? undefined : filterMap.get(policy.filterId);
    assertValidation(filter, "会话引用了不可用的 Filter");
    return `    ${direction} filter ${filter.name};\n`;
  }
  if (direction === "export" && policy.formAction === "cidr") {
    assertValidation(exportDefine, "导出指定 CIDR 模式必须选择 CIDR Define");
  }
  const formDecision = direction === "import"
    ? `      ${policy.formAction === "all" ? "accept" : "reject"};\n`
    : policy.formAction === "all"
      ? "      accept;\n"
      : policy.formAction === "none"
        ? "      reject;\n"
        : `      if net ~ ${exportDefine?.name} then accept;\n`;
  const stepLines = policy.mode === "combined"
    ? policy.steps.map((step, index) => {
      if (step.type === "form") {
        const finalExportReject = direction === "export" && policy.formAction === "none" && index === policy.steps.length - 1;
        return finalExportReject ? "" : formDecision;
      }
      const resource = functionMap.get(step.functionId);
      assertValidation(resource, "会话引用了不可用的 Function");
      if (step.action === "execute") return `      ${resource.name}();\n`;
      return `      if ${resource.name}() then ${step.action};\n`;
    }).join("")
    : "";
  if (direction === "import") {
    return stepLines
      ? `    import filter {\n${stepLines}    };\n`
      : `    import ${policy.formAction};\n`;
  }
  if (policy.mode === "form") {
    if (policy.formAction === "all") return "    export all;\n";
    if (policy.formAction === "none") return "    export none;\n";
  }
  const renderedSteps = policy.mode === "combined" ? stepLines : formDecision;
  return `    export filter {\n${renderedSteps}      reject;\n    };\n`;
}

function normalizeActiveSessions(
  node: ManagedNode,
  peers: Peer[],
  sessions: BgpSession[],
  defineMap: ReadonlyMap<string, ReturnType<typeof normalizeDefine>>,
  functionMap: ReadonlyMap<string, PolicyFunction>,
  filterMap: ReadonlyMap<string, PolicyFilter>,
): Array<{ session: BgpSession; peer: Peer; exportDefines: Record<AddressFamily, CidrDefine | null> }> {
  const peerMap = new Map(peers.map((item) => [item.id, item]));
  return sessions.map((session) => {
    const peer = peerMap.get(session.peerId);
    assertValidation(session.nodeId === node.id, `会话 ${session.protocolName} 不属于节点 ${node.name}`);
    assertValidation(peer && peer.nodeId === node.id, `会话 ${session.protocolName} 的 Peer 不属于节点 ${node.name}`);
    assertValidation(
      session.sessionType === "ibgp" ? session.localAsn === peer.asn : session.localAsn !== peer.asn,
      session.sessionType === "ibgp"
        ? `iBGP 会话 ${session.protocolName} 的两端 ASN 必须相同`
        : `eBGP 会话 ${session.protocolName} 的两端 ASN 必须不同`,
    );
    assertValidation(session.localAddress === null || session.localAddress !== peer.address, `会话 ${session.protocolName} 的两端地址不能相同`);
    assertValidation(session.localAddress === null || ipFamily(session.localAddress) === ipFamily(peer.address), `会话 ${session.protocolName} 的本地与 Peer 地址必须属于同一地址族`);
    const localScope = session.localAddress === null ? null : splitScopedIPAddress(session.localAddress).zone;
    const peerScope = splitScopedIPAddress(peer.address).zone;
    if ((session.localAddress !== null && isLinkLocalIPv6(session.localAddress)) || isLinkLocalIPv6(peer.address)) {
      assertValidation(session.bgp.connectionMode === "direct", `会话 ${session.protocolName} 的 IPv6 Link-local 地址只能用于 Direct 会话`);
      assertValidation(session.bgp.interface !== null || localScope !== null || peerScope !== null, `会话 ${session.protocolName} 的 IPv6 Link-local 地址必须指定接口`);
      assertValidation(localScope === null || peerScope === null || localScope === peerScope, `会话 ${session.protocolName} 的 IPv6 Scope 接口必须一致`);
    }
    const exportDefines: Record<AddressFamily, CidrDefine | null> = { ipv4: null, ipv6: null };
    for (const family of FAMILIES) {
      const channel = session.channels[family];
      assertValidation(
        !channel.enabled || !channelRequiresExtendedNextHop(peer.address, family) || session.bgp.capabilities !== "off",
        `会话 ${session.protocolName} 的 IPv4 Channel 通过 IPv6 邻居传输时不能关闭 BGP Capabilities`,
      );
      const expectedType = family === "ipv4" ? "cidr4" : "cidr6";
      const exportDefine = channel.exportDefineId === null ? null : defineMap.get(channel.exportDefineId);
      assertValidation(
        channel.exportDefineId === null || (
          exportDefine?.type === expectedType
          && resourceAppliesToNode(exportDefine, node.id)
        ),
        `会话 ${session.protocolName} 的 ${family.toUpperCase()} 导出 CIDR Define 对节点 ${node.name} 不可用`,
      );
      for (const policy of [channel.importPolicy, channel.exportPolicy]) {
        for (const step of policy.steps.filter((item) => item.type === "function")) {
          assertValidation(functionMap.get(step.functionId)?.callable, `会话 ${session.protocolName} 引用了不可用的 Function`);
        }
        if (policy.filterId !== null) assertValidation(filterMap.has(policy.filterId), `会话 ${session.protocolName} 引用了不可用的 Filter`);
      }
      exportDefines[family] = exportDefine?.type === expectedType ? exportDefine : null;
    }
    return { session, peer, exportDefines };
  });
}

export function renderBirdConfig(
  nodeInput: unknown,
  peerInputs: readonly unknown[],
  sessionInputs: readonly unknown[],
  functionInputs: readonly unknown[] = [],
  filterInputs: readonly unknown[] = [],
  defineInputs: readonly unknown[] = [],
  rpkiInputs: readonly unknown[] = [],
  staticInputs: readonly unknown[] = [],
  sourcePolicyInputs: readonly unknown[] = [],
): string {
  const node = normalizeNode(nodeInput);
  const peers = peerInputs.map(normalizePeer);
  const defines = defineInputs.map(normalizeDefine).filter((item) => item.enabled);
  const functions = functionInputs.map(normalizePolicyFunction).filter((item) => item.enabled);
  const filters = filterInputs.map(normalizePolicyFilter).filter((item) => item.enabled);
  const rpki = rpkiInputs.map(normalizeRPKISource).filter((item) => item.enabled && resourceAppliesToNode(item, node.id));
  const staticProtocols = staticInputs.map(normalizeStaticProtocol).filter((item) => item.enabled && item.nodeId === node.id);
  const sourcePolicies = sourcePolicyInputs.map(normalizeSourcePolicyEgress)
    .filter((item) => item.enabled && resourceAppliesToNode(item, node.id));
  const sessions = sessionInputs.map(normalizeSession).filter((item) => item.enabled);
  const defineMap = new Map(defines.map((item) => [item.id, item]));
  const functionMap = new Map(functions.map((item) => [item.id, item]));
  const filterMap = new Map(filters.map((item) => [item.id, item]));
  for (const resource of [...defines, ...functions, ...filters]) {
    assertValidation(resourceAppliesToNode(resource, node.id), `策略 ${resource.name} 对节点 ${node.name} 不可用`);
  }
  const table4Names = new Set(rpki.map((item) => item.roa4Table).filter((value): value is string => value !== null));
  const table6Names = new Set(rpki.map((item) => item.roa6Table).filter((value): value is string => value !== null));
  const active = normalizeActiveSessions(node, peers, sessions, defineMap, functionMap, filterMap);
  const routeDefinitions: Record<AddressFamily, Map<string, string>> = { ipv4: new Map(), ipv6: new Map() };
  const renderedStaticProtocols = staticProtocols.map((resource) => {
    const expectedType = resource.family === "ipv4" ? "cidr4" : "cidr6";
    const staticDefine = resource.defineId === null ? null : defineMap.get(resource.defineId);
    assertValidation(
      resource.defineId === null || (
        staticDefine?.type === expectedType
        && resourceAppliesToNode(staticDefine, node.id)
      ),
      `Static 资源 ${resource.name} 的 CIDR Define 对节点 ${node.name} 不可用`,
    );
    const routes: RenderedStaticRoute[] = [];
    if (staticDefine !== null && staticDefine !== undefined && staticDefine.type !== "expression") {
      for (const prefix of staticDefine.entries.filter(isExactPrefix)) {
        const action = resource.routeActions[prefix] ?? resource.action;
        if (action === null) continue;
        const routeFilter = resource.routeFilters[prefix] ?? { operations: [], custom: "" };
        const signature = staticRouteDefinitionSignature(action, routeFilter);
        const existing = routeDefinitions[resource.family].get(prefix);
        assertValidation(!existing || existing === signature, `节点 ${node.name} 对 ${prefix} 配置了冲突的静态路由定义`);
        routeDefinitions[resource.family].set(prefix, signature);
        routes.push({ prefix, action, routeFilter });
      }
    }
    return { ...resource, routes };
  }).filter((resource) => resource.routes.length || resource.raw);
  const renderedSourcePolicies: Array<{ resource: SourcePolicyEgress; internalDefineNames: string[] }> = sourcePolicies.map((resource) => {
    const internalDefineNames = resource.internalDefineIds.map((defineId) => {
      const define = defineMap.get(defineId);
      assertValidation(
        define?.type === "cidr4" && resourceAppliesToNode(define, node.id),
        `源地址出口映射 ${resource.label} 的内部路由 Define 对节点 ${node.name} 不可用`,
      );
      return define.name;
    });
    return { resource, internalDefineNames };
  });

  let config = "# Generated by Birdbox Demo. Manual changes will be replaced.\n";
  if (node.deploymentMode === "legacy") {
    config += `router id ${node.routerId};\n\nprotocol device birdbox_device {\n}\n`;
  } else {
    config += "# This file is included by the system BIRD configuration.\n";
  }
  for (const resource of defines) {
    const value = resource.type === "expression" ? resource.value : `[ ${resource.entries.join(", ")} ]`;
    config += `\ndefine ${resource.name} = ${value};\n`;
  }
  for (const table of table4Names) config += `\nroa4 table ${table};\n`;
  for (const table of table6Names) config += `\nroa6 table ${table};\n`;
  for (const source of rpki) config += renderRPKISource(source);
  for (const resource of functions) config += `\n${resource.source}\n`;
  for (const resource of filters) config += `\n${resource.source}\n`;
  if (active.some(({ session }) => session.bgp.bfd !== "off")) config += "\nprotocol bfd birdbox_bfd {\n}\n";

  for (const staticProtocol of renderedStaticProtocols) {
    config += `\nprotocol static ${staticProtocol.name} {\n` +
      `  ${staticProtocol.family} {\n` +
      `    import ${staticProtocol.import};\n` +
      `    export ${staticProtocol.export};\n` +
      "  };\n";
    for (const { prefix, action, routeFilter } of staticProtocol.routes) {
      config += renderStaticRoute(staticProtocol.id, prefix, action, routeFilter);
    }
    if (staticProtocol.raw) config += indentBirdBlock(staticProtocol.raw, 2);
    config += "}\n";
  }

  for (const { session, peer, exportDefines } of active) {
    config += `\nprotocol bgp ${session.protocolName} {\n` +
      `  local${session.localAddress ? ` ${session.localAddress}` : ""} port ${session.localPort} as ${session.localAsn};\n` +
      `  neighbor ${peer.address} port ${peer.port} as ${peer.asn};\n` +
      renderBgpOptions(session);
    for (const family of FAMILIES) {
      const channel = session.channels[family];
      if (!channel.enabled) continue;
      const effectiveChannel = channelRequiresExtendedNextHop(peer.address, family)
        ? { ...channel, extendedNextHop: true }
        : channel;
      config += `  ${family} {\n` +
        renderChannelOptions(effectiveChannel) +
        renderPolicy(channel.importPolicy, "import", exportDefines[family], functionMap, filterMap) +
        renderPolicy(channel.exportPolicy, "export", exportDefines[family], functionMap, filterMap) +
        "  };\n";
    }
    config += "}\n";
  }
  for (const sourcePolicy of renderedSourcePolicies) {
    config += renderSourcePolicyEgress(sourcePolicy.resource, sourcePolicy.internalDefineNames);
  }
  return config;
}
