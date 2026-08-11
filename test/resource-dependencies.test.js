import test from "node:test";
import assert from "node:assert/strict";

import { validateInventory } from "../src/bird.js";
import { resourceReferencesSymbol } from "../src/inventory-domain.js";

const nodes = [
  { id: "left", name: "Left", transport: "local", routerId: "192.0.2.1" },
  { id: "right", name: "Right", transport: "ssh", sshHost: "right.example", routerId: "192.0.2.2" },
];

const scopedRpki = {
  id: "rpki_dn42",
  nodeIds: ["left", "right"],
  label: "DN42 ROA",
  name: "rpki_dn42",
  enabled: true,
  sourceType: "file",
  roa4Table: "ROA_DN42_V4",
  roa6Table: "ROA_DN42_V6",
  file4: "/etc/bird/roa4.conf",
  file6: "/etc/bird/roa6.conf",
};

function policyFunction(id, name, source, nodeIds = null) {
  return { id, nodeIds, label: name, name, source, enabled: true };
}

function inventory(overrides = {}) {
  return {
    nodes,
    peers: [],
    defines: [],
    functions: [],
    filters: [],
    rpki: [],
    staticProtocols: [],
    sessions: [],
    ibgpDomains: [],
    ...overrides,
  };
}

test("recursively validates Filter to Function to RPKI scope coverage", () => {
  const helper = policyFunction(
    "function_roa_check",
    "function_roa_check",
    "function function_roa_check() { return roa_check(ROA_DN42_V4, net, bgp_path.last) = ROA_VALID; }",
  );
  const filter = {
    id: "filter_import",
    nodeIds: null,
    label: "Import filter",
    name: "filter_import",
    source: "filter filter_import { if function_roa_check() then accept; reject; }",
    enabled: true,
  };

  assert.throws(
    () => validateInventory(inventory({ functions: [helper], filters: [filter], rpki: [scopedRpki] })),
    (error) => /作用域不兼容的 RPKI rpki_dn42/.test(error.message)
      && /Filter filter_import -> Function function_roa_check -> RPKI rpki_dn42/.test(error.message),
  );
  assert.doesNotThrow(() => validateInventory(inventory({
    functions: [helper],
    filters: [filter],
    rpki: [{ ...scopedRpki, nodeIds: null }],
  })));
});

test("validates Static custom source through the complete dependency chain", () => {
  const helper = policyFunction(
    "function_roa_check",
    "function_roa_check",
    "function function_roa_check() { return roa_check(ROA_DN42_V4, net, bgp_path.last) = ROA_VALID; }",
    ["left"],
  );
  const staticProtocol = {
    id: "static_right",
    nodeId: "right",
    label: "Right static",
    name: "static_right",
    family: "ipv4",
    defineId: null,
    action: null,
    routeActions: {},
    routeFilters: {},
    import: "all",
    export: "none",
    raw: "function_roa_check();",
    enabled: true,
  };

  assert.throws(
    () => validateInventory(inventory({ functions: [helper], rpki: [scopedRpki], staticProtocols: [staticProtocol] })),
    (error) => /作用域不兼容的 Function function_roa_check/.test(error.message)
      && /Static static_right -> Function function_roa_check/.test(error.message),
  );
});

test("recursively validates source-policy internal Define scope", () => {
  const define = {
    id: "define_internal", nodeIds: ["left"], label: "Internal", name: "INTERNAL_PREFIXES",
    type: "cidr4", entries: ["10.0.0.0/8"], enabled: true,
  };
  const sourcePolicy = {
    id: "source_policy_global", nodeIds: null, label: "Global egress", enabled: true,
    groups: [{ id: "gateway", egressAddress: "192.0.2.2", sources: ["198.51.100.1/32"], kernelTable: 200, ruleSlot: 0 }],
    rulePriorityBase: 10000, copyInternalRoutes: true, internalDefineIds: [define.id],
  };
  assert.throws(
    () => validateInventory(inventory({ defines: [define], sourcePolicies: [sourcePolicy] })),
    (error) => /作用域不兼容的 Define INTERNAL_PREFIXES/.test(error.message)
      && /SourcePolicy Global egress -> Define INTERNAL_PREFIXES/.test(error.message),
  );
  assert.doesNotThrow(() => validateInventory(inventory({
    defines: [{ ...define, nodeIds: null }],
    sourcePolicies: [sourcePolicy],
  })));
});

test("rejects direct self recursion and multi-resource dependency cycles", () => {
  const self = policyFunction(
    "function_self",
    "function_self",
    "function function_self() { return function_self(); }",
  );
  assert.throws(
    () => validateInventory(inventory({ functions: [self] })),
    /资源依赖形成循环：Function function_self -> Function function_self/,
  );

  const left = policyFunction(
    "function_left",
    "function_left",
    "function function_left() { return function_right(); }",
  );
  const right = policyFunction(
    "function_right",
    "function_right",
    "function function_right() { return function_left(); }",
  );
  assert.throws(
    () => validateInventory(inventory({ functions: [left, right] })),
    /资源依赖形成循环：Function function_left -> Function function_right -> Function function_left/,
  );

  const defineLeft = {
    id: "define_left", nodeIds: null, label: "Left define", name: "DEFINE_LEFT",
    type: "expression", value: "DEFINE_RIGHT + 1", enabled: true,
  };
  const defineRight = {
    id: "define_right", nodeIds: null, label: "Right define", name: "DEFINE_RIGHT",
    type: "expression", value: "DEFINE_LEFT + 1", enabled: true,
  };
  assert.throws(
    () => validateInventory(inventory({ defines: [defineLeft, defineRight] })),
    /资源依赖形成循环：Define DEFINE_LEFT -> Define DEFINE_RIGHT -> Define DEFINE_LEFT/,
  );
});

test("rejects acyclic forward references that BIRD cannot resolve", () => {
  const first = policyFunction(
    "function_first",
    "function_first",
    "function function_first() { return function_later(); }",
  );
  const later = policyFunction(
    "function_later",
    "function_later",
    "function function_later() { return true; }",
  );
  assert.throws(
    () => validateInventory(inventory({ functions: [first, later] })),
    /声明顺序在后的 Function function_later/,
  );
  assert.doesNotThrow(() => validateInventory(inventory({ functions: [later, first] })));
});

test("keeps rename and delete protection for Static per-route custom blocks", () => {
  const state = inventory({
    staticProtocols: [{
      id: "static_custom",
      nodeId: "left",
      label: "Custom static",
      name: "static_custom",
      family: "ipv4",
      defineId: null,
      action: null,
      routeActions: {},
      routeFilters: {
        "192.0.2.0/24": { operations: [], custom: "CUSTOM_DEPENDENCY();" },
      },
      import: "all",
      export: "none",
      raw: "",
      enabled: true,
    }],
  });
  assert.equal(resourceReferencesSymbol(state, "CUSTOM_DEPENDENCY"), true);
  assert.equal(resourceReferencesSymbol(state, "ONLY_IN_A_COMMENT"), false);
});

test("rejects enabled policies that recursively reach a disabled RPKI source", () => {
  const helper = policyFunction(
    "function_roa_check",
    "function_roa_check",
    "function function_roa_check() { return roa_check(ROA_DN42_V4, net, bgp_path.last) = ROA_VALID; }",
  );
  const filter = {
    id: "filter_import",
    nodeIds: null,
    label: "Import filter",
    name: "filter_import",
    source: "filter filter_import { if function_roa_check() then accept; reject; }",
    enabled: true,
  };
  assert.throws(
    () => validateInventory(inventory({
      functions: [helper],
      filters: [filter],
      rpki: [{ ...scopedRpki, nodeIds: null, enabled: false }],
    })),
    (error) => /已停用的 RPKI rpki_dn42/.test(error.message)
      && /Filter filter_import -> Function function_roa_check -> RPKI rpki_dn42/.test(error.message),
  );
});
