import test from "node:test";
import assert from "node:assert/strict";

import { AgentBroker } from "../src/agent-broker.js";
import { MemoryDatabase } from "../src/database.js";

test("Agent broker registers, delivers and resolves a task", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  const token = await broker.issueToken("agent_one");
  await broker.register({ nodeId: "agent_one", token, agentVersion: "test", protocolVersion: 1 });
  const resultPromise = broker.dispatch("agent_one", "legacy.exec", { command: "true" }, 2000);
  const task = await broker.poll("agent_one", token, 1000);
  assert.equal(task?.method, "legacy.exec");
  broker.result({ taskId: task.taskId, nodeId: "agent_one", ok: true, stdout: "ok", stderr: "" }, token);
  assert.equal((await resultPromise).stdout, "ok");
});

test("Agent broker rejects revoked credentials", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  const token = await broker.issueToken("agent_two");
  await broker.revoke("agent_two");
  await assert.rejects(() => broker.register({ nodeId: "agent_two", token, agentVersion: "test", protocolVersion: 1 }), /凭据无效/);
});

test("Agent credential persistence failure leaves the working token and connection intact", async () => {
  class FailingDatabase extends MemoryDatabase {
    failWrites = false;
    async mutateState(...args) {
      if (this.failWrites && args[0] === "agent_credentials") throw new Error("database unavailable");
      return super.mutateState(...args);
    }
  }
  const database = new FailingDatabase();
  const broker = new AgentBroker({ database });
  await broker.initialize();
  const token = await broker.issueToken("durable_agent");
  await broker.register({ nodeId: "durable_agent", token, agentVersion: "test", protocolVersion: 1 });
  database.failWrites = true;
  await assert.rejects(broker.rotateToken("durable_agent"), /database unavailable/);
  await assert.rejects(broker.revoke("durable_agent"), /database unavailable/);
  assert.equal(broker.authenticate("durable_agent", token), true);
  assert.equal(broker.status("durable_agent")?.connected, true);
  database.failWrites = false;
  const reloaded = new AgentBroker({ database });
  await reloaded.initialize();
  assert.equal(reloaded.authenticate("durable_agent", token), true);
});

test("rotating Agent credentials closes old polls and cancels tasks before delivering new work", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  const oldToken = await broker.issueToken("rotated_agent");
  await broker.register({ nodeId: "rotated_agent", token: oldToken, agentVersion: "test", protocolVersion: 1 });
  const inFlight = broker.dispatch("rotated_agent", "bird.apply", {}, 2000);
  const delivered = await broker.poll("rotated_agent", oldToken, 1000);
  const queued = broker.dispatch("rotated_agent", "bird.apply", {}, 2000);
  const nextToken = await broker.rotateToken("rotated_agent");
  assert.equal((await inFlight).code, "AGENT_CREDENTIAL_CHANGED");
  assert.equal((await queued).code, "AGENT_CREDENTIAL_CHANGED");
  assert.equal(broker.status("rotated_agent"), null);
  assert.equal(broker.authenticate("rotated_agent", oldToken), false);
  broker.requeue(delivered);
  const oldPoll = broker.poll("rotated_agent", nextToken, 1000);
  const thirdToken = await broker.rotateToken("rotated_agent");
  assert.equal(await oldPoll, null);
  const fresh = broker.dispatch("rotated_agent", "bird.apply", { config: "fresh" }, 2000);
  const task = await broker.poll("rotated_agent", thirdToken, 1000);
  assert.equal(task.params.config, "fresh");
  broker.result({ taskId: task.taskId, nodeId: task.nodeId, ok: true }, thirdToken);
  assert.equal((await fresh).ok, true);
});

test("Agent broker accepts structured source-policy rule tasks", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  const token = await broker.issueToken("route_agent");
  await broker.register({ nodeId: "route_agent", token, agentVersion: "test", protocolVersion: 1, capabilities: ["network.ip_rules"] });
  const pending = broker.dispatch("route_agent", "network.ip_rules", {
    removeRules: [],
    rules: [{ priority: 10000, source: "192.0.2.0/24", table: 200 }],
  }, 2000);
  const task = await broker.poll("route_agent", token, 1000);
  assert.equal(task?.method, "network.ip_rules");
  broker.result({ taskId: task.taskId, nodeId: task.nodeId, ok: true, stdout: "", stderr: "" }, token);
  assert.equal((await pending).ok, true);
});

test("Agent broker bounds background status work and prioritizes control tasks", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  const token = await broker.issueToken("priority_agent");
  await broker.register({ nodeId: "priority_agent", token, agentVersion: "test", protocolVersion: 1 });

  const background = Array.from({ length: 8 }, (_, index) => broker.dispatch(
    "priority_agent",
    "bird.inspect",
    { node: index },
    2000,
  ));
  const dropped = await broker.dispatch("priority_agent", "system.interfaces", {}, 2000);
  assert.equal(dropped.code, "TASK_DEDUPED");

  const control = broker.dispatch("priority_agent", "bird.apply", { config: "candidate" }, 2000);
  const task = await broker.poll("priority_agent", token, 1000);
  assert.equal(task?.method, "bird.apply");
  broker.result({ taskId: task.taskId, nodeId: task.nodeId, ok: true, stdout: "applied", stderr: "" }, token);
  assert.equal((await control).ok, true);

  for (const pending of background) {
    const queued = await broker.poll("priority_agent", token, 1000);
    assert.equal(queued?.method, "bird.inspect");
    broker.result({ taskId: queued.taskId, nodeId: queued.nodeId, ok: true, stdout: "", stderr: "" }, token);
    assert.equal((await pending).ok, true);
  }
});

test("Agent broker removes expired queued tasks before admitting new work", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  const token = await broker.issueToken("expiry_agent");
  await broker.register({ nodeId: "expiry_agent", token, agentVersion: "test", protocolVersion: 1 });

  const expired = broker.dispatch("expiry_agent", "bird.inspect", { request: "old" }, 250);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const control = broker.dispatch("expiry_agent", "bird.validate", { config: "current" }, 2000);
  const task = await broker.poll("expiry_agent", token, 1000);
  assert.equal(task?.method, "bird.validate");
  broker.result({ taskId: task.taskId, nodeId: task.nodeId, ok: true, stdout: "", stderr: "" }, token);
  assert.equal((await control).ok, true);
  assert.equal((await expired).code, "AGENT_TIMEOUT");
});

test("Agent broker removes an aborted long-poll waiter and requeues the next task", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  const token = await broker.issueToken("abort_agent");
  await broker.register({ nodeId: "abort_agent", token, agentVersion: "test", protocolVersion: 1 });
  const controller = new AbortController();
  const waiter = broker.poll("abort_agent", token, 5000, controller.signal);
  controller.abort();
  assert.equal(await waiter, null);

  const pending = broker.dispatch("abort_agent", "bird.validate", { config: "next" }, 2000);
  const task = await broker.poll("abort_agent", token, 1000);
  assert.equal(task?.method, "bird.validate");
  broker.result({ taskId: task.taskId, nodeId: task.nodeId, ok: true, stdout: "", stderr: "" }, token);
  assert.equal((await pending).ok, true);
});

test("an already aborted Agent poll leaves queued work for the next connection", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  const token = await broker.issueToken("aborted_queue_agent");
  await broker.register({ nodeId: "aborted_queue_agent", token, agentVersion: "test", protocolVersion: 1 });
  const pending = broker.dispatch("aborted_queue_agent", "bird.apply", { config: "next" }, 2000);
  assert.equal(await broker.poll("aborted_queue_agent", token, 1000, AbortSignal.abort()), null);
  const task = await broker.poll("aborted_queue_agent", token, 1000);
  assert.equal(task?.params.config, "next");
  broker.result({ taskId: task.taskId, nodeId: task.nodeId, ok: true }, token);
  assert.equal((await pending).ok, true);
});

test("Agent broker runs batch upgrades strictly one node at a time", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  const tokenA = await broker.issueToken("batch_a");
  const tokenB = await broker.issueToken("batch_b");
  await broker.register({ nodeId: "batch_a", token: tokenA, agentVersion: "old", protocolVersion: 1, architecture: "amd64" });
  await broker.register({ nodeId: "batch_b", token: tokenB, agentVersion: "old", protocolVersion: 1, architecture: "amd64" });

  const job = broker.startBatchUpgrade([
    { nodeId: "batch_a", params: { url: "https://controller/agent-a", sha256: "a" } },
    { nodeId: "batch_b", params: { url: "https://controller/agent-b", sha256: "b" } },
  ]);
  assert.equal(job.status, "running");
  const first = await broker.poll("batch_a", tokenA, 1000);
  assert.equal(first?.method, "agent.self_upgrade");
  assert.equal(broker.batchUpgradeStatus()?.items[0]?.status, "running");
  assert.equal(broker.batchUpgradeStatus()?.items[1]?.status, "pending");

  broker.result({ taskId: first.taskId, nodeId: "batch_a", ok: true, stdout: "", stderr: "", result: { version: "new" } }, tokenA);
  const second = await broker.poll("batch_b", tokenB, 1000);
  assert.equal(second?.method, "agent.self_upgrade");
  assert.equal(broker.batchUpgradeStatus()?.currentNodeId, "batch_b");
  broker.result({ taskId: second.taskId, nodeId: "batch_b", ok: true, stdout: "", stderr: "" }, tokenB);

  for (let attempt = 0; attempt < 20 && broker.batchUpgradeStatus()?.status !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const completed = broker.batchUpgradeStatus();
  assert.equal(completed?.status, "completed");
  assert.deepEqual(completed?.items.map((item) => item.status), ["success", "success"]);
});

test("Agent broker skips offline nodes and continues batch upgrades", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  const token = await broker.issueToken("batch_online");
  await broker.register({ nodeId: "batch_online", token, agentVersion: "old", protocolVersion: 1 });
  const job = broker.startBatchUpgrade([
    { nodeId: "batch_offline", params: {} },
    { nodeId: "batch_online", params: { url: "https://controller/agent", sha256: "a" } },
  ]);
  assert.equal(job.items[0]?.status, "skipped");
  const task = await broker.poll("batch_online", token, 1000);
  assert.equal(task?.method, "agent.self_upgrade");
  broker.result({ taskId: task.taskId, nodeId: "batch_online", ok: true, stdout: "", stderr: "" }, token);
  for (let attempt = 0; attempt < 20 && broker.batchUpgradeStatus()?.status !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const completed = broker.batchUpgradeStatus();
  assert.deepEqual(completed?.items.map((item) => item.status), ["skipped", "success"]);
});

test("Agent broker rejects a second running batch upgrade", async () => {
  const broker = new AgentBroker({ database: new MemoryDatabase() });
  await broker.initialize();
  const token = await broker.issueToken("batch_busy");
  await broker.register({ nodeId: "batch_busy", token, agentVersion: "old", protocolVersion: 1 });
  assert.equal(broker.beginSingleUpgrade(), true);
  assert.equal(broker.beginSingleUpgrade(), false);
  assert.throws(() => broker.startBatchUpgrade([{ nodeId: "batch_busy", params: {} }]), /已有 Agent 批量升级任务正在执行/);
  broker.endSingleUpgrade();
  broker.startBatchUpgrade([{ nodeId: "batch_busy", params: { url: "https://controller/agent", sha256: "a" } }]);
  assert.equal(broker.beginSingleUpgrade(), false);
  assert.throws(
    () => broker.startBatchUpgrade([{ nodeId: "batch_busy", params: {} }]),
    (error) => error?.code === "BATCH_UPGRADE_RUNNING",
  );
  const task = await broker.poll("batch_busy", token, 1000);
  broker.result({ taskId: task.taskId, nodeId: "batch_busy", ok: true, stdout: "", stderr: "" }, token);
});
