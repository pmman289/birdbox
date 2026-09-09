import test from "node:test";
import assert from "node:assert/strict";

import { DeploymentService } from "../src/deployment-service.js";
import { validateInventory } from "../src/bird.js";

function conflictError() {
  const error = new Error("数据已被其他操作更新，请刷新后重试");
  error.code = "STATE_CONFLICT";
  error.status = 409;
  return error;
}

test("retries a deployment after a concurrent inventory revision conflict", async () => {
  const initial = validateInventory({
    version: 28,
    nodes: [],
    peers: [],
    defines: [],
    functions: [],
    filters: [],
    rpki: [],
    staticProtocols: [],
    sourcePolicies: [],
    sessions: [],
    ibgpDomains: [],
    ospfDomains: [],
    ospfLayout: {},
  });
  let reads = 0;
  let replaces = 0;
  const store = {
    async read() {
      reads += 1;
      return structuredClone(initial);
    },
    async replace(_current, value) {
      replaces += 1;
      if (replaces === 1) throw conflictError();
      return { value: structuredClone(value), revision: replaces + 1 };
    },
  };
  const service = new DeploymentService({
    database: {},
    store,
    withDeploymentLock: (operation) => operation(),
    configForNode: () => ({ main: "", resources: [] }),
    emptyConfigForNode: () => ({ main: "", resources: [] }),
    findNode: () => { throw new Error("no nodes expected"); },
    validationError: (_config, diagnostic, fallback) => String(diagnostic || fallback),
    addEvent: () => undefined,
    fail: (status, message) => {
      const error = new Error(message);
      error.status = status;
      throw error;
    },
  });

  const result = await service.mutateAndApply(
    (draft) => {
      draft.ospfDomains = [];
      return "updated";
    },
    [],
  );

  assert.equal(result.result, "updated");
  assert.equal(reads, 2);
  assert.equal(replaces, 2);
});
