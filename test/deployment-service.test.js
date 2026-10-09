import test from "node:test";
import assert from "node:assert/strict";

import { DeploymentService } from "../src/deployment-service.js";
import { validateInventory } from "../src/bird.js";
import { MemoryDatabase } from "../src/database.js";
import { configureAgentBroker } from "../src/node-executor.js";

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

test("stops after the CAS retry limit and preserves a readable conflict", async () => {
  const initial = validateInventory({
    version: 28,
    nodes: [], peers: [], defines: [], functions: [], filters: [], rpki: [],
    staticProtocols: [], directProtocols: [], kernelProtocols: [], sourcePolicies: [],
    sessions: [], ibgpDomains: [], ospfDomains: [], ospfLayout: {},
  });
  let reads = 0;
  let replaces = 0;
  const store = {
    async read() { reads += 1; return structuredClone(initial); },
    async replace() { replaces += 1; throw conflictError(); },
  };
  const service = new DeploymentService({
    database: {}, store, withDeploymentLock: (operation) => operation(),
    configForNode: () => ({ main: "", resources: [] }), emptyConfigForNode: () => ({ main: "", resources: [] }),
    findNode: () => { throw new Error("no nodes expected"); },
    validationError: (_config, diagnostic, fallback) => String(diagnostic || fallback), addEvent: () => undefined,
    fail: (status, message) => { const error = new Error(message); error.status = status; throw error; },
  });
  await assert.rejects(
    service.mutateAndApply((draft) => { draft.ospfDomains = []; return "updated"; }, []),
    (error) => error?.code === "STATE_CONFLICT" && error?.status === 409,
  );
  assert.equal(reads, 3);
  assert.equal(replaces, 3);
});

test("replays remote rollback even when the uncommitted inventory already equals before", async () => {
  const node = {
    id: "recovery_agent", name: "Recovery", transport: "agent", routerId: "192.0.2.1",
    deploymentMode: "include", mainConfigPath: "/etc/bird/bird.conf",
    generatedConfigPath: "/var/lib/birdbox/generated.conf", socketPath: "/run/bird/bird.ctl",
  };
  const before = validateInventory({ version: 28, nodes: [node], peers: [], defines: [], functions: [], filters: [],
    rpki: [], staticProtocols: [], sourcePolicies: [], sessions: [], ibgpDomains: [], ospfDomains: [], ospfLayout: {} });
  const after = structuredClone(before);
  after.nodes[0].name = "Candidate";
  const operations = [];
  configureAgentBroker({
    async dispatch(nodeId, method, params) {
      operations.push({ nodeId, method, config: params.config });
      return { taskId: "recovery", nodeId, ok: true, stdout: "", stderr: "" };
    },
  });
  const database = new MemoryDatabase();
  const service = new DeploymentService({
    database,
    store: { async read() { return structuredClone(before); }, async replace() { assert.fail("unchanged inventory must not be rewritten"); } },
    withDeploymentLock: (operation) => operation(),
    configForNode: (inventory) => ({ main: `# ${inventory.nodes[0].name}\n`, resources: [] }),
    emptyConfigForNode: () => ({ main: "", resources: [] }),
    findNode: (inventory, id) => inventory.nodes.find((item) => item.id === id),
    validationError: (_config, diagnostic, fallback) => String(diagnostic || fallback),
    addEvent: () => undefined, fail: (_status, message) => { throw new Error(message); },
  });
  await service.initialize();
  const active = await service.beginJournal(before, after, [node.id]);
  await service.setJournalDirection(active, "rollback");
  await service.recover();
  assert.deepEqual(operations.map(({ method, config }) => ({ method, config })), [
    { method: "bird.stage", config: "# Recovery\n" },
    { method: "bird.apply", config: "# Recovery\n" },
  ]);
  assert.equal((await service.readJournal()).active, null);
});
