import test from "node:test";
import assert from "node:assert/strict";

import {
  availablePolicySourceReferences,
  policySourceReferenceInsertion,
} from "../apps/web/src/shared/policy-references.ts";

const inventory = {
  defines: [
    { id: "define_global", nodeId: null, name: "GLOBAL", enabled: true },
    { id: "define_local", nodeId: "node_a", name: "LOCAL", enabled: true },
    { id: "define_disabled", nodeId: null, name: "DISABLED", enabled: false },
  ],
  functions: [
    { id: "function_global", nodeId: null, name: "global_helper", enabled: true, callable: true },
    { id: "function_local", nodeId: "node_a", name: "local_helper", enabled: true, callable: false },
    { id: "function_current", nodeId: "node_a", name: "current_helper", enabled: true, callable: true },
    { id: "function_later", nodeId: null, name: "later_helper", enabled: true, callable: true },
    { id: "function_disabled", nodeId: null, name: "disabled_helper", enabled: false, callable: true },
  ],
};

test("lists scope-compatible Defines and earlier Functions for a Function editor", () => {
  const references = availablePolicySourceReferences({
    inventory,
    collection: "functions",
    currentId: "function_current",
    nodeId: "node_a",
  });
  assert.deepEqual(references.defines.map((resource) => resource.id), ["define_global", "define_local"]);
  assert.deepEqual(references.functions.map((resource) => resource.id), ["function_global", "function_local"]);
});

test("lists every compatible Function for a Filter and excludes node-local resources from global scope", () => {
  const nodeReferences = availablePolicySourceReferences({ inventory, collection: "filters", nodeId: "node_a" });
  assert.deepEqual(nodeReferences.functions.map((resource) => resource.id), [
    "function_global", "function_local", "function_current", "function_later",
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
    nodeId: "node_a",
  });
  assert.deepEqual(references.defines.map((resource) => resource.id), ["define_global"]);
  assert.deepEqual(references.functions, []);
  assert.equal(policySourceReferenceInsertion(inventory.functions[0], "function"), "global_helper()");
  assert.equal(policySourceReferenceInsertion(inventory.functions[1], "function"), "local_helper");
  assert.equal(policySourceReferenceInsertion(inventory.defines[0], "define"), "GLOBAL");
});
