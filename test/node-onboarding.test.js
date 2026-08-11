import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  NodeOnboardingService,
  globalRpkiFileRequirements,
  onboardingValidationError,
} from "../src/node-onboarding-service.js";

const globalFileRpki = {
  id: "rpki_global_files",
  nodeId: null,
  label: "DN42 ROA",
  name: "dn42_roa",
  enabled: true,
  sourceType: "file",
  roa4Table: "ROA_DN42_V4",
  roa6Table: "ROA_DN42_V6",
  file4: "/etc/bird/roa_dn42.conf",
  file6: "/etc/bird/roa_dn42_v6.conf",
};

function inventoryWithRpki(rpki) {
  return {
    version: 24,
    nodes: [],
    peers: [],
    defines: [],
    functions: [],
    filters: [],
    rpki,
    staticProtocols: [],
    sessions: [],
    ibgpDomains: [],
  };
}

function shellSyntax(script) {
  const child = spawn("sh", ["-n"], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(script);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

test("adds actionable global RPKI file requirements to node onboarding", async () => {
  const inventory = inventoryWithRpki([
    globalFileRpki,
    { ...globalFileRpki, id: "rpki_disabled", label: "Disabled ROA", enabled: false },
    { ...globalFileRpki, id: "rpki_scoped", label: "Scoped ROA", nodeId: "existing" },
    {
      id: "rpki_global_server",
      nodeId: null,
      label: "RPKI RTR",
      name: "rpki_rtr",
      enabled: true,
      sourceType: "server",
      roa4Table: "ROA_RTR_V4",
      roa6Table: null,
      remote: "rpki.example",
      port: 323,
      transport: "tcp",
    },
  ]);
  const requirements = globalRpkiFileRequirements(inventory);
  assert.deepEqual(requirements, [
    {
      resourceId: "rpki_global_files",
      resourceLabel: "DN42 ROA",
      family: "ipv4",
      path: "/etc/bird/roa_dn42.conf",
    },
    {
      resourceId: "rpki_global_files",
      resourceLabel: "DN42 ROA",
      family: "ipv6",
      path: "/etc/bird/roa_dn42_v6.conf",
    },
  ]);

  const service = new NodeOnboardingService({
    store: { read: async () => inventory },
    deploymentService: {},
    withDeploymentLock: async (operation) => operation(),
    controllerPublicKey: () => "ssh-ed25519 test-controller-key birdbox",
    makeId: () => "unused",
    addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }),
    getEvents: () => [],
  });
  const response = await service.createSetupScript({
    name: "New router",
    sshHost: "192.0.2.10",
    sshUser: "birdbox",
    routerId: "192.0.2.10",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.payload.rpkiRequirements, requirements);
  assert.match(response.payload.script, /全节点 RPKI 资源“DN42 ROA”缺少 IPV4 ROA 文件：\/etc\/bird\/roa_dn42\.conf/);
  assert.match(response.payload.script, /若资源不适用于此节点，请在 Birdbox 中把 RPKI 作用域改为指定节点/);
  assert.doesNotMatch(response.payload.script, /RPKI RTR/);
  assert.ok(response.payload.script.indexOf("RPKI_MISSING=0") < response.payload.script.indexOf("test -f \"$MAIN_CONFIG\""));
  const syntax = await shellSyntax(response.payload.script);
  assert.equal(syntax.code, 0, syntax.stderr);
});

test("maps a missing global RPKI file validation error to its resource and remedy", () => {
  const requirements = globalRpkiFileRequirements(inventoryWithRpki([globalFileRpki]));
  const raw = "Cannot open file /etc/bird/roa_dn42_v6.conf: No such file or directory";
  const message = onboardingValidationError(requirements, raw);
  assert.match(message, /全节点 RPKI 资源“DN42 ROA”/);
  assert.match(message, /IPV6 ROA 文件：\/etc\/bird\/roa_dn42_v6\.conf/);
  assert.match(message, /请先在目标节点部署并持续更新该文件/);
  assert.match(message, /BIRD 原始错误/);
  assert.equal(onboardingValidationError(requirements, "unrelated failure"), "unrelated failure");
});
