import test from "node:test";
import assert from "node:assert/strict";

import {
  availablePolicySourceReferences,
  policySourceReferenceInsertion,
} from "../apps/web/src/shared/policy-references.ts";

const inventory = {
  defines: [
    { id: "define_global", nodeIds: null, name: "GLOBAL", enabled: true },
    { id: "define_local", nodeIds: ["node_a"], name: "LOCAL", enabled: true },
    { id: "define_shared", nodeIds: ["node_a", "node_b"], name: "SHARED", enabled: true },
    { id: "define_disabled", nodeIds: null, name: "DISABLED", enabled: false },
  ],
  functions: [
    { id: "function_global", nodeIds: null, name: "global_helper", enabled: true, callable: true },
    { id: "function_local", nodeIds: ["node_a"], name: "local_helper", enabled: true, callable: false },
    { id: "function_shared", nodeIds: ["node_a", "node_b"], name: "shared_helper", enabled: true, callable: true },
    { id: "function_current", nodeIds: ["node_a", "node_b"], name: "current_helper", enabled: true, callable: true },
    { id: "function_later", nodeIds: null, name: "later_helper", enabled: true, callable: true },
    { id: "function_disabled", nodeIds: null, name: "disabled_helper", enabled: false, callable: true },
  ],
};

test("lists scope-compatible Defines and earlier Functions for a Function editor", () => {
  const references = availablePolicySourceReferences({
    inventory,
    collection: "functions",
    currentId: "function_current",
    nodeIds: ["node_a", "node_b"],
  });
  assert.deepEqual(references.defines.map((resource) => resource.id), ["define_global", "define_shared"]);
  assert.deepEqual(references.functions.map((resource) => resource.id), ["function_global", "function_shared"]);
});

test("lists every compatible Function for a Filter and excludes node-local resources from global scope", () => {
  const nodeReferences = availablePolicySourceReferences({ inventory, collection: "filters", nodeId: "node_a" });
  assert.deepEqual(nodeReferences.functions.map((resource) => resource.id), [
    "function_global", "function_local", "function_shared", "function_current", "function_later",
  ]);

  const globalReferences = availablePolicySourceReferences({ inventory, collection: "filters", nodeId: null });
  assert.deepEqual(globalReferences.defines.map((resource) => resource.id), ["define_global"]);
  assert.deepEqual(globalReferences.functions.map((resource) => resource.id), ["function_global", "function_later"]);
});

test("keeps expression Define references ordered and inserts callable Functions safely", () => {
  const references = availablePolicySourceReferences({
    inventory,
    collection: "defines",
    currentId: "define_local",
    nodeIds: ["node_a"],
  });
  assert.deepEqual(references.defines.map((resource) => resource.id), ["define_global"]);
  assert.deepEqual(references.functions, []);
  assert.equal(policySourceReferenceInsertion(inventory.functions[0], "function"), "global_helper()");
  assert.equal(policySourceReferenceInsertion(inventory.functions[1], "function"), "local_helper");
  assert.equal(policySourceReferenceInsertion(inventory.defines[0], "define"), "GLOBAL");
});
