import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

async function requestJson(port, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await requestJson(port, "/api/health")).status === 200) return;
    } catch {
      // The server may still be creating its controller SSH identity.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Birdbox auth test server did not start");
}

function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

function responseCookie(response) {
  return response.headers.get("set-cookie").split(";", 1)[0];
}

function openSlowLogin(port, body) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/auth/login",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.flushHeaders();
  });
  return { request, response };
}

test("supports password setup and manages multiple active admin sessions", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-auth-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const port = 39000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      BIRDBOX_DATABASE_URL: "memory:",
      BIRDBOX_PORT: String(port),
      BIRDBOX_DATA_DIR: dataDir,
      BIRDBOX_NODES_FILE: path.join(root, "nodes.json"),
      BIRDBOX_SECURE_COOKIE: "false",
    },
    stdio: "ignore",
  });
  context.after(() => stopProcess(child));
  await waitForHealth(port);

  const documentResponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(documentResponse.status, 200);
  assert.match(documentResponse.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(documentResponse.headers.get("x-frame-options"), "DENY");
  assert.match(documentResponse.headers.get("permissions-policy"), /camera=\(\)/);

  const initial = await requestJson(port, "/api/auth/status");
  assert.deepEqual(initial.body, { configured: false, authenticated: false, username: "admin", singleSession: false });

  const invalidJsonShape = await requestJson(port, "/api/auth/login", { method: "POST", body: "null" });
  assert.equal(invalidJsonShape.status, 400);
  assert.match(invalidJsonShape.body.error, /合法对象/);

  const unauthorized = await requestJson(port, "/api/dashboard");
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.code, "AUTH_REQUIRED");
  const unauthorizedSessions = await requestJson(port, "/api/auth/sessions");
  assert.equal(unauthorizedSessions.status, 401);
  assert.equal(unauthorizedSessions.body.code, "AUTH_REQUIRED");
  const unauthorizedMutation = await requestJson(port, "/api/nodes/setup-script", {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(unauthorizedMutation.status, 401);
  assert.equal(unauthorizedMutation.body.code, "AUTH_REQUIRED");

  const weak = await requestJson(port, "/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ password: "short", confirmation: "short" }),
  });
  assert.equal(weak.status, 400);

  const firstPassword = "first-admin-password";
  const setup = await requestJson(port, "/api/auth/setup", {
    method: "POST",
    headers: { "user-agent": "Birdbox setup browser" },
    body: JSON.stringify({ password: firstPassword, confirmation: firstPassword }),
  });
  assert.equal(setup.status, 201);
  assert.match(setup.headers.get("set-cookie"), /birdbox_session=.*HttpOnly; SameSite=Strict/);
  const firstCookie = responseCookie(setup);
  assert.equal((await requestJson(port, "/api/auth/status", { headers: { cookie: firstCookie } })).body.authenticated, true);
  const emptyDashboard = await requestJson(port, "/api/dashboard", { headers: { cookie: firstCookie } });
  assert.equal(emptyDashboard.status, 200);
  assert.equal(emptyDashboard.body.node, null);
  assert.deepEqual(emptyDashboard.body.peers, []);

  const setupScript = await requestJson(port, "/api/nodes/setup-script", {
    method: "POST",
    headers: { cookie: firstCookie },
    body: JSON.stringify({
      name: "Test SSH node",
      sshHost: "router.example",
      sshUser: "birdbox",
      routerId: "192.0.2.1",
    }),
  });
  assert.equal(setupScript.status, 200);
  assert.match(setupScript.body.script, /不能是符号链接/);
  assert.match(setupScript.body.script, /grep -Fx -- "\$KEY_LINE"/);
  assert.match(setupScript.body.script, /useradd --system/);
  assert.match(setupScript.body.script, /adduser --system/);
  assert.match(setupScript.body.script, /BACKUP_CANDIDATE=\$\(mktemp/);
  assert.match(setupScript.body.script, /birdc -s "\$SOCKET_PATH" 'configure check'/);
  assert.match(setupScript.body.script, /birdc -s "\$SOCKET_PATH" configure/);
  assert.match(setupScript.body.script, /用户、SSH 公钥、Include 和 BIRD 配置均已就绪/);
  const shellCheck = spawn("sh", ["-n"], { stdio: ["pipe", "ignore", "pipe"] });
  let shellError = "";
  shellCheck.stderr.setEncoding("utf8");
  shellCheck.stderr.on("data", (chunk) => { shellError += chunk; });
  shellCheck.stdin.end(setupScript.body.script);
  const shellExitCode = await new Promise((resolve, reject) => {
    shellCheck.once("error", reject);
    shellCheck.once("exit", resolve);
  });
  assert.equal(shellExitCode, 0, shellError);

  const rootSetupScript = await requestJson(port, "/api/nodes/setup-script", {
    method: "POST",
    headers: { cookie: firstCookie },
    body: JSON.stringify({
      name: "Root SSH node",
      sshHost: "router.example",
      sshUser: "root",
      routerId: "192.0.2.2",
    }),
  });
  assert.equal(rootSetupScript.status, 400);
  assert.match(rootSetupScript.body.error, /非 root SSH 用户/);

  const wrongLogin = await requestJson(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password: "incorrect-password" }),
  });
  assert.equal(wrongLogin.status, 401);
  assert.equal(wrongLogin.body.code, "AUTH_INVALID");

  const secondLogin = await requestJson(port, "/api/auth/login", {
    method: "POST",
    headers: { "user-agent": "Birdbox second browser" },
    body: JSON.stringify({ password: firstPassword }),
  });
  assert.equal(secondLogin.status, 200);
  const secondCookie = responseCookie(secondLogin);
  assert.notEqual(secondCookie, firstCookie);
  assert.equal((await requestJson(port, "/api/auth/status", { headers: { cookie: firstCookie } })).body.authenticated, true);
  assert.equal((await requestJson(port, "/api/auth/status", { headers: { cookie: secondCookie } })).body.authenticated, true);

  const activeSessions = await requestJson(port, "/api/auth/sessions", { headers: { cookie: secondCookie } });
  assert.equal(activeSessions.status, 200);
  assert.equal(activeSessions.body.sessions.length, 2);
  assert.equal(activeSessions.body.sessions.filter((session) => session.current).length, 1);
  assert.equal(activeSessions.body.sessions.find((session) => session.current).userAgent, "Birdbox second browser");
  const firstSession = activeSessions.body.sessions.find((session) => !session.current);
  assert.ok(firstSession.id);
  assert.ok(firstSession.address);
  assert.equal(firstSession.userAgent, "Birdbox setup browser");

  const revokedFirst = await requestJson(port, `/api/auth/sessions/${firstSession.id}`, {
    method: "DELETE",
    headers: { cookie: secondCookie },
  });
  assert.equal(revokedFirst.status, 200);
  assert.equal(revokedFirst.body.current, false);
  assert.equal((await requestJson(port, "/api/auth/status", { headers: { cookie: firstCookie } })).body.authenticated, false);
  assert.equal((await requestJson(port, "/api/auth/status", { headers: { cookie: secondCookie } })).body.authenticated, true);

  const badCurrentPassword = await requestJson(port, "/api/auth/password", {
    method: "POST",
    headers: { cookie: secondCookie },
    body: JSON.stringify({ currentPassword: "incorrect-password", password: "second-admin-password", confirmation: "second-admin-password" }),
  });
  assert.equal(badCurrentPassword.status, 403);

  const secondPassword = "second-admin-password";
  const changed = await requestJson(port, "/api/auth/password", {
    method: "POST",
    headers: { cookie: secondCookie },
    body: JSON.stringify({ currentPassword: firstPassword, password: secondPassword, confirmation: secondPassword }),
  });
  assert.equal(changed.status, 200);
  const changedCookie = responseCookie(changed);
  assert.equal((await requestJson(port, "/api/auth/status", { headers: { cookie: secondCookie } })).body.authenticated, false);
  assert.equal((await requestJson(port, "/api/auth/status", { headers: { cookie: changedCookie } })).body.authenticated, true);

  const oldPasswordLogin = await requestJson(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password: firstPassword }),
  });
  assert.equal(oldPasswordLogin.status, 401);

  const crossSite = await requestJson(port, "/api/auth/login", {
    method: "POST",
    headers: { origin: "https://example.invalid" },
    body: JSON.stringify({ password: secondPassword }),
  });
  assert.equal(crossSite.status, 403);

  const finalLogin = await requestJson(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password: secondPassword }),
  });
  const finalCookie = responseCookie(finalLogin);
  assert.equal((await requestJson(port, "/api/auth/status", { headers: { cookie: changedCookie } })).body.authenticated, true);
  const revokedOthers = await requestJson(port, "/api/auth/sessions", {
    method: "DELETE",
    headers: { cookie: finalCookie },
  });
  assert.equal(revokedOthers.status, 200);
  assert.equal(revokedOthers.body.revoked, 1);
  assert.equal((await requestJson(port, "/api/auth/status", { headers: { cookie: changedCookie } })).body.authenticated, false);
  assert.equal((await requestJson(port, "/api/auth/status", { headers: { cookie: finalCookie } })).body.authenticated, true);
  const logout = await requestJson(port, "/api/auth/logout", {
    method: "POST",
    headers: { cookie: finalCookie },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await requestJson(port, "/api/auth/status", { headers: { cookie: finalCookie } })).body.authenticated, false);

  const loginBody = JSON.stringify({ password: "incorrect-password" });
  const slowFailures = Array.from({ length: 5 }, () => openSlowLogin(port, loginBody));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const limitedFailures = await Promise.all(Array.from({ length: 3 }, () => requestJson(port, "/api/auth/login", {
    method: "POST",
    body: loginBody,
  })));
  assert.ok(limitedFailures.every((result) => result.status === 429));
  for (const slow of slowFailures) slow.request.end(loginBody);
  const completedFailures = await Promise.all(slowFailures.map((item) => item.response));
  assert.ok(completedFailures.every((result) => result.status === 401));
});

test("rejects an invalid listen port before startup", async () => {
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      BIRDBOX_DATABASE_URL: "memory:",
      BIRDBOX_PORT: "70000",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /BIRDBOX_PORT 必须是 1 到 65535 之间的整数/);
});

test("refuses to rotate a missing controller SSH identity for an existing managed node", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-ssh-identity-required-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "inventory.json"), JSON.stringify({
    version: 17,
    nodes: [{
      id: "node_existing",
      name: "Existing managed node",
      transport: "ssh",
      sshHost: "router.example",
      sshPort: 22,
      sshUser: "birdbox",
      sshIdentity: "managed",
      deploymentMode: "include",
      mainConfigPath: "/etc/bird/bird.conf",
      generatedConfigPath: "/var/lib/birdbox/generated.conf",
      socketPath: "/run/bird/bird.ctl",
      routerId: "192.0.2.1",
      listenPort: 179,
    }],
    peers: [], defines: [], functions: [], filters: [], rpki: [], sessions: [],
  }));
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      BIRDBOX_DATABASE_URL: "memory:",
      BIRDBOX_PORT: "39998",
      BIRDBOX_DATA_DIR: dataDir,
      BIRDBOX_NODES_FILE: path.join(root, "nodes.json"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /SSH 私钥缺失.*拒绝静默轮换身份/);
  await assert.rejects(() => fs.access(path.join(dataDir, "ssh", "id_ed25519")), (error) => error.code === "ENOENT");
});
