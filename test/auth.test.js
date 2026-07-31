import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
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
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

function responseCookie(response) {
  return response.headers.get("set-cookie").split(";", 1)[0];
}

test("supports password setup and enforces one active admin session", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-auth-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const port = 39000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    env: {
      ...process.env,
      BIRDBOX_PORT: String(port),
      BIRDBOX_DATA_DIR: dataDir,
      BIRDBOX_NODES_FILE: path.join(root, "nodes.json"),
      BIRDBOX_SECURE_COOKIE: "false",
    },
    stdio: "ignore",
  });
  context.after(() => stopProcess(child));
  await waitForHealth(port);

  const initial = await requestJson(port, "/api/auth/status");
  assert.deepEqual(initial.body, { configured: false, authenticated: false, username: "admin", singleSession: true });

  const unauthorized = await requestJson(port, "/api/dashboard");
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.code, "AUTH_REQUIRED");

  const weak = await requestJson(port, "/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ password: "short", confirmation: "short" }),
  });
  assert.equal(weak.status, 400);

  const firstPassword = "first-admin-password";
  const setup = await requestJson(port, "/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ password: firstPassword, confirmation: firstPassword }),
  });
  assert.equal(setup.status, 201);
  assert.match(setup.headers.get("set-cookie"), /birdbox_session=.*HttpOnly; SameSite=Strict/);
  const firstCookie = responseCookie(setup);
  assert.equal((await requestJson(port, "/api/auth/status", { headers: { cookie: firstCookie } })).body.authenticated, true);

  const authFile = await fs.readFile(path.join(dataDir, "auth.json"), "utf8");
  assert.doesNotMatch(authFile, new RegExp(firstPassword));
  assert.equal((await fs.stat(path.join(dataDir, "auth.json"))).mode & 0o777, 0o600);

  const wrongLogin = await requestJson(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password: "incorrect-password" }),
  });
  assert.equal(wrongLogin.status, 401);
  assert.equal(wrongLogin.body.code, "AUTH_INVALID");

  const secondLogin = await requestJson(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password: firstPassword }),
  });
  assert.equal(secondLogin.status, 200);
  const secondCookie = responseCookie(secondLogin);
  assert.notEqual(secondCookie, firstCookie);
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
  const logout = await requestJson(port, "/api/auth/logout", {
    method: "POST",
    headers: { cookie: finalCookie },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await requestJson(port, "/api/auth/status", { headers: { cookie: finalCookie } })).body.authenticated, false);
});
