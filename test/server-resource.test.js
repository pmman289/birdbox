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
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
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
  const fakeCommand = `#!/bin/sh
printf '%s %s\n' "$0" "$*" >> "$BIRDBOX_FAKE_LOG"
case "$*" in
  *"show route table master4 for 203.0.113.5 all"*)
    printf '%s\n' 'BIRD 2.19.1 ready.' 'Table master4:' \
      '203.0.113.0/24    unicast [test_bgp 10:00:00.000] * (100) [AS65002i]' \
      '  via 192.0.2.2 on eth0'
    exit 0
    ;;
  *"show route table master6 for 2001:db8::5 all"*)
    printf '%s\n' 'BIRD 2.19.1 ready.' 'Table master6:' \
      '2001:db8:100::/48    unicast [test_ospf6 10:00:00.000] * (150)' \
      '  via 2001:db8::2 on eth1'
    exit 0
    ;;
  *"show route table master4 protocol test_bgp all"*)
    printf '%s\n' 'BIRD 2.19.1 ready.' 'Table master4:' \
      '203.0.113.0/24    unicast [test_bgp 10:00:00.000] * (100) [AS65002i]' \
      '  Type: BGP univ' '  BGP.next_hop: 192.0.2.2' '  BGP.as_path: 65002'
    exit 0
    ;;
  *"show route table master4 export test_bgp all"*)
    printf '%s\n' 'BIRD 2.19.1 ready.' 'Table master4:' \
      '198.51.100.0/24   unicast [test_static 10:00:00.000] * (200)' \
      '  Type: static univ' '  BGP.next_hop: 192.0.2.1'
    exit 0
    ;;
esac
if [ -f "$BIRDBOX_FAIL_APPLY" ] && ! printf '%s' "$*" | grep -q -- '-p -c'; then exit 1; fi
exit 0
`;
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
    }, {
      id: "define_static", nodeId: "local", label: "Static routes", name: "STATIC_ROUTES",
      type: "cidr4", entries: ["192.0.2.0/24", "198.51.100.0/24"], enabled: true,
    }],
    functions: [], filters: [], rpki: [], staticProtocols: [],
    sessions: [{
      id: "session_test", nodeId: "local", peerId: "peer", protocolName: "test_bgp",
      localAddress: "192.0.2.1", localAsn: 65001, localPort: 11790,
      exportDefineId: "define_test", enabled: true,
    }],
  });
  await fs.writeFile(path.join(dataDir, "inventory.json"), `${JSON.stringify(state)}\n`);

  const port = 38000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      BIRDBOX_DATABASE_URL: "memory:",
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

  const rejectedDeploymentTargetChange = await authenticatedRequest("/api/nodes/local", {
    method: "PUT",
    body: JSON.stringify({ generatedConfigPath: "/tmp/replaced-birdbox.conf" }),
  });
  assert.equal(rejectedDeploymentTargetChange.status, 409);
  assert.match(rejectedDeploymentTargetChange.body.error, /不可直接修改/);

  const updated = await authenticatedRequest("/api/defines/define_test", {
    method: "PUT",
    body: JSON.stringify({ entries: "203.0.113.0/24" }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.deployment.applied, true);
  assert.deepEqual(updated.body.deployment.sessions.map((session) => session.id), ["session_test"]);
  assert.deepEqual(updated.body.inventory.defines[0].entries, ["203.0.113.0/24"]);
  assert.match(await fs.readFile(fakeLog, "utf8"), /bird .* -c .*bird\.conf/);

  const legacyScoped = await authenticatedRequest("/api/defines/define_test", {
    method: "PUT",
    body: JSON.stringify({ nodeId: "local" }),
  });
  assert.equal(legacyScoped.status, 200);
  assert.deepEqual(legacyScoped.body.resource.nodeIds, ["local"]);
  assert.equal(Object.hasOwn(legacyScoped.body.resource, "nodeId"), false);

  const restoredGlobal = await authenticatedRequest("/api/defines/define_test", {
    method: "PUT",
    body: JSON.stringify({ nodeIds: null }),
  });
  assert.equal(restoredGlobal.status, 200);
  assert.equal(restoredGlobal.body.resource.nodeIds, null);

  const rejectedScope = await authenticatedRequest("/api/defines/define_test", {
    method: "PUT",
    body: JSON.stringify({ nodeIds: ["local", "missing"] }),
  });
  assert.equal(rejectedScope.status, 400);
  assert.match(rejectedScope.body.error, /不存在的节点/);
  const afterRejectedScope = await authenticatedRequest("/api/dashboard");
  assert.equal(afterRejectedScope.body.inventory.defines[0].nodeIds, null);

  const createdRpki = await authenticatedRequest("/api/rpki", {
    method: "POST",
    body: JSON.stringify({
      nodeIds: null,
      label: "API ROA",
      name: "api_roa",
      sourceType: "file",
      roa4Table: "API_ROA4",
      file4: "/dev/null",
      enabled: true,
    }),
  });
  assert.equal(createdRpki.status, 201);
  const createdFunction = await authenticatedRequest("/api/functions", {
    method: "POST",
    body: JSON.stringify({
      nodeIds: null,
      label: "API RPKI policy",
      name: "api_rpki_policy",
      source: "function api_rpki_policy() { return roa_check(API_ROA4, net, bgp_path.last) = ROA_VALID; }",
      enabled: true,
    }),
  });
  assert.equal(createdFunction.status, 201);
  const rejectedRpkiScope = await authenticatedRequest(`/api/rpki/${createdRpki.body.resource.id}`, {
    method: "PUT",
    body: JSON.stringify({ nodeIds: ["local"] }),
  });
  assert.equal(rejectedRpkiScope.status, 400);
  assert.match(rejectedRpkiScope.body.error, /作用域不兼容的 RPKI api_roa/);
  assert.match(rejectedRpkiScope.body.error, /Function api_rpki_policy -> RPKI api_roa/);
  const afterRejectedRpkiScope = await authenticatedRequest("/api/dashboard");
  assert.equal(afterRejectedRpkiScope.body.inventory.rpki.find((resource) => resource.id === createdRpki.body.resource.id).nodeIds, null);

  const createdStatic = await authenticatedRequest("/api/statics", {
    method: "POST",
    body: JSON.stringify({
      nodeId: "local", label: "Test Static", name: "test_static", family: "ipv4",
      defineId: "define_static", action: "blackhole",
      routeActions: { "192.0.2.0/24": "blackhole", "198.51.100.0/24": "via 192.0.2.254" },
      routeFilters: {
        "192.0.2.0/24": { operations: [{ type: "set", attribute: "preference", value: 150 }], custom: "" },
        "198.51.100.0/24": { operations: [], custom: "bgp_med = 50;" },
      },
      import: "none", export: "all", raw: "", enabled: true,
    }),
  });
  assert.equal(createdStatic.status, 201);
  assert.equal(createdStatic.body.deployment.applied, true);
  assert.equal(createdStatic.body.resource.import, "none");
  const staticId = createdStatic.body.resource.id;
  assert.deepEqual(
    createdStatic.body.inventory.staticProtocols.find((resource) => resource.id === staticId).routeActions,
    { "192.0.2.0/24": "blackhole", "198.51.100.0/24": "via 192.0.2.254" },
  );
  assert.equal(
    createdStatic.body.inventory.staticProtocols.find((resource) => resource.id === staticId).routeFilters["192.0.2.0/24"].operations[0].attribute,
    "preference",
  );

  const updatedStatic = await authenticatedRequest(`/api/statics/${staticId}`, {
    method: "PUT",
    body: JSON.stringify({ action: "reject", import: "all", export: "none" }),
  });
  assert.equal(updatedStatic.status, 200);
  assert.equal(updatedStatic.body.resource.action, "reject");
  assert.equal(updatedStatic.body.resource.import, "all");

  const updatedStaticDefine = await authenticatedRequest("/api/defines/define_static", {
    method: "PUT",
    body: JSON.stringify({ entries: ["203.0.113.0/24", "198.51.100.0/24+"] }),
  });
  assert.equal(updatedStaticDefine.status, 200);
  assert.deepEqual(
    updatedStaticDefine.body.inventory.staticProtocols.find((resource) => resource.id === staticId).routeActions,
    { "203.0.113.0/24": "reject" },
  );
  assert.deepEqual(
    updatedStaticDefine.body.inventory.staticProtocols.find((resource) => resource.id === staticId).routeFilters,
    { "203.0.113.0/24": { operations: [], custom: "" } },
  );

  const rejectedStaticMove = await authenticatedRequest(`/api/statics/${staticId}`, {
    method: "PUT",
    body: JSON.stringify({ nodeId: "other" }),
  });
  assert.equal(rejectedStaticMove.status, 409);
  assert.match(rejectedStaticMove.body.error, /不可直接移动/);

  const conflictingStatic = await authenticatedRequest("/api/statics", {
    method: "POST",
    body: JSON.stringify({
      nodeId: "local", label: "Conflict", name: "conflicting_static", family: "ipv4",
      defineId: "define_static", action: "blackhole", import: "all", export: "none", raw: "", enabled: true,
    }),
  });
  assert.equal(conflictingStatic.status, 400);
  assert.match(conflictingStatic.body.error, /冲突的静态路由定义/);
  const afterStaticConflict = await authenticatedRequest("/api/dashboard");
  assert.deepEqual(afterStaticConflict.body.inventory.staticProtocols.map((resource) => resource.id), [staticId]);

  const referencedDefineDelete = await authenticatedRequest("/api/defines/define_static", { method: "DELETE" });
  assert.equal(referencedDefineDelete.status, 409);
  assert.match(referencedDefineDelete.body.error, /Static 资源/);

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

  const importedRoutes = await authenticatedRequest("/api/sessions/session_test/routes?family=ipv4&direction=import");
  assert.equal(importedRoutes.status, 200);
  assert.equal(importedRoutes.body.table, "master4");
  assert.deepEqual(importedRoutes.body.routes.map((route) => route.prefix), ["203.0.113.0/24"]);
  assert.match(importedRoutes.body.routes[0].details, /BGP\.as_path: 65002/);
  const exportedRoutes = await authenticatedRequest("/api/sessions/session_test/routes?family=ipv4&direction=export");
  assert.equal(exportedRoutes.status, 200);
  assert.deepEqual(exportedRoutes.body.routes.map((route) => route.prefix), ["198.51.100.0/24"]);
  const invalidRouteFamily = await authenticatedRequest("/api/sessions/session_test/routes?family=all&direction=import");
  assert.equal(invalidRouteFamily.status, 400);
  const pathLookup = await authenticatedRequest("/api/nodes/local/route-path?target=203.0.113.5");
  assert.equal(pathLookup.status, 200);
  assert.equal(pathLookup.body.family, "ipv4");
  assert.deepEqual(pathLookup.body.routes[0].nextHops, [{ address: "192.0.2.2", interface: "eth0" }]);
  const ipv6PathLookup = await authenticatedRequest("/api/nodes/local/route-path?target=2001:db8::5");
  assert.equal(ipv6PathLookup.status, 200);
  assert.equal(ipv6PathLookup.body.family, "ipv6");
  assert.equal(ipv6PathLookup.body.table, "master6");
  assert.deepEqual(ipv6PathLookup.body.routes[0].nextHops, [{ address: "2001:db8::2", interface: "eth1" }]);
  const invalidPathTarget = await authenticatedRequest("/api/nodes/local/route-path?target=not-an-ip");
  assert.equal(invalidPathTarget.status, 400);

  const disabledSession = await authenticatedRequest("/api/sessions/apply", {
    method: "POST",
    body: JSON.stringify({ ...state.sessions[0], enabled: false }),
  });
  assert.equal(disabledSession.status, 200);
  assert.equal(disabledSession.body.enabled, false);
  const afterDisable = await authenticatedRequest("/api/dashboard");
  assert.equal(afterDisable.body.inventory.sessions[0].enabled, false);
  const runtimeOnly = await authenticatedRequest("/api/nodes/local/runtime");
  assert.equal(runtimeOnly.status, 200);
  assert.equal(runtimeOnly.body.nodeId, "local");
  assert.equal(runtimeOnly.body.runtime.nodeId, "local");
  assert.equal(runtimeOnly.body.sessions[0].id, "session_test");
  assert.match(runtimeOnly.body.config, /router id 192\.0\.2\.1/);
  assert.ok(Array.isArray(runtimeOnly.body.events));

  const rejected = await authenticatedRequest("/api/defines/define_test", {
    method: "PUT",
    body: JSON.stringify({ entries: "203.0.113.0/24\n203.0.113.0/24" }),
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /重复/);
  const afterRejected = await authenticatedRequest("/api/dashboard");
  assert.deepEqual(afterRejected.body.inventory.defines[0].entries, ["203.0.113.0/24"]);

  const deletedStatic = await authenticatedRequest(`/api/statics/${staticId}`, { method: "DELETE" });
  assert.equal(deletedStatic.status, 200);
  assert.deepEqual(deletedStatic.body.inventory.staticProtocols, []);

  const createdSourcePolicy = await authenticatedRequest("/api/source-policies", {
    method: "POST",
    body: JSON.stringify({
      nodeIds: ["local"],
      label: "Public source egress",
      groups: [
        { egressAddress: "172.20.177.36", kernelTable: 50000, sources: ["162.141.136.139/32", "162.141.136.138/32"] },
        { egressAddress: "172.20.177.38", kernelTable: 50001, sources: ["82.47.33.189/32"] },
      ],
      copyInternalRoutes: false,
      internalDefineIds: [],
      enabled: true,
    }),
  });
  assert.equal(createdSourcePolicy.status, 201);
  assert.equal(createdSourcePolicy.body.resource.groups.length, 2);
  assert.equal(createdSourcePolicy.body.resource.groups[0].kernelTable, 50000);
  assert.equal(createdSourcePolicy.body.resource.groups[1].kernelTable, 50001);
  assert.equal(createdSourcePolicy.body.manualPlans.length, 1);
  assert.match(createdSourcePolicy.body.manualPlans[0].applyScript, /ip -4 rule add priority/);
  const sourcePolicyId = createdSourcePolicy.body.resource.id;
  const sourcePolicyPreview = await authenticatedRequest("/api/source-policies/preview", {
    method: "POST",
    body: JSON.stringify({
      id: sourcePolicyId,
      nodeIds: ["local"],
      label: "Preview only",
      groups: [
        { ...createdSourcePolicy.body.resource.groups[0], kernelTable: 50002, sources: ["162.141.136.140/32"] },
        createdSourcePolicy.body.resource.groups[1],
      ],
      copyInternalRoutes: false,
      internalDefineIds: [],
      enabled: true,
    }),
  });
  assert.equal(sourcePolicyPreview.status, 200);
  assert.equal(sourcePolicyPreview.body.resource.groups[0].kernelTable, 50002);
  assert.match(sourcePolicyPreview.body.manualPlans[0].applyScript, /table 50002/);
  const afterPreview = await authenticatedRequest("/api/dashboard");
  assert.equal(afterPreview.body.inventory.sourcePolicies[0].groups[0].kernelTable, 50000);
  const sourcePolicyPlan = await authenticatedRequest(`/api/source-policies/${sourcePolicyId}/plan?nodeId=local`);
  assert.equal(sourcePolicyPlan.status, 200);
  assert.match(sourcePolicyPlan.body.plan.birdConfig, /route 0\.0\.0\.0\/0 recursive 172\.20\.177\.36/);

  const updatedSourcePolicy = await authenticatedRequest(`/api/source-policies/${sourcePolicyId}`, {
    method: "PUT",
    body: JSON.stringify({
      label: "Public source egress updated",
      groups: [
        { ...createdSourcePolicy.body.resource.groups[0], sources: ["162.141.136.139/32", "162.141.136.140/32"] },
        createdSourcePolicy.body.resource.groups[1],
      ],
    }),
  });
  assert.equal(updatedSourcePolicy.status, 200);
  assert.match(updatedSourcePolicy.body.manualPlans[0].applyScript, /162\.141\.136\.140\/32/);

  const conflictingSourcePolicy = await authenticatedRequest("/api/source-policies", {
    method: "POST",
    body: JSON.stringify({
      nodeIds: ["local"],
      label: "Conflict source egress",
      groups: [{ egressAddress: "172.20.177.40", sources: ["162.141.136.0/24"] }],
      copyInternalRoutes: false,
      enabled: true,
    }),
  });
  assert.equal(conflictingSourcePolicy.status, 400);
  assert.match(conflictingSourcePolicy.body.error, /源 CIDR/);

  const deletedSourcePolicy = await authenticatedRequest(`/api/source-policies/${sourcePolicyId}`, { method: "DELETE" });
  assert.equal(deletedSourcePolicy.status, 200);
  assert.match(deletedSourcePolicy.body.manualPlans[0].cleanupScript, /ip -4 rule del priority/);

  await fs.writeFile(failApply, "1\n");
  const failedApply = await authenticatedRequest("/api/defines/define_test", {
    method: "PUT",
    body: JSON.stringify({ entries: "192.0.2.0/24" }),
  });
  assert.equal(failedApply.status, 500);
  const afterFailedApply = await authenticatedRequest("/api/dashboard");
  assert.deepEqual(afterFailedApply.body.inventory.defines[0].entries, ["203.0.113.0/24"]);
});
