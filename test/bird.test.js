import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  checkIncludeNodeAccess,
  configureManagedSsh,
  locateStaticRouteDiagnostic,
  makeStaticProtocolName,
  normalizeNode,
  normalizeDefine,
  normalizePeer,
  normalizePolicyFilter,
  normalizePolicyFunction,
  normalizeRPKI,
  normalizeSession,
  normalizeStaticProtocol,
  parseBirdPrefixEntries,
  parseProtocolStatuses,
  parseRouteDetails,
  renderBirdConfig,
  runOnNode,
  validateInventory,
} from "../src/bird.js";
import {
  resourceChangeNodeIds,
  resourceChangeSessions,
  resourceNodeIds,
} from "../src/resource-impact.js";

const execFileAsync = promisify(execFile);

const node = {
  id: "local",
  kind: "managed-node",
  name: "Local router",
  transport: "local",
  routerId: "192.0.2.1",
  listenPort: 11790,
};

const peers = [
  { id: "peer_transit", nodeId: "local", name: "Transit", address: "192.0.2.2", asn: 65002, port: 179 },
  { id: "peer_ix", nodeId: "local", name: "IX", address: "192.0.2.3", asn: 65003, port: 11790 },
];

const cidrDefines = [
  {
    id: "prefix_transit",
    nodeId: "local",
    label: "Transit exports",
    name: "TRANSIT_EXPORTS",
    type: "cidr",
    entries: ["10.1.0.0/24", "10.0.0.0/8+", "10.0.0.0/8-", "198.51.100.0/24{24,28}"],
    enabled: true,
  },
  {
    id: "prefix_ix",
    nodeId: "local",
    label: "IX exports",
    name: "IX_EXPORTS",
    type: "cidr",
    entries: ["10.2.0.0/24"],
    enabled: true,
  },
];

const sessions = [
  {
    id: "session_transit",
    nodeId: "local",
    peerId: "peer_transit",
    exportDefineId: "prefix_transit",
    protocolName: "transit_bgp",
    localAddress: "192.0.2.1",
    localAsn: 65001,
    multihop: true,
    enabled: true,
  },
  {
    id: "session_ix",
    nodeId: "local",
    peerId: "peer_ix",
    exportDefineId: "prefix_ix",
    protocolName: "ix_bgp",
    localAddress: "192.0.2.10",
    localAsn: 65100,
    multihop: false,
    enabled: true,
  },
];

const staticProtocols = [
  {
    id: "static_transit", nodeId: "local", label: "Transit static", name: "birdbox_static4_transit_bgp",
    family: "ipv4", defineId: "prefix_transit", action: "blackhole", import: "all", export: "none", raw: "", enabled: true,
  },
  {
    id: "static_ix", nodeId: "local", label: "IX static", name: "birdbox_static4_ix_bgp",
    family: "ipv4", defineId: "prefix_ix", action: "reject", import: "all", export: "none", raw: "", enabled: true,
  },
];

const policyFunctions = [{
  id: "function_allow_export",
  nodeId: null,
  name: "allow_export",
  source: "function allow_export()\n{\n  return true;\n}",
  enabled: true,
}];

const expressionDefines = [{
  id: "define_local_pref",
  nodeId: null,
  label: "Default local preference",
  name: "DEFAULT_LOCAL_PREF",
  type: "expression",
  value: "150",
  enabled: true,
}];

const policyFilters = [{
  id: "filter_custom_import",
  nodeId: "local",
  name: "custom_import",
  source: "filter custom_import\n{\n  if net ~ TRANSIT_EXPORTS then accept;\n  reject;\n}",
  enabled: true,
}];

test("normalizes managed nodes, peers, typed Defines, and session-local settings", () => {
  assert.equal(normalizeNode(node).kind, "managed-node");
  assert.equal(normalizePeer(peers[0]).port, 179);
  assert.equal(normalizeDefine(cidrDefines[0]).name, "TRANSIT_EXPORTS");
  assert.deepEqual(normalizeDefine(cidrDefines[0]).entries, cidrDefines[0].entries);
  assert.equal(normalizeSession(sessions[0]).protocolName, "transit_bgp");
  assert.equal(normalizeSession(sessions[1]).localAddress, "192.0.2.10");
  assert.equal(normalizeSession(sessions[1]).localAsn, 65100);
  assert.equal(normalizeSession(sessions[1]).localPort, 179);
  assert.equal(normalizeSession(sessions[1]).bgp.connectionMode, "direct");
  assert.equal(normalizeSession(sessions[1]).channels.ipv4.static, undefined);
  assert.deepEqual(normalizeStaticProtocol(staticProtocols[1]), {
    id: "static_ix", nodeId: "local", label: "IX static", name: "birdbox_static4_ix_bgp", family: "ipv4",
    defineId: "prefix_ix", action: "reject", routeActions: {}, routeFilters: {}, import: "all", export: "none", raw: "",
    enabled: true,
  });
  assert.equal(normalizeSession({ ...sessions[0], localAddress: null }).localAddress, null);
  assert.throws(
    () => normalizeStaticProtocol({ ...staticProtocols[0], import: "invalid" }),
    /Static Import 设置不合法/,
  );
  assert.throws(() => normalizeStaticProtocol({ ...staticProtocols[0], action: "discard" }), /静态路由动作不合法/);
  assert.throws(
    () => normalizeStaticProtocol({ ...staticProtocols[0], defineId: null }),
    /必须同时设置/,
  );
  const viaStatic = normalizeStaticProtocol({
    ...staticProtocols[0],
    action: "blackhole",
    routeActions: { "10.1.0.0/24": "via 192.0.2.254" },
  });
  assert.equal(viaStatic.routeActions["10.1.0.0/24"], "via 192.0.2.254");
  assert.throws(
    () => normalizeStaticProtocol({ ...staticProtocols[0], routeActions: { "10.0.0.0/8+": "reject" } }),
    /完整 CIDR/,
  );
  assert.throws(
    () => normalizeStaticProtocol({ ...staticProtocols[0], routeActions: { "10.1.0.0/24": "via 2001:db8::1" } }),
    /必须是 IPv4 地址/,
  );
  assert.equal(normalizeSession({ ...sessions[0], enabled: false }).enabled, false);
  assert.throws(() => normalizePeer({ ...peers[0], name: "Bad\npeer" }), /控制字符/);
  assert.throws(
    () => normalizeSession({ ...sessions[0], bgp: { description: "Bad\rdescription" } }),
    /控制字符/,
  );
});

test("normalizes SSH Include onboarding nodes without daemon-owned declarations", () => {
  const includeNode = normalizeNode({
    id: "vpstest2",
    name: "VPS Test 2",
    transport: "ssh",
    sshHost: "vpstest2",
    sshUser: "birdbox",
    deploymentMode: "include",
    routerId: "172.20.60.108",
    listenPort: 179,
  });
  assert.equal(includeNode.sshIdentity, "managed");
  assert.equal(includeNode.mainConfigPath, "/etc/bird/bird.conf");
  assert.equal(includeNode.generatedConfigPath, "/var/lib/birdbox/generated.conf");
  assert.equal(includeNode.socketPath, "/run/bird/bird.ctl");
  const config = renderBirdConfig(includeNode, [], [], [], [], [], []);
  assert.match(config, /included by the system BIRD configuration/);
  assert.doesNotMatch(config, /router id/);
  assert.doesNotMatch(config, /protocol device birdbox_device/);
  assert.throws(
    () => normalizeNode({ ...includeNode, transport: "local" }),
    /Include 节点必须使用 SSH/,
  );
  assert.throws(
    () => normalizeNode({ ...includeNode, sshHost: "-oProxyCommand=unexpected" }),
    /SSH 目标不合法/,
  );
});

test("validates inventory ownership and eBGP constraints", () => {
  const state = validateInventory({ nodes: [node], peers, defines: cidrDefines, sessions });
  assert.equal(state.nodes.length, 1);
  assert.equal(state.peers.length, 2);
  assert.equal(state.defines.length, 2);
  assert.throws(
    () => validateInventory({ nodes: [node], peers, defines: cidrDefines, sessions: [{ ...sessions[0], peerId: "missing" }] }),
    /Peer 不属于所选节点/,
  );
  assert.throws(
    () => validateInventory({ nodes: [node], peers: [{ ...peers[0], asn: 65001 }], defines: [cidrDefines[0]], sessions: [sessions[0]] }),
    /ASN 必须不同/,
  );
  assert.throws(
    () => validateInventory({ nodes: [node], peers: [peers[0]], defines: [], sessions: [sessions[0]] }),
    /CIDR Define 对所选节点不可用/,
  );
  assert.throws(
    () => validateInventory({ nodes: [node], peers: [peers[0]], defines: [{ ...cidrDefines[0], enabled: false }], sessions: [sessions[0]] }),
    /CIDR Define 对所选节点不可用/,
  );
  assert.throws(
    () => validateInventory({ nodes: [node], peers: [peers[0]], defines: [{ ...expressionDefines[0], id: "prefix_transit" }], sessions: [sessions[0]] }),
    /CIDR Define 对所选节点不可用/,
  );
  const sshNode = {
    ...node,
    id: "ssh_one",
    name: "SSH one",
    transport: "ssh",
    sshHost: "router.example",
  };
  assert.throws(
    () => validateInventory({
      nodes: [sshNode, { ...sshNode, id: "ssh_two", name: "SSH two", sshHost: "ROUTER.EXAMPLE" }],
      peers: [], defines: [], sessions: [],
    }),
    /同一个 SSH 配置部署目标/,
  );
});

test("calculates resource edit scope and the existing sessions that will be reloaded", () => {
  const otherNode = { ...node, id: "other", name: "Other", routerId: "192.0.2.11", transport: "ssh", sshHost: "other.example" };
  const state = validateInventory({
    nodes: [node, otherNode],
    peers: [peers[0], { ...peers[1], nodeId: "other" }],
    defines: [{ ...cidrDefines[0], nodeId: null }, { ...cidrDefines[1], nodeId: "other" }],
    sessions: [sessions[0], { ...sessions[1], nodeId: "other", peerId: peers[1].id }],
  });
  assert.deepEqual(resourceNodeIds(state, state.defines[0]), ["local", "other"]);
  assert.deepEqual(resourceChangeNodeIds(state, { nodeId: "local" }, { nodeId: "other" }), ["local", "other"]);
  assert.deepEqual(resourceChangeSessions(state, ["other"]).map((session) => session.id), ["session_ix"]);
});

test("rejects an invalid resource edit before it can replace the current inventory", () => {
  const state = validateInventory({ nodes: [node], peers: [peers[0]], defines: [cidrDefines[0]], sessions: [sessions[0]] });
  const originalEntries = [...state.defines[0].entries];
  assert.throws(
    () => validateInventory({
      ...state,
      defines: [{ ...state.defines[0], entries: ["192.0.2.0/24", "192.0.2.0/24"] }],
    }),
    /重复/,
  );
  assert.deepEqual(state.defines[0].entries, originalEntries);
});

test("accepts BIRD IPv4 prefix-set syntax and rejects malformed ranges", () => {
  assert.deepEqual(
    parseBirdPrefixEntries("10.0.0.0/8+, 10.0.0.0/8-\n198.51.100.0/24{24,28}; 192.0.2.0/24"),
    ["10.0.0.0/8+", "10.0.0.0/8-", "198.51.100.0/24{24,28}", "192.0.2.0/24"],
  );
  assert.throws(() => parseBirdPrefixEntries("198.51.100.0/24{29,24}"), /从小到大/);
  assert.throws(() => parseBirdPrefixEntries("198.51.100.0/24{24,33}"), /无效/);
  assert.throws(() => parseBirdPrefixEntries(["192.0.2.0/24", "192.0.2.0/24"]), /重复/);
});

test("supports IPv6 prefix patterns and keeps CIDR Define families distinct", () => {
  assert.deepEqual(
    parseBirdPrefixEntries("2001:db8::/32+, 2001:db8:100::/48\n2001:db8::/32{48,64}", 6),
    ["2001:db8::/32+", "2001:db8:100::/48", "2001:db8::/32{48,64}"],
  );
  assert.equal(normalizeDefine({
    id: "prefix_v6", nodeId: null, label: "IPv6 exports", name: "IPV6_EXPORTS",
    type: "cidr6", entries: ["2001:db8::/32+"], enabled: true,
  }).type, "cidr6");
  assert.throws(() => normalizeDefine({
    id: "prefix_wrong", nodeId: null, label: "Wrong family", name: "WRONG_FAMILY",
    type: "cidr6", entries: ["192.0.2.0/24"], enabled: true,
  }), /必须是 IPv6/);
  assert.throws(() => parseBirdPrefixEntries("2001:db8::/32{64,129}", 6), /无效/);
  assert.equal(normalizeStaticProtocol({
    id: "static_v6_exact", nodeId: "local", label: "IPv6 exact", name: "static_v6_exact",
    family: "ipv6", defineId: "prefix_v6", action: "blackhole",
    routeActions: { "2a0a::/32": "via 2001:db8::1" }, raw: "", enabled: true,
  }).routeActions["2a0a::/32"], "via 2001:db8::1");
  assert.throws(() => normalizeStaticProtocol({
    id: "static_v6_pattern", nodeId: "local", label: "IPv6 pattern", name: "static_v6_pattern",
    family: "ipv6", defineId: "prefix_v6", action: "blackhole",
    routeActions: { "2400:cb00::/32+": "reject" }, raw: "", enabled: true,
  }), /完整 CIDR/);
});

test("renders IPv6-only and dual-stack BGP channels independently", () => {
  const peerV6 = { id: "peer_v6", nodeId: "local", name: "IPv6 peer", address: "2001:db8::2", asn: 65002, port: 179 };
  const defineV6 = {
    id: "prefix_v6", nodeId: "local", label: "IPv6 exports", name: "IPV6_EXPORTS",
    type: "cidr6", entries: ["2001:db8:100::/48"], enabled: true,
  };
  const sessionV6 = {
    id: "session_v6", nodeId: "local", peerId: "peer_v6", protocolName: "peer_v6_bgp",
    localAddress: "2001:db8::1", localAsn: 65001, localPort: 11790, enabled: true,
    channels: {
      ipv4: { enabled: false },
      ipv6: {
        enabled: true,
        importPolicy: { mode: "form", formAction: "all" },
        exportPolicy: { mode: "form", formAction: "cidr" },
        exportDefineId: "prefix_v6",
      },
    },
  };
  const staticV6 = {
    id: "static_v6", nodeId: "local", label: "IPv6 static", name: "birdbox_static6_peer_v6_bgp",
    family: "ipv6", defineId: "prefix_v6", action: "blackhole", import: "all", export: "none", raw: "", enabled: true,
  };
  const ipv6Only = renderBirdConfig(node, [peerV6], [sessionV6], [], [], [defineV6], [], [staticV6]);
  assert.match(ipv6Only, /protocol static birdbox_static6_peer_v6_bgp \{\s+ipv6 \{\s+import all;\s+export none;\s+\};/);
  assert.match(ipv6Only, /protocol bgp peer_v6_bgp[\s\S]*?ipv6 \{/);
  assert.doesNotMatch(ipv6Only.match(/protocol bgp peer_v6_bgp[\s\S]*?\n\}/)?.[0] ?? "", /ipv4 \{/);
  assert.match(ipv6Only, /route 2001:db8:100::\/48 blackhole;/);

  const dual = normalizeSession({
    ...sessions[0],
    channels: { ipv4: { enabled: true }, ipv6: { enabled: true } },
  });
  const dualConfig = renderBirdConfig(node, [peers[0]], [dual]);
  assert.match(dualConfig, /ipv4 \{/);
  assert.match(dualConfig, /ipv6 \{/);
  assert.throws(() => validateInventory({ nodes: [node], peers: [peerV6], defines: [], sessions: [{ ...sessionV6, localAddress: "192.0.2.1" }] }), /同一地址族/);
});

test("automatically enables Extended Next Hop for cross-family BGP transport", () => {
  const peerV6 = { id: "peer_transport_v6", nodeId: "local", name: "IPv6 transport", address: "2001:db8::2", asn: 65002, port: 179 };
  const ipv4OverV6 = {
    id: "session_ipv4_over_v6", nodeId: "local", peerId: peerV6.id, protocolName: "ipv4_over_v6",
    localAddress: "2001:db8::1", localAsn: 65001, localPort: 179, enabled: true,
    bgp: { connectionMode: "multihop" },
    channels: { ipv4: { enabled: true, extendedNextHop: false }, ipv6: { enabled: false } },
  };
  const ipv4OverV6Config = renderBirdConfig(node, [peerV6], [ipv4OverV6]);
  assert.match(ipv4OverV6Config, /ipv4 \{[\s\S]*?extended next hop on;[\s\S]*?\};/);

  const peerV4 = { id: "peer_transport_v4", nodeId: "local", name: "IPv4 transport", address: "192.0.2.2", asn: 65002, port: 179 };
  const ipv6OverV4 = {
    id: "session_ipv6_over_v4", nodeId: "local", peerId: peerV4.id, protocolName: "ipv6_over_v4",
    localAddress: "192.0.2.1", localAsn: 65001, localPort: 179, enabled: true,
    bgp: { connectionMode: "multihop" },
    channels: { ipv4: { enabled: false }, ipv6: { enabled: true, extendedNextHop: false } },
  };
  const ipv6OverV4Config = renderBirdConfig(node, [peerV4], [ipv6OverV4]);
  assert.match(ipv6OverV4Config, /ipv6 \{[\s\S]*?extended next hop on;[\s\S]*?\};/);

  const sameFamilyConfig = renderBirdConfig(node, [peerV4], [{ ...ipv4OverV6, peerId: peerV4.id, localAddress: "192.0.2.1" }]);
  assert.doesNotMatch(sameFamilyConfig, /extended next hop on;/);
  assert.throws(() => validateInventory({
    nodes: [node], peers: [peerV6], defines: [],
    sessions: [{ ...ipv4OverV6, bgp: { connectionMode: "multihop", capabilities: "off" } }],
  }), /不能关闭 BGP Capabilities/);
});

test("supports scoped IPv6 link-local eBGP sessions with latest next-hop controls", () => {
  const peer = { id: "peer_ll", nodeId: "local", name: "Link-local peer", address: "fe80::2%eth0", asn: 65002, port: 179 };
  const session = {
    id: "session_ll", nodeId: "local", peerId: peer.id, protocolName: "link_local_bgp",
    localAddress: "fe80::1%eth0", localAsn: 65001, localPort: 11790, enabled: true,
    bgp: { connectionMode: "direct", onlink: true, interface: "eth0" },
    channels: {
      ipv4: { enabled: false },
      ipv6: { enabled: true, linkLocalNextHopFormat: "single", nextHopPrefer: "local" },
    },
  };
  const config = renderBirdConfig(node, [peer], [session]);
  assert.match(config, /local fe80::1%eth0/);
  assert.match(config, /neighbor fe80::2%eth0/);
  assert.match(config, /interface "eth0";/);
  assert.match(config, /onlink on;/);
  assert.match(config, /link local next hop format single;/);
  assert.match(config, /next hop prefer local;/);
  assert.throws(() => validateInventory({
    nodes: [node], peers: [{ ...peer, address: "fe80::2" }], defines: [],
    sessions: [{ ...session, localAddress: "fe80::1", bgp: { connectionMode: "direct" } }],
  }), /必须指定接口/);
});

test("normalizes one complete Function or Filter declaration per resource", () => {
  const callable = normalizePolicyFunction(policyFunctions[0]);
  assert.equal(callable.callable, true);
  assert.equal(callable.order, undefined);
  const helper = normalizePolicyFunction({
    ...policyFunctions[0],
    id: "function_helper",
    name: "helper",
    source: "function helper(int value)\n{\n  return value > 0;\n}",
  });
  assert.equal(helper.callable, false);
  assert.equal(normalizePolicyFilter(policyFilters[0]).name, "custom_import");
  assert.throws(
    () => normalizePolicyFunction({ ...policyFunctions[0], source: "function another() { return true; }" }),
    /allow_export 声明开始/,
  );
  assert.throws(
    () => normalizePolicyFunction({ ...policyFunctions[0], name: "ALLOW_EXPORT" }),
    /ALLOW_EXPORT 声明开始/,
  );
  assert.throws(
    () => normalizePolicyFilter({ ...policyFilters[0], source: `${policyFilters[0].source}\nprotocol device extra {}` }),
    /只能包含一条顶层声明/,
  );
});

test("normalizes safe Define expressions and rejects extra statements", () => {
  assert.equal(normalizeDefine(expressionDefines[0]).value, "150");
  assert.equal(normalizeDefine({ ...expressionDefines[0], value: "[ 192.0.2.0/24, 198.51.100.0/24 ]" }).name, "DEFAULT_LOCAL_PREF");
  assert.throws(() => normalizeDefine({ ...expressionDefines[0], value: "150; protocol device injected {}" }), /额外的顶层语句/);
  assert.throws(() => normalizeDefine({ ...expressionDefines[0], value: "[ 192.0.2.0/24" }), /没有完整结束/);
  assert.throws(() => normalizeDefine({ ...expressionDefines[0], type: "unknown" }), /类型不合法/);
});

test("enforces CIDR Define ownership and unique BIRD symbols per node", () => {
  const otherNode = { ...node, id: "other", name: "Other router", transport: "ssh", sshHost: "root@other", routerId: "203.0.113.1" };
  const foreignDefine = { ...cidrDefines[0], id: "prefix_foreign", nodeId: "other" };
  assert.throws(
    () => validateInventory({ nodes: [node, otherNode], peers: [peers[0]], defines: [foreignDefine], sessions: [sessions[0]] }),
    /CIDR Define 对所选节点不可用/,
  );
  assert.throws(
    () => validateInventory({ nodes: [node], peers: [], defines: [cidrDefines[0], { ...cidrDefines[1], name: "TRANSIT_EXPORTS" }], sessions: [] }),
    /全局标识符冲突/,
  );
  const globalDefine = { ...cidrDefines[0], nodeId: null, name: "GLOBAL_EXPORTS" };
  const globalSession = { ...sessions[0], exportDefineId: globalDefine.id };
  const state = validateInventory({ nodes: [node, otherNode], peers: [peers[0]], defines: [globalDefine], sessions: [globalSession] });
  assert.equal(state.defines[0].nodeId, null);
  assert.throws(
    () => validateInventory({
      nodes: [node, otherNode],
      peers: [],
      defines: [globalDefine, { ...cidrDefines[1], nodeId: "other", name: "GLOBAL_EXPORTS" }],
      sessions: [],
    }),
    /全局标识符冲突/,
  );
  assert.throws(
    () => validateInventory({
      nodes: [node],
      peers: [],
      defines: [cidrDefines[0]],
      sessions: [],
      staticProtocols: [staticProtocols[0], { ...staticProtocols[1], defineId: "prefix_transit" }],
    }),
    /冲突的静态路由定义/,
  );
  const matchingActions = validateInventory({
    nodes: [node], peers: [], defines: [cidrDefines[0]], sessions: [],
    staticProtocols: [
      staticProtocols[0],
      { ...staticProtocols[0], id: "static_transit_filtered", name: "static_transit_filtered", import: "none", export: "all" },
    ],
  });
  assert.equal(matchingActions.staticProtocols.length, 2);
  const perRoute = {
    ...staticProtocols[0],
    routeFilters: { "10.1.0.0/24": { operations: [{ type: "set", attribute: "preference", value: 150 }], custom: "" } },
  };
  assert.throws(
    () => validateInventory({
      nodes: [node], peers: [], defines: [cidrDefines[0]], sessions: [],
      staticProtocols: [perRoute, { ...staticProtocols[0], id: "static_route_conflict", name: "static_route_conflict" }],
    }),
    /冲突的静态路由定义/,
  );
  assert.throws(
    () => validateInventory({
      nodes: [node],
      peers: [peers[0]],
      defines: [cidrDefines[0], {
        ...expressionDefines[0], id: "static_name_collision", name: "birdbox_static4_transit_bgp",
      }],
      sessions: [sessions[0]],
      staticProtocols: [staticProtocols[0]],
    }),
    /全局标识符冲突/,
  );
});

test("renders reusable defines and session-specific local endpoints", () => {
  const unusedDefine = { ...cidrDefines[1], id: "prefix_unused", name: "UNUSED_EXPORTS", label: "Unused exports" };
  const config = renderBirdConfig(node, peers, sessions, [], [], [cidrDefines[0], unusedDefine, cidrDefines[1]], [], staticProtocols);
  assert.match(config, /define TRANSIT_EXPORTS = \[ 10\.1\.0\.0\/24, 10\.0\.0\.0\/8\+, 10\.0\.0\.0\/8-, 198\.51\.100\.0\/24\{24,28\} \];/);
  assert.match(config, /define IX_EXPORTS = \[ 10\.2\.0\.0\/24 \];/);
  assert.match(config, /define UNUSED_EXPORTS = \[ 10\.2\.0\.0\/24 \];/);
  assert.match(config, /local 192\.0\.2\.1 port 179 as 65001;/);
  assert.match(config, /local 192\.0\.2\.10 port 179 as 65100;/);
  assert.match(config, /protocol static birdbox_static4_transit_bgp/);
  assert.match(config, /protocol static birdbox_static4_ix_bgp/);
  assert.equal((config.match(/protocol static birdbox_static4_/g) ?? []).length, 2);
  assert.equal((config.match(/ipv4 \{\s+import all;\s+export none;\s+\};/g) ?? []).length, 2);
  assert.match(config, /neighbor 192\.0\.2\.2 port 179 as 65002;/);
  assert.match(config, /neighbor 192\.0\.2\.3 port 11790 as 65003;/);
  assert.match(config, /route 10\.1\.0\.0\/24 blackhole;/);
  assert.match(config, /route 10\.2\.0\.0\/24 reject;/);
  assert.doesNotMatch(config, /route 10\.0\.0\.0\/8[+-] blackhole/);
  assert.match(config, /if net ~ TRANSIT_EXPORTS then accept;/);
  assert.match(config, /if net ~ IX_EXPORTS then accept;/);
  assert.equal((config.match(/multihop 10;/g) ?? []).length, 1);
});

test("renders per-CIDR Static actions and follows Define entry changes", () => {
  const customized = {
    ...staticProtocols[0],
    action: "blackhole",
    routeActions: {
      "10.1.0.0/24": "reject",
      "198.51.100.0/24": "via 192.0.2.254",
    },
  };
  const renderDefine = { ...cidrDefines[0], entries: ["10.1.0.0/24", "10.0.0.0/8+", "10.0.0.0/8-", "198.51.100.0/24"] };
  const config = renderBirdConfig(node, peers, sessions, [], [], [renderDefine, cidrDefines[1]], [], [customized]);
  assert.match(config, /route 10\.1\.0\.0\/24 reject;/);
  assert.match(config, /route 198\.51\.100\.0\/24 via 192\.0\.2\.254;/);
  assert.doesNotMatch(config, /route 10\.0\.0\.0\/8[+-]/);

  const changedDefine = {
    ...cidrDefines[0],
    entries: ["203.0.113.0/24", "198.51.100.0/24+"],
  };
  const state = validateInventory({
    nodes: [node],
    peers: [],
    defines: [changedDefine],
    functions: [],
    filters: [],
    rpki: [],
    staticProtocols: [customized],
    sessions: [],
  });
  assert.deepEqual(state.staticProtocols[0].routeActions, { "203.0.113.0/24": "blackhole" });
  const changedConfig = renderBirdConfig(node, [], [], [], [], [changedDefine], [], [customized]);
  assert.match(changedConfig, /route 203\.0\.113\.0\/24 blackhole;/);
  assert.doesNotMatch(changedConfig, /route 198\.51\.100\.0\/24\+/);
});

test("renders structured per-route Static filter operations and maps diagnostics", async (context) => {
  const customized = {
    ...staticProtocols[0],
    routeActions: { "10.1.0.0/24": "reject" },
    routeFilters: {
      "10.1.0.0/24": {
        operations: [
          { type: "set", attribute: "preference", value: 150 },
          { type: "community", list: "standard", operation: "add", value: [65000, 100] },
          { type: "community", list: "large", operation: "add", value: [65000, 1, 2] },
          { type: "prepend", asn: 65000, count: 2 },
        ],
        custom: "bgp_med = 50;",
      },
    },
  };
  const normalized = normalizeStaticProtocol(customized);
  assert.equal(normalized.routeFilters["10.1.0.0/24"].operations.length, 4);
  const config = renderBirdConfig(node, peers, sessions, [], [], cidrDefines, [], [normalized]);
  assert.match(config, /route 10\.1\.0\.0\/24 reject \{/);
  assert.match(config, /preference = 150;/);
  assert.match(config, /bgp_community\.add\(\(65000, 100\)\);/);
  assert.match(config, /bgp_large_community\.add\(\(65000, 1, 2\)\);/);
  assert.equal((config.match(/bgp_path\.prepend\(65000\);/g) ?? []).length, 2);
  assert.match(config, /bgp_med = 50;/);
  const customLine = config.split("\n").findIndex((line) => line.includes(" custom")) + 2;
  const diagnostic = locateStaticRouteDiagnostic(config, `/tmp/bird.conf:${customLine}:5 syntax error`);
  assert.deepEqual(diagnostic && {
    resourceId: diagnostic.resourceId,
    prefix: diagnostic.prefix,
    section: diagnostic.section,
    operationIndex: diagnostic.operationIndex,
  }, {
    resourceId: normalized.id,
    prefix: "10.1.0.0/24",
    section: "custom",
    operationIndex: null,
  });
  assert.throws(() => normalizeStaticProtocol({
    ...customized,
    routeFilters: { "10.0.0.0/8+": { operations: [], custom: "" } },
  }), /完整 CIDR/);
  assert.throws(() => normalizeStaticProtocol({
    ...customized,
    routeFilters: { "10.1.0.0/24": { operations: [{ type: "community", list: "standard", operation: "add", value: [70000, 1] }], custom: "" } },
  }), /超出范围/);
  const nativeBinary = "/usr/sbin/bird";
  try { await fs.access(nativeBinary); } catch { return context.skip("BIRD binary is unavailable"); }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-native-static-filter-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "bird.conf");
  await fs.writeFile(configPath, config);
  const result = await execFileAsync(nativeBinary, ["-p", "-c", configPath]);
  assert.equal(result.stderr, "");
});

test("does not render a disabled session but keeps independent node Static resources", () => {
  const disabled = normalizeSession({ ...sessions[0], enabled: false });
  const config = renderBirdConfig(node, [peers[0]], [disabled], [], [], [cidrDefines[0]], [], [staticProtocols[0]]);
  assert.doesNotMatch(config, /protocol bgp transit_bgp/);
  assert.match(config, /protocol static birdbox_static4_transit_bgp/);
});

test("renders custom Defines before Functions and validates managed dependencies", () => {
  const functionUsingDefine = {
    ...policyFunctions[0],
    name: "uses_define",
    source: "function uses_define() { return DEFAULT_LOCAL_PREF > 100; }",
  };
  const config = renderBirdConfig(node, [], [], [functionUsingDefine], [], expressionDefines);
  assert.match(config, /define DEFAULT_LOCAL_PREF = 150;/);
  assert.ok(config.indexOf("define DEFAULT_LOCAL_PREF") < config.indexOf("function uses_define"));
  const state = validateInventory({ nodes: [node], peers: [], defines: expressionDefines, functions: [functionUsingDefine], filters: [], sessions: [] });
  assert.equal(state.defines[0].name, "DEFAULT_LOCAL_PREF");
  assert.throws(
    () => validateInventory({
      nodes: [node], peers: [], defines: [{ ...expressionDefines[0], enabled: false }],
      functions: [functionUsingDefine], filters: [], sessions: [],
    }),
    /引用了已停用的 Define DEFAULT_LOCAL_PREF/,
  );
  const nodeDefine = { ...expressionDefines[0], nodeId: "local" };
  assert.throws(
    () => validateInventory({ nodes: [node], peers: [], defines: [nodeDefine], functions: [functionUsingDefine], filters: [], sessions: [] }),
    /作用域不兼容的 Define DEFAULT_LOCAL_PREF/,
  );
});

test("composes form policy with Functions and delegates complete policy to Filters", () => {
  const combinedSession = {
    ...sessions[0],
    importPolicy: { mode: "custom", steps: [], filterId: "filter_custom_import" },
    exportPolicy: {
      mode: "combined",
      steps: [
        { type: "function", functionId: "function_allow_export", action: "reject" },
        { type: "form" },
      ],
      filterId: null,
    },
  };
  const config = renderBirdConfig(node, [peers[0]], [combinedSession], policyFunctions, policyFilters, [cidrDefines[0]]);
  assert.ok(config.indexOf("function allow_export") < config.indexOf("filter custom_import"));
  assert.ok(config.indexOf("filter custom_import") < config.indexOf("protocol bgp transit_bgp"));
  assert.match(config, /import filter custom_import;/);
  assert.match(config, /if allow_export\(\) then reject;\s+if net ~ TRANSIT_EXPORTS then accept;\s+reject;/);

  const customExport = {
    ...combinedSession,
    importPolicy: {
      mode: "combined",
      steps: [
        { type: "form" },
        { type: "function", functionId: "function_allow_export", action: "execute" },
      ],
      filterId: null,
    },
    exportPolicy: { mode: "custom", steps: [], filterId: "filter_custom_import" },
  };
  const customConfig = renderBirdConfig(node, [peers[0]], [customExport], policyFunctions, policyFilters, [cidrDefines[0]]);
  assert.match(customConfig, /import filter \{\s+accept;\s+allow_export\(\);\s+\};/);
  assert.doesNotMatch(customConfig, /allow_export\(\);\s+reject;/);
  assert.match(customConfig, /export filter custom_import;/);

  const acceptConfig = renderBirdConfig(node, [peers[0]], [{
    ...sessions[0],
    exportPolicy: {
      mode: "combined",
      steps: [
        { type: "function", functionId: "function_allow_export", action: "accept" },
        { type: "form" },
      ],
      filterId: null,
    },
  }], policyFunctions, [], [cidrDefines[0]]);
  assert.match(acceptConfig, /if allow_export\(\) then accept;\s+if net ~ TRANSIT_EXPORTS then accept;\s+reject;/);

  const formFirstConfig = renderBirdConfig(node, [peers[0]], [{
    ...sessions[0],
    exportPolicy: {
      mode: "combined",
      steps: [
        { type: "form" },
        { type: "function", functionId: "function_allow_export", action: "execute" },
      ],
      filterId: null,
    },
  }], policyFunctions, [], [cidrDefines[0]]);
  assert.match(formFirstConfig, /if net ~ TRANSIT_EXPORTS then accept;\s+allow_export\(\);\s+reject;/);
});

test("supports export form actions and combined policies without Function steps", () => {
  const exportAll = {
    ...sessions[0],
    exportPolicy: { mode: "form", steps: [], filterId: null, formAction: "all" },
  };
  const allConfig = renderBirdConfig(node, [peers[0]], [exportAll], [], [], [cidrDefines[0]]);
  assert.match(allConfig, /export all;/);
  assert.doesNotMatch(allConfig, /protocol static birdbox_static/);

  const exportNone = {
    ...sessions[0],
    exportDefineId: null,
    exportPolicy: { mode: "form", steps: [], filterId: null, formAction: "none" },
  };
  const noneConfig = renderBirdConfig(node, [peers[0]], [exportNone]);
  assert.match(noneConfig, /export none;/);

  const importOnlyForm = {
    ...sessions[0],
    importPolicy: { mode: "combined", steps: [{ type: "form" }], filterId: null, formAction: "all" },
  };
  const importAllConfig = renderBirdConfig(node, [peers[0]], [importOnlyForm], [], [], [cidrDefines[0]]);
  assert.match(importAllConfig, /import filter \{\s+accept;\s+\};/);
  assert.doesNotMatch(importAllConfig.match(/import filter \{[\s\S]*?\};/)?.[0] ?? "", /reject;/);

  const importNoneConfig = renderBirdConfig(node, [peers[0]], [{
    ...importOnlyForm,
    importPolicy: { ...importOnlyForm.importPolicy, formAction: "none" },
  }], [], [], [cidrDefines[0]]);
  assert.match(importNoneConfig, /import filter \{\s+reject;\s+\};/);

  const combinedExport = {
    ...sessions[0],
    exportPolicy: { mode: "combined", steps: [{ type: "form" }], filterId: null, formAction: "all" },
  };
  const combinedExportConfig = renderBirdConfig(node, [peers[0]], [combinedExport], [], [], [cidrDefines[0]]);
  assert.match(combinedExportConfig, /export filter \{\s+accept;\s+reject;\s+\};/);
  const combinedNoneConfig = renderBirdConfig(node, [peers[0]], [{
    ...combinedExport,
    exportPolicy: { ...combinedExport.exportPolicy, formAction: "none" },
  }], [], [], [cidrDefines[0]]);
  const combinedNoneBlock = combinedNoneConfig.match(/export filter \{([\s\S]*?)\n    \};/)?.[1] ?? "";
  assert.equal((combinedNoneBlock.match(/reject;/g) ?? []).length, 1);

  const exportAllWithStatic = renderBirdConfig(node, [peers[0]], [exportAll], [], [], [cidrDefines[0]], [], [staticProtocols[0]]);
  assert.match(exportAllWithStatic, /export all;/);
  assert.match(exportAllWithStatic, /route 10\.1\.0\.0\/24 blackhole;/);
  assert.throws(
    () => normalizeSession({ ...exportNone, exportPolicy: { ...exportNone.exportPolicy, formAction: "cidr" } }),
    /必须选择 CIDR Define/,
  );
});

test("validates policy scope, enabled state, callability, and global names", () => {
  const combinedSession = {
    ...sessions[0],
    exportPolicy: {
      mode: "combined",
      steps: [{ type: "function", functionId: "function_allow_export", action: "execute" }, { type: "form" }],
      filterId: null,
    },
  };
  const state = validateInventory({
    nodes: [node],
    peers: [peers[0]],
    defines: [cidrDefines[0]],
    functions: policyFunctions,
    filters: policyFilters,
    sessions: [combinedSession],
  });
  assert.equal(state.version, 21);
  assert.equal(state.sessions[0].channels.ipv4.exportPolicy.mode, "combined");
  assert.throws(
    () => validateInventory({
      nodes: [node], peers: [peers[0]], defines: [cidrDefines[0]],
      functions: [{ ...policyFunctions[0], enabled: false }], filters: [], sessions: [combinedSession],
    }),
    /导出 Function 不可用/,
  );
  assert.throws(
    () => validateInventory({
      nodes: [node], peers: [peers[0]], defines: [cidrDefines[0]],
      functions: [{ ...policyFunctions[0], name: "TRANSIT_EXPORTS", source: "function TRANSIT_EXPORTS() { return true; }" }], filters: [], sessions: [],
    }),
    /全局标识符冲突/,
  );
  const scopedReference = {
    ...policyFunctions[0],
    id: "function_scoped_reference",
    nodeId: "local",
    name: "scoped_reference",
    source: "function scoped_reference() { return net ~ TRANSIT_EXPORTS; }",
  };
  assert.equal(validateInventory({
    nodes: [node], peers: [], defines: [cidrDefines[0]], functions: [scopedReference], filters: [], sessions: [],
  }).functions[0].nodeId, "local");
  assert.throws(
    () => validateInventory({
      nodes: [node], peers: [], defines: [cidrDefines[0]],
      functions: [{ ...scopedReference, nodeId: null }], filters: [], sessions: [],
    }),
    /作用域不兼容的 Define TRANSIT_EXPORTS/,
  );
});

test("normalizes and renders BIRD 2.19.1 eBGP protocol and IPv4 channel options", () => {
  const advancedSession = {
    ...sessions[0],
    localPort: 11791,
    importPolicy: { mode: "form", steps: [], filterId: null, formAction: "none" },
    bgp: {
      connectionMode: "multihop",
      multihopTtl: 5,
      passive: true,
      bfd: "on",
      ttlSecurity: true,
      description: "Transit edge",
      authentication: "ao",
      aoKeys: "key { id 7; secret \"test-key\"; algorithm hmac sha256; preferred; };",
      strictBind: true,
      freeBind: true,
      checkLink: "off",
      allowLocalPref: true,
      allowMed: true,
      allowLocalAs: 2,
      allowAsSets: "off",
      enforceFirstAs: true,
      routeRefresh: "on",
      requireRouteRefresh: true,
      enhancedRouteRefresh: "on",
      requireEnhancedRouteRefresh: true,
      gracefulRestart: "aware",
      gracefulRestartTime: 90,
      minGracefulRestartTime: 30,
      maxGracefulRestartTime: 300,
      requireGracefulRestart: true,
      longLivedGracefulRestart: "aware",
      longLivedStaleTime: 1800,
      minLongLivedStaleTime: 600,
      maxLongLivedStaleTime: 7200,
      requireLongLivedGracefulRestart: true,
      interpretCommunities: "off",
      enableAs4: "off",
      extendedMessages: true,
      requireExtendedMessages: true,
      capabilities: "on",
      advertiseHostname: true,
      requireHostname: true,
      disableAfterError: true,
      disableAfterCease: "on",
      holdTime: 180,
      minHoldTime: 30,
      startupHoldTime: 180,
      keepaliveTime: 60,
      minKeepaliveTime: 10,
      sendHoldTime: 360,
      connectDelayTime: 3,
      connectRetryTime: 30,
      errorWaitMin: 10,
      errorWaitMax: 60,
      errorForgetTime: 120,
      pathMetric: "off",
      medMetric: true,
      deterministicMed: true,
      igpMetric: "off",
      preferOlder: true,
      defaultMed: 20,
      defaultLocalPref: 200,
      localRole: "provider",
      requireRoles: true,
    },
    ipv4: {
      preference: 120,
      importKeepFiltered: true,
      rpkiReload: "off",
      importLimit: { value: 1000, action: "restart" },
      receiveLimit: { value: 1200, action: "block" },
      exportLimit: { value: 500, action: "warn" },
      mandatory: true,
      nextHopSelf: "on",
      gateway: "recursive",
      importTable: true,
      exportTable: true,
      extendedNextHop: true,
      requireExtendedNextHop: true,
      addPaths: "rx",
      requireAddPaths: true,
      nextHopPrefer: "global",
      aigp: "off",
      cost: 10,
      gracefulRestart: "on",
      longLivedGracefulRestart: "on",
      longLivedStaleTime: 900,
      minLongLivedStaleTime: 300,
      maxLongLivedStaleTime: 1800,
      raw: "debug { routes };",
    },
  };
  const normalized = normalizeSession(advancedSession);
  assert.equal(normalized.localPort, 11791);
  assert.equal(normalized.bgp.multihopTtl, 5);
  assert.equal(normalized.channels.ipv4.importLimit.action, "restart");

  const config = renderBirdConfig(node, [peers[0]], [advancedSession], [], [], [cidrDefines[0]]);
  for (const directive of [
    "protocol bfd birdbox_bfd", "port 11791 as 65001", "multihop 5", "passive on", "bfd on",
    "ttl security on", "authentication ao", "keys {", "algorithm hmac sha256", "allow bgp_local_pref on", "allow local as 2", "graceful restart aware",
    "require route refresh on", "require enhanced route refresh on", "require graceful restart on",
    "min graceful restart time 30", "max graceful restart time 300", "require long lived graceful restart on",
    "require extended messages on", "require hostname on", "disable after cease on", "send hold time 360",
    "hold time 180", "error wait time 10, 60", "local role provider", "require roles on",
    "preference 120", "import keep filtered on", "import limit 1000 action restart",
    "next hop self on", "next hop prefer global", "gateway recursive", "require extended next hop on",
    "add paths rx", "require add paths on", "min long lived stale time 300", "debug { routes }", "import none",
  ]) assert.ok(config.includes(directive), `missing directive: ${directive}`);
  assert.throws(
    () => normalizeSession({ ...sessions[0], bgp: { errorWaitMin: 10 } }),
    /必须同时填写/,
  );
  assert.throws(
    () => normalizeSession({ ...sessions[0], bgp: { connectionMode: "multihop", checkLink: "on" } }),
    /不能启用链路检查/,
  );
  assert.throws(
    () => normalizeSession({ ...sessions[0], ipv4: { raw: "}; protocol static injected {" } }),
    /不能结束外层配置块/,
  );
  assert.throws(() => normalizeSession({ ...sessions[0], bgp: { holdTime: 2 } }), /Hold Time/);
  assert.throws(() => normalizeSession({ ...sessions[0], bgp: { gracefulRestartTime: 4096 } }), /超出范围/);
  assert.throws(() => normalizeSession({ ...sessions[0], bgp: { authentication: "md5" } }), /必须填写密码/);
  assert.throws(() => normalizeSession({ ...sessions[0], bgp: { requireHostname: true } }), /Advertise Hostname/);
  assert.throws(() => normalizeSession({ ...sessions[0], ipv4: { extendedNextHop: false, requireExtendedNextHop: true } }), /需要启用 Extended Next Hop/);
});

test("supports all BIRD 2 Static route actions and custom-only resources", () => {
  for (const action of ["blackhole", "reject", "unreachable", "prohibit"]) {
    const resource = { ...staticProtocols[0], action };
    const config = renderBirdConfig(node, [peers[0]], [sessions[0]], [], [], [cidrDefines[0]], [], [resource]);
    assert.match(config, new RegExp(`route 10\\.1\\.0\\.0/24 ${action};`));
  }
  const customOnly = { ...staticProtocols[0], defineId: null, action: null, raw: "route 203.0.113.0/24 via 192.0.2.254;" };
  const config = renderBirdConfig(node, [], [], [], [], [cidrDefines[0]], [], [customOnly]);
  assert.match(config, /route 203\.0\.113\.0\/24 via 192\.0\.2\.254;/);
});

test("supports independent standard and custom node Static resources", () => {
  const customStatic = {
    ...staticProtocols[0],
    action: "reject",
    import: "none",
    export: "all",
    raw: "route 203.0.113.0/24 via 192.0.2.254;",
  };
  const normalized = normalizeStaticProtocol(customStatic);
  assert.equal(normalized.import, "none");
  assert.equal(normalized.export, "all");
  const customStaticSession = { ...sessions[0], exportPolicy: { mode: "custom", filterId: "filter_custom_import" } };
  const config = renderBirdConfig(node, [peers[0]], [customStaticSession], [], policyFilters, cidrDefines, [], [customStatic]);
  assert.match(config, /protocol static birdbox_static4_transit_bgp[\s\S]*ipv4 \{\s+import none;\s+export all;\s+\};[\s\S]*route 10\.1\.0\.0\/24 reject;/);
  assert.match(config, /route 203\.0\.113\.0\/24 via 192\.0\.2\.254;/);
  assert.match(config, /export filter custom_import;/);
  assert.throws(() => normalizeStaticProtocol({ ...customStatic, raw: "}; protocol static injected {" }), /不能结束外层配置块/);
});

test("lets BIRD select the local address and bounds generated Static protocol names", () => {
  const protocolName = `bgp_${"a".repeat(60)}`;
  const session = {
    ...sessions[0], protocolName, localAddress: null, localPort: 179,
  };
  const staticName = makeStaticProtocolName("ipv4", protocolName);
  const resource = { ...staticProtocols[0], name: staticName };
  const config = renderBirdConfig(node, [peers[0]], [session], [], [], [cidrDefines[0]], [], [resource]);
  assert.match(config, new RegExp(`protocol bgp ${protocolName} \\{\\s+local port 179 as 65001;`));
  assert.match(config, new RegExp(`protocol static ${staticName}`));
  assert.ok(staticName.length <= 64);
  assert.match(staticName, /^birdbox_static4_bgp_a+_[a-f0-9]{10}$/);
});

test("native BIRD 2 parses automatic local binding and configurable Static channels", async (context) => {
  const available = [];
  for (const candidate of ["/usr/sbin/bird", "/usr/bin/bird"]) {
    try {
      await fs.access(candidate);
      available.push(candidate);
      break;
    } catch {}
  }
  if (!available.length) return context.skip("BIRD binary is unavailable");
  const { stdout, stderr } = await execFileAsync(available[0], ["--version"]);
  if (!/^BIRD version 2\./.test(`${stdout}${stderr}`)) return context.skip("BIRD 2 is unavailable");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-native-parse-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "bird.conf");
  const session = {
    ...sessions[0],
    localAddress: null,
    localPort: 179,
    channels: {
      ipv4: {
        enabled: true,
      },
      ipv6: { enabled: false },
    },
  };
  const configurableStatic = {
    ...staticProtocols[0],
    routeActions: { "10.1.0.0/24": "via 192.0.2.254" },
    import: "none",
    export: "all",
  };
  await fs.writeFile(configPath, renderBirdConfig(node, [peers[0]], [session], [], [], [cidrDefines[0]], [], [configurableStatic]));
  await execFileAsync(available[0], ["-p", "-c", configPath]);
});

test("native BIRD 2 parses automatic Extended Next Hop in both transport directions", async (context) => {
  let binary = null;
  for (const candidate of ["/usr/sbin/bird", "/usr/bin/bird"]) {
    try { await fs.access(candidate); binary = candidate; break; } catch {}
  }
  if (!binary) return context.skip("BIRD binary is unavailable");
  const { stdout, stderr } = await execFileAsync(binary, ["--version"]);
  if (!/^BIRD version 2\./.test(`${stdout}${stderr}`)) return context.skip("BIRD 2 is unavailable");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-native-enh-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "bird.conf");
  const peerV6 = { id: "peer_native_v6", nodeId: "local", name: "IPv6 transport", address: "2001:db8::2", asn: 65002, port: 179 };
  const peerV4 = { id: "peer_native_v4", nodeId: "local", name: "IPv4 transport", address: "192.0.2.2", asn: 65003, port: 179 };
  const crossFamilySessions = [
    {
      id: "session_native_v4_via_v6", nodeId: "local", peerId: peerV6.id, protocolName: "native_v4_via_v6",
      localAddress: "2001:db8::1", localAsn: 65001, localPort: 179, enabled: true,
      bgp: { connectionMode: "multihop" },
      channels: { ipv4: { enabled: true }, ipv6: { enabled: false } },
    },
    {
      id: "session_native_v6_via_v4", nodeId: "local", peerId: peerV4.id, protocolName: "native_v6_via_v4",
      localAddress: "192.0.2.1", localAsn: 65001, localPort: 179, enabled: true,
      bgp: { connectionMode: "multihop" },
      channels: { ipv4: { enabled: false }, ipv6: { enabled: true } },
    },
  ];
  await fs.writeFile(configPath, renderBirdConfig(node, [peerV6, peerV4], crossFamilySessions));
  await execFileAsync(binary, ["-p", "-c", configPath]);
});

test("renders local ROA files and RPKI-RTR sources for roa_check filters", () => {
  const fileSource = normalizeRPKI({
    id: "rpki_file", nodeId: "local", label: "Local ROA", name: "local_roa",
    sourceType: "file", roa4Table: "ROA4_LOCAL", roa6Table: "ROA6_LOCAL",
    file4: "/dev/null", file6: "/dev/null",
  });
  const serverSource = normalizeRPKI({
    id: "rpki_server", nodeId: "local", label: "RTR cache", name: "rtr_cache",
    sourceType: "server", roa4Table: "ROA4_REMOTE", roa6Table: "ROA6_REMOTE",
    remote: "127.0.0.1", port: 323, refresh: 3600, retry: 600, expire: 7200,
    maxVersion: 2,
  });
  assert.equal(fileSource.sourceType, "file");
  assert.equal(serverSource.sourceType, "server");
  const config = renderBirdConfig(node, [], [], [], [], [], [fileSource, serverSource]);
  assert.match(config, /roa4 table ROA4_LOCAL;/);
  assert.match(config, /roa6 table ROA6_LOCAL;/);
  assert.match(config, /protocol static local_roa_v4[\s\S]*include "\/dev\/null";/);
  assert.match(config, /protocol static local_roa_v6[\s\S]*roa6 \{ table ROA6_LOCAL; \};/);
  assert.match(config, /protocol rpki rtr_cache[\s\S]*remote 127\.0\.0\.1 port 323;/);
  assert.match(config, /max version 2;/);
  assert.throws(() => normalizeRPKI({
    id: "rpki_bad", nodeId: "local", label: "Bad", name: "bad_rpki", sourceType: "file",
    roa4Table: "ROA4_BAD", file4: "relative.conf",
  }), /绝对路径/);
  assert.throws(() => normalizeRPKI({
    id: "rpki_bad_auth", nodeId: "local", label: "Bad", name: "bad_auth", sourceType: "server",
    roa4Table: "ROA4_BAD", remote: "127.0.0.1", authentication: "md5",
  }), /必须填写密码/);
});

test("allows a BGP session without an export CIDR Define", () => {
  const session = { ...sessions[0], exportDefineId: null };
  const state = validateInventory({ nodes: [node], peers: [peers[0]], defines: [], sessions: [session] });
  assert.equal(state.sessions[0].channels.ipv4.exportDefineId, null);
  const config = renderBirdConfig(node, [peers[0]], [session]);
  assert.match(config, /export none;/);
  assert.doesNotMatch(config, /protocol static birdbox_static/);
  assert.doesNotMatch(config, /export filter/);
});

test("renders a global CIDR Define for any managed node", () => {
  const globalDefine = { ...cidrDefines[0], nodeId: null, name: "GLOBAL_EXPORTS" };
  const globalSession = { ...sessions[0], exportDefineId: globalDefine.id };
  const config = renderBirdConfig(node, [peers[0]], [globalSession], [], [], [globalDefine]);
  assert.match(config, /define GLOBAL_EXPORTS = \[/);
  assert.match(config, /if net ~ GLOBAL_EXPORTS then accept;/);
});

test("rejects command execution for an external Peer object", async () => {
  await assert.rejects(
    () => runOnNode(peers[0], "true"),
    /只能在受管节点执行/,
  );
});

test("streams node command input without embedding it in the command", async () => {
  const result = await runOnNode(
    node,
    "IFS= read -r payload; test \"$payload\" = 'sensitive-routing-config'; printf 'received'",
    { input: "sensitive-routing-config\n" },
  );
  assert.deepEqual(result, { ok: true, stdout: "received", stderr: "" });
});

test("requires an active BIRD include instead of accepting commented directives", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-include-check-"));
  const binDir = path.join(root, "bin");
  const configDir = path.join(root, "config");
  const versionsDir = path.join(configDir, "versions");
  const mainConfigPath = path.join(root, "bird.conf");
  const generatedConfigPath = path.join(configDir, "generated.conf");
  const originalPath = process.env.PATH;
  context.after(async () => {
    process.env.PATH = originalPath;
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(versionsDir, { recursive: true });
  await fs.writeFile(path.join(versionsDir, "initial.conf"), "# initial\n");
  await fs.symlink("versions/initial.conf", generatedConfigPath);
  await fs.writeFile(path.join(binDir, "ssh"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const command = process.argv.at(-1)
  .replace(/^test -S .*$/m, "true")
  .replace(/^birdc .*$/m, "true");
const result = spawnSync("/bin/sh", ["-c", command], { stdio: "inherit" });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  process.env.PATH = `${binDir}:${originalPath}`;
  configureManagedSsh({
    identityFile: path.join(root, "unused-identity"),
    knownHostsFile: path.join(root, "unused-known-hosts"),
  });
  const includeLine = `include "${generatedConfigPath}";`;
  const includeNode = normalizeNode({
    id: "include_check",
    name: "Include check",
    transport: "ssh",
    sshHost: "router.example",
    sshUser: "birdbox",
    sshIdentity: "managed",
    deploymentMode: "include",
    mainConfigPath,
    generatedConfigPath,
    socketPath: path.join(root, "bird.ctl"),
    routerId: "192.0.2.1",
  });

  await fs.writeFile(mainConfigPath, `/*\n${includeLine}\n*/\n`);
  assert.equal((await checkIncludeNodeAccess(includeNode)).ok, false);
  await fs.writeFile(mainConfigPath, `// ${includeLine}\n# ${includeLine}\n`);
  assert.equal((await checkIncludeNodeAccess(includeNode)).ok, false);
  await fs.writeFile(mainConfigPath, `/* managed include */ ${includeLine} # active\n`);
  assert.equal((await checkIncludeNodeAccess(includeNode)).ok, true);
  await fs.writeFile(mainConfigPath, `  include    "${generatedConfigPath}"   ; // active\n`);
  assert.equal((await checkIncludeNodeAccess(includeNode)).ok, true);
  await fs.writeFile(mainConfigPath, `include "/etc/bird/conf.d/*.conf";\n${includeLine}\n`);
  assert.equal((await checkIncludeNodeAccess(includeNode)).ok, true);
  await fs.writeFile(mainConfigPath, `include "${generatedConfigPath}" unexpected;\n`);
  const invalid = await checkIncludeNodeAccess(includeNode);
  assert.equal(invalid.ok, false);
  assert.match(invalid.stderr, /缺少活动 Include/);
});

test("parses multiple BGP protocol states independently", () => {
  const result = parseProtocolStatuses(`
1002-transit_bgp BGP --- up 10:00:00 Established
1006-  BGP state:          Established
         Neighbor address: 192.0.2.2
         Neighbor AS:      65002
         Routes:           5 imported, 1 exported, 5 preferred
1002-ix_bgp BGP --- start 10:00:01 Active
1006-  BGP state:          Active
         Neighbor address: 192.0.2.3
         Neighbor AS:      65003
         Routes:           0 imported, 0 exported, 0 preferred
  `);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    name: "transit_bgp",
    configured: true,
    disabled: false,
    state: "Established",
    established: true,
    neighbor: "192.0.2.2",
    neighborAs: 65002,
    imported: 5,
    exported: 1,
  });
  assert.equal(result[1].name, "ix_bgp");
  assert.equal(result[1].state, "Active");
  assert.equal(result[1].established, false);

  const [disabled] = parseProtocolStatuses(`
1002-paused_bgp BGP --- down 10:00:02 Admin down
1006-  BGP state:          Idle
         Neighbor address: 192.0.2.4
         Neighbor AS:      65004
  `);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.established, false);
});

test("parses per-family BGP channel counts and bounded route details", () => {
  const [protocol] = parseProtocolStatuses(`
1002-dual_bgp BGP --- up 10:00:00 Established
1006-  BGP state:          Established
       Neighbor address: 2001:db8::2
       Neighbor AS:      65002
       Channel ipv4
         State:          UP
         Table:          customer4
         Routes:         5 imported, 3 exported, 5 preferred
       Channel ipv6
         State:          UP
         Table:          customer6
         Routes:         7 imported, 2 exported, 6 preferred
  `);
  assert.equal(protocol.imported, 12);
  assert.equal(protocol.exported, 5);
  assert.deepEqual(protocol.channels, {
    ipv4: { state: "UP", table: "customer4", imported: 5, exported: 3, preferred: 5 },
    ipv6: { state: "UP", table: "customer6", imported: 7, exported: 2, preferred: 6 },
  });

  const details = parseRouteDetails(`
BIRD 2.19.1 ready.
Table customer6:
2001:db8:100::/48  unicast [dual_bgp 10:00:01.000] * (100) [AS65002i]
  Type: BGP univ
  BGP.next_hop: 2001:db8::2
  BGP.as_path: 65002
2001:db8:200::/48  unicast [dual_bgp 10:00:02.000] * (100) [AS65002i]
  Type: BGP univ
---BIRDBOX-ROUTE-TRUNCATED---
  `, "ipv6", 200);
  assert.equal(details.table, "customer6");
  assert.equal(details.truncated, true);
  assert.deepEqual(details.routes.map((route) => route.prefix), ["2001:db8:100::/48", "2001:db8:200::/48"]);
  assert.match(details.routes[0].details, /BGP\.next_hop: 2001:db8::2/);
});
