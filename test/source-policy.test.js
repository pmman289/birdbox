import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  normalizeSourcePolicyEgress,
  prepareSourcePolicyEgress,
  renderBirdConfig,
  sourcePolicyManualPlan,
  sourcePolicyRules,
  validateInventory,
} from "../src/bird.js";

const local = {
  id: "local", kind: "managed-node", name: "Local", transport: "local", routerId: "192.0.2.1", listenPort: 179,
};
const remote = {
  id: "remote", kind: "managed-node", name: "Remote", transport: "ssh", sshHost: "remote.example", routerId: "192.0.2.2", listenPort: 179,
};

function resource(overrides = {}) {
  return {
    id: "source_policy_public",
    label: "Public egress",
    enabled: true,
    nodeIds: ["local"],
    rulePriorityBase: 10000,
    copyInternalRoutes: false,
    internalDefineIds: [],
    groups: [{
      id: "gateway_hk",
      egressAddress: "172.20.177.36",
      sources: ["162.141.136.139/32", "162.141.136.138/32"],
      kernelTable: 200,
      ruleSlot: 0,
    }, {
      id: "gateway_us",
      egressAddress: "172.20.177.38",
      sources: ["82.47.33.189/32"],
      kernelTable: 201,
      ruleSlot: 1,
    }],
    ...overrides,
  };
}

function inventory(overrides = {}) {
  return {
    version: 27,
    nodes: [local, remote],
    peers: [],
    defines: [],
    functions: [],
    filters: [],
    rpki: [],
    staticProtocols: [],
    sourcePolicies: [],
    sessions: [],
    ibgpDomains: [],
    ...overrides,
  };
}

test("normalizes exact IPv4 source CIDRs and reserves stable source-policy allocations", () => {
  const normalized = normalizeSourcePolicyEgress(resource({
    groups: [{
      id: "gateway_hk", egressAddress: "172.20.177.36", sources: ["162.141.136.139/24"], kernelTable: 200, ruleSlot: 0,
    }],
  }));
  assert.deepEqual(normalized.groups[0].sources, ["162.141.136.0/24"]);
  assert.throws(
    () => normalizeSourcePolicyEgress(resource({ groups: [{
      id: "bad", egressAddress: "172.20.177.36", sources: ["162.141.136.0/24+"], kernelTable: 200, ruleSlot: 0,
    }] })),
    /IPv4 CIDR/,
  );

  const first = prepareSourcePolicyEgress({ label: "First", nodeIds: ["local"], groups: [{ egressAddress: "172.20.177.36", sources: ["198.51.100.1/32"] }] }, null, [], (prefix) => `${prefix}_one`);
  const second = prepareSourcePolicyEgress({ label: "Second", nodeIds: ["local"], groups: [{ egressAddress: "172.20.177.38", sources: ["198.51.100.2/32"] }] }, null, [first], (prefix) => `${prefix}_two`);
  assert.notEqual(first.rulePriorityBase, second.rulePriorityBase);
  assert.notEqual(first.groups[0].kernelTable, second.groups[0].kernelTable);
  assert.deepEqual(sourcePolicyRules(first).map((rule) => rule.priority), [first.rulePriorityBase]);

  const full = prepareSourcePolicyEgress({
    label: "Full",
    nodeIds: ["local"],
    groups: Array.from({ length: 16 }, (_, index) => ({
      id: `full_${index}`,
      egressAddress: `192.0.2.${index + 1}`,
      sources: [`198.18.${index}.1/32`],
    })),
  }, null, [], (prefix) => `${prefix}_full`);
  const replaced = prepareSourcePolicyEgress({
    label: "Full",
    nodeIds: ["local"],
    groups: [...full.groups.slice(1), { egressAddress: "192.0.2.200", sources: ["198.18.200.1/32"] }],
  }, full, [full], (prefix) => `${prefix}_replacement`);
  assert.doesNotThrow(() => validateInventory(inventory({ nodes: [local], sourcePolicies: [replaced] })));
  assert.equal(replaced.groups.at(-1).ruleSlot, 0);

  const customTable = prepareSourcePolicyEgress({
    label: "Custom table",
    nodeIds: ["local"],
    groups: [{ egressAddress: "172.20.177.40", kernelTable: 50000, sources: ["198.51.100.3/32"] }],
  }, null, [], () => "source_custom");
  assert.equal(customTable.groups[0].kernelTable, 50000);
  assert.throws(
    () => normalizeSourcePolicyEgress(resource({ groups: [{
      id: "reserved", egressAddress: "172.20.177.40", kernelTable: 253, sources: ["198.51.100.4/32"], ruleSlot: 0,
    }] })),
    /内核路由表/,
  );
});

test("rejects source-prefix overlap only where mapping node scopes intersect", () => {
  const left = resource({ nodeIds: ["local"] });
  const right = resource({
    id: "source_policy_remote",
    label: "Remote egress",
    nodeIds: ["remote"],
    rulePriorityBase: 11024,
    groups: [{ id: "remote_gateway", egressAddress: "172.20.177.38", sources: ["162.141.136.0/24"], kernelTable: 202, ruleSlot: 0 }],
  });
  assert.doesNotThrow(() => validateInventory(inventory({ sourcePolicies: [left, right] })));
  assert.throws(
    () => validateInventory(inventory({ sourcePolicies: [{ ...right, nodeIds: ["local"] }, left] })),
    /源 CIDR .*出口映射冲突/,
  );
});

test("renders BIRD tables, recursive defaults, kernel exports, and optional internal pipes", () => {
  const internal = {
    id: "internal_prefixes", nodeIds: ["local"], label: "Internal", name: "INTERNAL_PREFIXES",
    type: "cidr4", entries: ["10.0.0.0/8"], enabled: true,
  };
  const mapped = resource({ copyInternalRoutes: true, internalDefineIds: [internal.id] });
  const state = validateInventory(inventory({ nodes: [local], defines: [internal], sourcePolicies: [mapped] }));
  const config = renderBirdConfig(local, [], [], [], [], state.defines, [], [], state.sourcePolicies);
  assert.match(config, /ipv4 table bb_spe_t_/);
  assert.match(config, /route 0\.0\.0\.0\/0 recursive 172\.20\.177\.36;/);
  assert.match(config, /kernel table 200;/);
  assert.match(config, /protocol pipe bb_spe_p_/);
  assert.match(config, /if net ~ INTERNAL_PREFIXES then accept;/);
  assert.doesNotMatch(config, /persist;/);
});

test("creates Linux scripts and OpenWrt LuCI checklists without automated host changes", () => {
  const current = resource();
  const linuxPlan = sourcePolicyManualPlan(local, current, null, "create", "protocol static test { }");
  assert.equal(linuxPlan.platform, "linux");
  assert.match(linuxPlan.applyScript, /ip -4 rule add priority 10000 from '162\.141\.136\.139\/32' table 200/);
  assert.match(linuxPlan.applyScript, /请使用 root 身份执行此脚本/);
  assert.equal(linuxPlan.cleanupScript, null);
  assert.ok(linuxPlan.systemdUnit?.includes("ExecStart=/usr/local/lib/birdbox/source-policy-source_policy_public.sh apply"));
  assert.ok(linuxPlan.systemdUnit?.includes("WantedBy=multi-user.target"));
  assert.ok(linuxPlan.systemdInstallScript?.includes("systemctl daemon-reload"));
  assert.ok(linuxPlan.systemdInstallScript?.includes("BIRDBOX_SOURCE_POLICY_HELPER"));
  assert.equal(spawnSync("/bin/sh", ["-n"], { input: linuxPlan.systemdInstallScript, encoding: "utf8" }).status, 0);

  const openwrt = { ...remote, mainConfigPath: "/etc/bird.conf" };
  const openwrtPlan = sourcePolicyManualPlan(openwrt, { ...current, nodeIds: null }, null, "create", "");
  assert.equal(openwrtPlan.platform, "openwrt");
  assert.equal(openwrtPlan.applyScript, null);
  assert.equal(openwrtPlan.systemdUnit, null);
  assert.equal(openwrtPlan.systemdInstallScript, null);
  assert.equal(openwrtPlan.rules.length, 3);
  assert.match(openwrtPlan.instructions[0], /LuCI/);

  const deleted = sourcePolicyManualPlan(local, null, current, "delete", "");
  assert.equal(deleted.rules.length, 0);
  assert.match(deleted.cleanupScript, /ip -4 rule del priority 10000/);

  const disabled = { ...current, enabled: false };
  const disabledPlan = sourcePolicyManualPlan(local, disabled, disabled, "reconcile", "");
  assert.equal(disabledPlan.rules.length, 0);
  assert.equal(disabledPlan.cleanupScript, null);

  const disabledUpdatePlan = sourcePolicyManualPlan(local, disabled, current, "update", "");
  assert.equal(disabledUpdatePlan.rules.length, 0);
  assert.match(disabledUpdatePlan.cleanupScript, /ip -4 rule del priority 10000/);
});
