import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AuthStore } from "../src/auth.js";
import { AgentBroker } from "../src/agent-broker.js";
import { validateInventory } from "../src/bird.js";
import { MemoryDatabase } from "../src/database.js";
import { createDeploymentRecoveryRunner } from "../src/deployment-recovery.js";
import { createHttpApplication } from "../src/http/application.js";

async function requestJson(port, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await requestJson(port, "/api/health")).status === 200) return;
    } catch {
      // The child process may still be creating its controller SSH identity.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Birdbox deployment test server did not start");
}

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

test("serializes remote validation and deploys global resources through node lifecycle", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-deployment-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const fakeBin = path.join(root, "bin");
  const fakeLog = path.join(root, "ssh.log");
  const capturedConfig = path.join(root, "candidate.conf");
  const holdValidation = path.join(root, "hold-validation");
  const validationEntered = path.join(root, "validation-entered");
  const releaseValidation = path.join(root, "release-validation");
  const shellFailure = path.join(root, "shell-failure");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(fakeBin, { recursive: true });

  const fakeSsh = `#!/bin/sh
printf '%s\n' "$*" >> "$BIRDBOX_FAKE_LOG"
command=''
for argument do command=$argument; done
if [ -f "$BIRDBOX_SHELL_FAILURE" ]; then
  printf '/bin/sh: Permission denied\n' >&2
  exit 126
fi
if printf '%s' "$command" | grep -q -- '---BIRDBOX---'; then
  printf 'BIRD version 2.19.1\n---BIRDBOX---\n'
  exit 0
fi
if printf '%s' "$command" | grep -q -- 'cat >'; then
  if [ -f "$BIRDBOX_HOLD_VALIDATION" ]; then
    : > "$BIRDBOX_VALIDATION_ENTERED"
    attempts=0
    while [ ! -f "$BIRDBOX_RELEASE_VALIDATION" ]; do
      attempts=$((attempts + 1))
      [ "$attempts" -lt 500 ] || exit 124
      sleep 0.02
    done
  fi
  cat > "$BIRDBOX_CAPTURED_CONFIG"
fi
exit 0
`;
  await fs.writeFile(path.join(fakeBin, "ssh"), fakeSsh, { mode: 0o755 });

  const inventory = validateInventory({
    version: 17,
    nodes: [],
    peers: [],
    defines: [{
      id: "define_global",
      nodeId: null,
      label: "Global test Define",
      name: "GLOBAL_TEST",
      type: "expression",
      value: "42",
      enabled: true,
    }],
    functions: [],
    filters: [],
    rpki: [],
    staticProtocols: [],
    sessions: [],
  });
  await fs.writeFile(path.join(dataDir, "inventory.json"), `${JSON.stringify(inventory)}\n`);

  const port = 37000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      BIRDBOX_DATABASE_URL: "memory:",
      BIRDBOX_PORT: String(port),
      BIRDBOX_DATA_DIR: dataDir,
      BIRDBOX_NODES_FILE: path.join(root, "nodes.json"),
      BIRDBOX_FAKE_LOG: fakeLog,
      BIRDBOX_CAPTURED_CONFIG: capturedConfig,
      BIRDBOX_HOLD_VALIDATION: holdValidation,
      BIRDBOX_VALIDATION_ENTERED: validationEntered,
      BIRDBOX_RELEASE_VALIDATION: releaseValidation,
      BIRDBOX_SHELL_FAILURE: shellFailure,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
    stdio: "ignore",
  });
  context.after(() => stopProcess(child));
  await waitForHealth(port);

  const setup = await requestJson(port, "/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ password: "test-admin-password", confirmation: "test-admin-password" }),
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get("set-cookie").split(";", 1)[0];
  const authenticatedRequest = (pathname, options = {}) => requestJson(port, pathname, {
    ...options,
    headers: { cookie, ...(options.headers ?? {}) },
  });
  const nodePayload = {
    name: "Managed SSH node",
    transport: "ssh",
    sshHost: "router.example",
    sshUser: "birdbox",
    routerId: "192.0.2.1",
  };

  await fs.writeFile(shellFailure, "1\n");
  const shellFailureResponse = await authenticatedRequest("/api/nodes/test", {
    method: "POST",
    body: JSON.stringify(nodePayload),
  });
  assert.equal(shellFailureResponse.status, 422);
  assert.match(shellFailureResponse.body.error, /SSH 公钥认证成功/);
  assert.match(shellFailureResponse.body.error, /namei -l \/bin\/sh/);
  await fs.rm(shellFailure);

  await fs.writeFile(holdValidation, "1\n");
  const nodeTest = authenticatedRequest("/api/nodes/test", {
    method: "POST",
    body: JSON.stringify(nodePayload),
  });
  await waitForFile(validationEntered);
  const blockedCreate = await authenticatedRequest("/api/nodes", {
    method: "POST",
    body: JSON.stringify(nodePayload),
  });
  assert.equal(blockedCreate.status, 409);
  assert.match(blockedCreate.body.error, /另一个部署/);
  const blockedPreview = await authenticatedRequest("/api/sessions/preview", {
    method: "POST",
    body: "{}",
  });
  assert.equal(blockedPreview.status, 409);
  assert.match(blockedPreview.body.error, /另一个部署/);
  await fs.writeFile(releaseValidation, "1\n");
  assert.equal((await nodeTest).status, 200);
  assert.match(await fs.readFile(capturedConfig, "utf8"), /define GLOBAL_TEST = 42;/);
  await fs.rm(holdValidation, { force: true });
  await fs.rm(validationEntered, { force: true });
  await fs.rm(releaseValidation, { force: true });

  const created = await authenticatedRequest("/api/nodes", {
    method: "POST",
    body: JSON.stringify(nodePayload),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.deployment.applied, true);
  assert.match(await fs.readFile(capturedConfig, "utf8"), /define GLOBAL_TEST = 42;/);
  const nodeId = created.body.node.id;

  const updatedNode = await authenticatedRequest(`/api/nodes/${nodeId}`, {
    method: "PUT",
    body: JSON.stringify({ sshHost: "replacement.example", sshPort: 2200, igpAddress: "10.0.0.1" }),
  });
  assert.equal(updatedNode.status, 200);
  assert.equal(updatedNode.body.node.sshHost, "replacement.example");
  assert.equal(updatedNode.body.node.sshPort, 2200);
  assert.equal(updatedNode.body.node.igpAddress, "10.0.0.1");
  assert.match(await fs.readFile(fakeLog, "utf8"), /-p 2200 .*birdbox@replacement\.example/);

  const peer = await authenticatedRequest(`/api/nodes/${nodeId}/peers`, {
    method: "POST",
    body: JSON.stringify({ name: "Test peer", address: "192.0.2.2", asn: 65002, port: 179 }),
  });
  assert.equal(peer.status, 201);

  await fs.writeFile(holdValidation, "1\n");
  const preview = authenticatedRequest("/api/sessions/preview", {
    method: "POST",
    body: JSON.stringify({
      nodeId,
      peerId: peer.body.peer.id,
      protocolName: "preview_bgp",
      localAddress: "192.0.2.1",
      localAsn: 65001,
      localPort: 179,
      enabled: false,
    }),
  });
  await waitForFile(validationEntered);
  const blockedNodeTest = await authenticatedRequest("/api/nodes/test", {
    method: "POST",
    body: JSON.stringify({ ...nodePayload, name: "Other node", sshHost: "other.example", routerId: "192.0.2.3" }),
  });
  assert.equal(blockedNodeTest.status, 409);
  assert.match(blockedNodeTest.body.error, /另一个部署/);
  await fs.writeFile(releaseValidation, "1\n");
  const previewResult = await preview;
  assert.equal(previewResult.status, 200);
  assert.equal(previewResult.body.valid, true);
  assert.equal(typeof previewResult.body.sessionConfig, "string");
  assert.doesNotMatch(
    previewResult.body.events.map((entry) => entry.message).join("\n"),
    /正在检查 .*候选配置|候选配置检查通过/,
  );
  await fs.rm(holdValidation, { force: true });
  await fs.rm(validationEntered, { force: true });
  await fs.rm(releaseValidation, { force: true });

  const scopedDefine = await authenticatedRequest("/api/defines", {
    method: "POST",
    body: JSON.stringify({
      nodeId,
      label: "Node-only Define",
      name: "NODE_ONLY",
      type: "expression",
      value: "7",
      enabled: true,
    }),
  });
  assert.equal(scopedDefine.status, 201);
  const scopedFunction = await authenticatedRequest("/api/functions", {
    method: "POST",
    body: JSON.stringify({
      nodeId,
      label: "Node-only Function",
      name: "node_only_function",
      source: "function node_only_function() { return true; }",
      enabled: true,
    }),
  });
  assert.equal(scopedFunction.status, 201);
  const scopedFilter = await authenticatedRequest("/api/filters", {
    method: "POST",
    body: JSON.stringify({
      nodeId,
      label: "Node-only Filter",
      name: "node_only_filter",
      source: "filter node_only_filter { accept; }",
      enabled: true,
    }),
  });
  assert.equal(scopedFilter.status, 201);
  assert.deepEqual(scopedFilter.body.resource.nodeIds, [nodeId]);
  const scopedRpki = await authenticatedRequest("/api/rpki", {
    method: "POST",
    body: JSON.stringify({
      nodeId,
      label: "Node-only ROA",
      name: "node_only_roa",
      sourceType: "file",
      roa4Table: "NODE_ROA4",
      file4: "/dev/null",
      enabled: true,
    }),
  });
  assert.equal(scopedRpki.status, 201);
  assert.deepEqual(scopedRpki.body.resource.nodeIds, [nodeId]);
  const scopedStatic = await authenticatedRequest("/api/statics", {
    method: "POST",
    body: JSON.stringify({
      nodeId,
      label: "Node-only Static",
      name: "node_only_static",
      family: "ipv4",
      defineId: null,
      action: null,
      import: "all",
      export: "none",
      raw: "route 198.51.100.0/24 blackhole;",
      enabled: true,
    }),
  });
  assert.equal(scopedStatic.status, 201);
  assert.match(await fs.readFile(capturedConfig, "utf8"), /protocol static node_only_static/);
  const appliedSession = await authenticatedRequest("/api/sessions/apply", {
    method: "POST",
    body: JSON.stringify({
      nodeId,
      peerId: peer.body.peer.id,
      protocolName: "preview_bgp",
      localAddress: "192.0.2.1",
      localAsn: 65001,
      localPort: 179,
      enabled: false,
    }),
  });
  assert.equal(appliedSession.status, 200);
  const appliedMessages = appliedSession.body.events.map((entry) => entry.message).join("\n");
  assert.doesNotMatch(appliedMessages, /正在检查 .*候选配置|候选配置检查通过|正在向 .*应用配置|BIRD 2 实例已接受配置/);
  assert.match(appliedMessages, /会话 preview_bgp 已停用/);

  const enabledApplyStarted = Date.now();
  const enabledSession = await authenticatedRequest("/api/sessions/apply", {
    method: "POST",
    body: JSON.stringify({
      nodeId,
      peerId: peer.body.peer.id,
      protocolName: "preview_bgp",
      localAddress: "192.0.2.1",
      localAsn: 65001,
      localPort: 179,
      enabled: true,
    }),
  });
  assert.equal(enabledSession.status, 202);
  assert.equal(enabledSession.body.applied, true);
  assert.equal(enabledSession.body.established, false);
  assert.match(enabledSession.body.sessionConfig, /protocol bgp preview_bgp/);
  assert.ok(Date.now() - enabledApplyStarted < 5000, "会话应用接口不应等待 BGP 状态建立");

  await fs.writeFile(holdValidation, "1\n");
  const previewBeforeDelete = authenticatedRequest("/api/sessions/preview", {
    method: "POST",
    body: JSON.stringify({
      nodeId,
      peerId: peer.body.peer.id,
      protocolName: "preview_bgp",
      localAddress: "192.0.2.1",
      localAsn: 65001,
      localPort: 179,
      enabled: false,
    }),
  });
  await waitForFile(validationEntered);
  const forgottenPromise = authenticatedRequest(`/api/nodes/${nodeId}?force=true`, { method: "DELETE" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await authenticatedRequest("/api/health")).body.deploymentLocked, true);
  await fs.writeFile(releaseValidation, "1\n");
  assert.equal((await previewBeforeDelete).status, 200);
  const sshLogBeforeForce = await fs.readFile(fakeLog, "utf8");
  const forgotten = await forgottenPromise;
  assert.equal(forgotten.status, 200);
  assert.equal(forgotten.body.cleanupRequired, true);
  assert.equal(forgotten.body.deployment.applied, false);
  assert.deepEqual(forgotten.body.inventory.nodes, []);
  assert.deepEqual(forgotten.body.inventory.peers, []);
  assert.deepEqual(forgotten.body.inventory.sessions, []);
  assert.deepEqual(forgotten.body.inventory.defines.map((item) => item.name), ["GLOBAL_TEST"]);
  assert.deepEqual(forgotten.body.inventory.functions, []);
  assert.deepEqual(forgotten.body.inventory.filters, []);
  assert.deepEqual(forgotten.body.inventory.rpki, []);
  assert.deepEqual(forgotten.body.inventory.staticProtocols, []);
  assert.equal(forgotten.body.events.at(-1).level, "warning");
  assert.equal(await fs.readFile(fakeLog, "utf8"), sshLogBeforeForce, "force forget must not contact the offline node");
  await fs.rm(holdValidation, { force: true });
  await fs.rm(validationEntered, { force: true });
  await fs.rm(releaseValidation, { force: true });

  const recreated = await authenticatedRequest("/api/nodes", {
    method: "POST",
    body: JSON.stringify(nodePayload),
  });
  assert.equal(recreated.status, 201);
  const removed = await authenticatedRequest(`/api/nodes/${recreated.body.node.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deployment.applied, true);
  assert.deepEqual(removed.body.inventory.nodes, []);
  const decommissionedConfig = await fs.readFile(capturedConfig, "utf8");
  assert.match(decommissionedConfig, /included by the system BIRD configuration/);
  assert.doesNotMatch(decommissionedConfig, /GLOBAL_TEST/);

  await fs.writeFile(holdValidation, "1\n");
  const drainingRequest = authenticatedRequest("/api/nodes/test", {
    method: "POST",
    body: JSON.stringify(nodePayload),
  });
  await waitForFile(validationEntered);
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, "SIGTERM must not interrupt an active deployment");
  await fs.writeFile(releaseValidation, "1\n");
  assert.equal((await drainingRequest).status, 200);
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test("starts HTTP before pending deployment recovery and unlocks after Agent replay", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-recovery-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  const database = new MemoryDatabase();
  const authStore = new AuthStore({ database, dataDir: root });
  await database.initialize();
  await authStore.initialize();
  const agentBroker = new AgentBroker({ database });
  await agentBroker.initialize();
  const agentToken = await agentBroker.issueToken("recovery_agent");
  const events = [];
  let recoveryState = "pending";
  const withDeploymentLock = async (operation) => {
    if (recoveryState !== "idle") {
      const error = new Error("未完成部署恢复，暂不接受新的部署");
      error.status = 503;
      error.code = "DEPLOYMENT_RECOVERY_PENDING";
      throw error;
    }
    return operation();
  };
  const mutationService = new Proxy({}, {
    get: (_target, property) => {
      if (property === "createStatic") {
        return async () => withDeploymentLock(async () => ({ status: 201, payload: { ok: true } }));
      }
      return async () => ({ status: 200, payload: {} });
    },
  });
  const recoveryRunner = createDeploymentRecoveryRunner({
    pending: true,
    onStateChange: (state) => { recoveryState = state; },
    recover: async () => {
      const result = await agentBroker.dispatch("recovery_agent", "bird.apply", { config: "recovery-candidate" }, 3000);
      if (!result.ok) throw new Error(result.stderr || result.code || "Agent 恢复任务失败");
    },
    initialDelayMs: 5,
    maxDelayMs: 10,
  });
  const app = await createHttpApplication({
    publicDirectory: path.resolve("public"),
    appVersion: "test",
    authStore,
    store: {},
    secureCookieSetting: false,
    ping: async () => true,
    isDeploymentLocked: () => recoveryState !== "idle",
    recoveryState: () => recoveryState,
    loadDashboard: async () => ({}),
    withDeploymentLock,
    withNodeOperationLock: async (_nodeId, operation) => operation(),
    mutationService,
    addEvent: (level, message, nodeId = null) => {
      const event = { level, message: String(message), nodeId };
      events.push(event);
      return event;
    },
    getEvents: () => events,
    agentBroker,
    database,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const jsonRequest = (pathname, options = {}) => fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });

  // The listener is available while recovery is still waiting for Agent work.
  const pendingHealth = await jsonRequest("/api/health");
  assert.equal(pendingHealth.status, 200);
  assert.deepEqual(await pendingHealth.json(), { status: "ok", deploymentLocked: true, recovery: "pending" });

  const setup = await jsonRequest("/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ password: "recovery-test-password", confirmation: "recovery-test-password" }),
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get("set-cookie").split(";", 1)[0];
  const blockedMutation = await jsonRequest("/api/statics", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({}),
  });
  assert.equal(blockedMutation.status, 503);
  assert.match((await blockedMutation.json()).error, /恢复/);

  const recoveryPromise = recoveryRunner.run();
  const register = await jsonRequest("/api/agent/register", {
    method: "POST",
    body: JSON.stringify({ nodeId: "recovery_agent", token: agentToken, agentVersion: "test", protocolVersion: 1 }),
  });
  assert.equal(register.status, 200);
  const poll = await jsonRequest("/api/agent/tasks/poll", {
    method: "POST",
    headers: { authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ nodeId: "recovery_agent" }),
  });
  assert.equal(poll.status, 200);
  const task = (await poll.json()).task;
  assert.equal(task.method, "bird.apply");
  const result = await jsonRequest(`/api/agent/tasks/${task.taskId}/result`, {
    method: "POST",
    headers: { authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ nodeId: "recovery_agent", ok: true, stdout: "", stderr: "" }),
  });
  assert.equal(result.status, 200);
  await recoveryPromise;

  const recoveredHealth = await jsonRequest("/api/health");
  assert.equal(recoveredHealth.status, 200);
  assert.deepEqual(await recoveredHealth.json(), { status: "ok", deploymentLocked: false, recovery: "idle" });
  const mutation = await jsonRequest("/api/statics", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({}),
  });
  assert.equal(mutation.status, 201);
});
