import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

const directory = "/verification";
const node = {
  id: "node_installer_e2e", name: "Installer E2E", transport: "agent",
  routerId: "192.0.2.1", mainConfigPath: "/etc/bird/bird.conf",
  generatedConfigPath: "/var/lib/birdbox/generated.conf", socketPath: "/run/bird/bird.ctl",
};
let cookie = await fs.readFile(`${directory}/cookie`, "utf8").catch(() => "");

async function api(path, method = "GET", body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    method, headers: { cookie, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${value.error ?? "request failed"}`);
  return value;
}

async function writeInstaller(name, result) {
  assert.equal(result.nodeId, node.id);
  await fs.writeFile(`${directory}/${name}.json`, JSON.stringify(result), { mode: 0o600 });
  await fs.writeFile(`${directory}/${name}.sh`, result.script, { mode: 0o600 });
  // The execution command offered by the node editor, including capability download.
  const url = JSON.stringify(result.setupScriptUrl);
  const command = `if command -v curl >/dev/null 2>&1; then curl -fsSL ${url} | sh; elif command -v wget >/dev/null 2>&1; then wget -qO- ${url} | sh; else echo 'missing curl or wget' >&2; exit 1; fi\n`;
  await fs.writeFile(`${directory}/${name}-command.sh`, command, { mode: 0o600 });
}

switch (process.argv[2]) {
  case "setup": {
    const password = `Installer-${randomUUID()}`;
    const response = await fetch("http://127.0.0.1:3000/api/auth/setup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password, confirmation: password }),
    });
    assert.equal(response.status, 201);
    cookie = response.headers.get("set-cookie").split(";")[0];
    await fs.writeFile(`${directory}/cookie`, cookie, { mode: 0o600 });
    await writeInstaller("first", await api("/api/nodes/setup-script", "POST", node));
    console.log("PASS: authenticated onboarding installer retrieval");
    break;
  }
  case "create": {
    const result = await api("/api/nodes", "POST", node);
    assert.equal(result.node.id, node.id);
    assert.equal((await api("/api/nodes/test", "POST", node)).ok, true);
    const resource = await api("/api/statics", "POST", {
      nodeId: node.id, label: "Migration sentinel", name: "installer_sentinel", family: "ipv4",
      raw: "route 198.51.100.0/24 blackhole;", import: "all", export: "none", enabled: true,
    });
    assert.equal(resource.deployment.applied, true);
    await fs.writeFile(`${directory}/inventory.json`, JSON.stringify(resource.inventory), { mode: 0o600 });
    console.log("PASS: Agent registration, connection check and real BIRD resource deployment");
    break;
  }
  case "reinstall": {
    const before = (await api("/api/dashboard")).inventory;
    assert.equal(before.nodes.length, 1);
    await writeInstaller("reinstall", await api(`/api/nodes/${node.id}/reinstall-script`, "POST"));
    assert.deepEqual((await api("/api/dashboard")).inventory, before);
    console.log("PASS: reinstall retrieval preserves inventory and original node identity");
    break;
  }
  case "credentials": {
    for (const name of ["first", "reinstall"]) {
      const { agentToken } = JSON.parse(await fs.readFile(`${directory}/${name}.json`, "utf8"));
      assert.equal((await api("/api/agent/heartbeat", "POST", { nodeId: node.id }, {
        authorization: `Bearer ${agentToken}`,
      })).ok, true);
    }
    console.log("PASS: original and newly issued credentials both authenticate");
    break;
  }
  case "online": {
    const expectedHostname = process.argv[3];
    let online = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await api("/api/agent/status")).agents.find((item) => item.nodeId === node.id);
      if (status?.connected && status.hostname === expectedHostname) { online = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(online, "Agent must register from the expected host");
    assert.equal((await api("/api/nodes/test", "POST", node)).ok, true);
    console.log("PASS: actual Agent on expected host is connected");
    break;
  }
  case "apply": {
    const saved = JSON.parse(await fs.readFile(`${directory}/inventory.json`, "utf8"));
    assert.deepEqual((await api("/api/dashboard")).inventory, saved);
    const result = await api(`/api/nodes/${node.id}`, "PUT", node);
    assert.equal(result.deployment.applied, true);
    assert.deepEqual(result.inventory.staticProtocols, saved.staticProtocols);
    console.log("PASS: saved resources survive reinstall and pass real preflight/deployment");
    break;
  }
  default: throw new Error("Unknown verification action");
}
