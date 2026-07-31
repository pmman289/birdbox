import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { validateInventory } from "../src/bird.js";

async function requestJson(port, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const result = await requestJson(port, "/api/health");
      if (result.status === 200) return;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("BirdBox test server did not start");
}

function stopProcess(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

test("resource PUT applies to existing sessions and rejects invalid edits atomically", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-api-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const runtimeDir = path.join(root, "runtime");
  const fakeBin = path.join(root, "bin");
  const fakeLog = path.join(root, "commands.log");
  const failApply = path.join(root, "fail-apply");
  const bashEnv = path.join(root, "bash.env");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeCommand = "#!/bin/sh\nprintf '%s %s\\n' \"$0\" \"$*\" >> \"$BIRDBOX_FAKE_LOG\"\nif [ -f \"$BIRDBOX_FAIL_APPLY\" ] && ! printf '%s' \"$*\" | grep -q -- '-p -c'; then exit 1; fi\nexit 0\n";
  await fs.writeFile(path.join(fakeBin, "bird"), fakeCommand, { mode: 0o755 });
  await fs.writeFile(path.join(fakeBin, "birdc"), fakeCommand, { mode: 0o755 });
  await fs.writeFile(bashEnv, `export PATH=${fakeBin}:$PATH\n`);

  const state = validateInventory({
    version: 17,
    nodes: [{ id: "local", name: "Test node", transport: "local", routerId: "192.0.2.1", listenPort: 11790 }],
    peers: [{ id: "peer", nodeId: "local", name: "Test peer", address: "192.0.2.2", asn: 65002, port: 179 }],
    defines: [{
      id: "define_test", nodeId: null, label: "Test exports", name: "TEST_EXPORTS",
      type: "cidr4", entries: ["198.51.100.0/24"], enabled: true,
    }],
    functions: [], filters: [], rpki: [],
    sessions: [{
      id: "session_test", nodeId: "local", peerId: "peer", protocolName: "test_bgp",
      localAddress: "192.0.2.1", localAsn: 65001, localPort: 11790,
      exportDefineId: "define_test", routeAction: "blackhole", enabled: true,
    }],
  });
  await fs.writeFile(path.join(dataDir, "inventory.json"), `${JSON.stringify(state)}\n`);

  const port = 38000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    env: {
      ...process.env,
      BIRDBOX_PORT: String(port),
      BIRDBOX_DATA_DIR: dataDir,
      BIRDBOX_NODES_FILE: path.join(root, "nodes.json"),
      BIRDBOX_RUNTIME_DIR: runtimeDir,
      BIRDBOX_SOCKET_PATH: path.join(runtimeDir, "bird.ctl"),
      BIRDBOX_PID_PATH: path.join(runtimeDir, "bird.pid"),
      BIRDBOX_FAKE_LOG: fakeLog,
      BIRDBOX_FAIL_APPLY: failApply,
      BASH_ENV: bashEnv,
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

  const rejectedLocalNode = await authenticatedRequest("/api/nodes", {
    method: "POST",
    body: JSON.stringify({
      name: "Rejected local node", transport: "local", routerId: "192.0.2.250", listenPort: 179,
    }),
  });
  assert.equal(rejectedLocalNode.status, 400);
  assert.match(rejectedLocalNode.body.error, /仅支持 SSH/);

  const updated = await authenticatedRequest("/api/defines/define_test", {
    method: "PUT",
    body: JSON.stringify({ entries: "203.0.113.0/24" }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.deployment.applied, true);
  assert.deepEqual(updated.body.deployment.sessions.map((session) => session.id), ["session_test"]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, "inventory.json"))).defines[0].entries, ["203.0.113.0/24"]);
  assert.match(await fs.readFile(fakeLog, "utf8"), /bird .* -c .*bird\.conf/);

  const stopped = await authenticatedRequest("/api/sessions/session_test/control", {
    method: "POST",
    body: JSON.stringify({ action: "disable" }),
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.action, "disable");
  assert.match(await fs.readFile(fakeLog, "utf8"), /birdc .*disable test_bgp/);
  const started = await authenticatedRequest("/api/sessions/session_test/control", {
    method: "POST",
    body: JSON.stringify({ action: "enable" }),
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.action, "enable");
  assert.match(await fs.readFile(fakeLog, "utf8"), /birdc .*enable test_bgp/);

  const disabledSession = await authenticatedRequest("/api/sessions/apply", {
    method: "POST",
    body: JSON.stringify({ ...state.sessions[0], enabled: false }),
  });
  assert.equal(disabledSession.status, 200);
  assert.equal(disabledSession.body.enabled, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "inventory.json"))).sessions[0].enabled, false);

  const rejected = await authenticatedRequest("/api/defines/define_test", {
    method: "PUT",
    body: JSON.stringify({ entries: "203.0.113.0/24\n203.0.113.0/24" }),
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /重复/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, "inventory.json"))).defines[0].entries, ["203.0.113.0/24"]);

  await fs.writeFile(failApply, "1\n");
  const failedApply = await authenticatedRequest("/api/defines/define_test", {
    method: "PUT",
    body: JSON.stringify({ entries: "192.0.2.0/24" }),
  });
  assert.equal(failedApply.status, 500);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, "inventory.json"))).defines[0].entries, ["203.0.113.0/24"]);
});
