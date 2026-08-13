import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDefine, renderBirdConfigBundle } from "../src/bird.js";
import { parseBgpq4Json } from "../src/irr-as-set.js";
import { isIrrAsSetName, normalizeIrrAsSetName } from "../src/irr-name.js";

const request = {
  family: 4,
  asSet: "AS-EXAMPLE",
  server: "rr.ntt.net",
  databases: ["TEST"],
  prefixLimit: 3,
  allowMoreSpecific: false,
};

test("accepts regular and hierarchical RPSL AS-SET names", () => {
  assert.equal(isIrrAsSetName("AS-CLOUDFLARE"), true);
  assert.equal(isIrrAsSetName("AS219332:AS-PMMAN"), true);
  assert.equal(isIrrAsSetName("AS219332:AS-PMMAN:AS-CUSTOMERS"), true);
  assert.equal(normalizeIrrAsSetName(" as219332:as-pmman "), "AS219332:AS-PMMAN");
  assert.equal(isIrrAsSetName("AS219332"), false);
  assert.equal(isIrrAsSetName("AS219332:PMMAN"), false);
  assert.equal(isIrrAsSetName("AS-PMMAN;DROP"), false);
});

test("parses bgpq4 prefix JSON with stable deduplication and user limits", () => {
  const output = JSON.stringify({ birdbox_prefixes: [
    { prefix: "198.51.100.0/24", exact: true },
    { prefix: "192.0.2.0/24", exact: true },
    { prefix: "192.0.2.0/24", exact: true },
  ] });
  assert.deepEqual(parseBgpq4Json(output, request).entries, ["192.0.2.0/24", "198.51.100.0/24"]);
  assert.deepEqual(parseBgpq4Json(output, { ...request, allowMoreSpecific: true }).entries, ["192.0.2.0/24+", "198.51.100.0/24+"]);
  assert.throws(() => parseBgpq4Json(output, { ...request, prefixLimit: 1 }), /超过用户设置/);
  assert.throws(() => parseBgpq4Json(JSON.stringify({ x: [{ prefix: "2001:db8::/32", exact: true }] }), request), /IPv4/);
  assert.throws(() => parseBgpq4Json(JSON.stringify({ x: [] }), request), /没有展开/);
});

test("normalizes legacy manual Defines and renders dynamic Defines as standalone files", () => {
  const manual = normalizeDefine({ id: "manual", nodeIds: null, label: "Manual", name: "MANUAL", type: "cidr4", entries: ["192.0.2.0/24"] });
  assert.deepEqual(manual.entrySource, { kind: "manual" });
  const dynamic = normalizeDefine({
    id: "irr_cloud", nodeIds: null, label: "Cloud", name: "CLOUD_V4", type: "cidr4",
    entrySource: { kind: "irr-as-set", asSet: "AS-CLOUDFLARE", server: "rr.ntt.net", databases: ["ARIN"], refreshIntervalSeconds: 3600, prefixLimit: 100, allowMoreSpecific: false },
    entries: ["192.0.2.0/24"],
    sync: { status: "ready", lastAttemptAt: "2026-08-13T00:00:00Z", lastSuccessAt: "2026-08-13T00:00:00Z", nextRefreshAt: "2026-08-13T01:00:00Z", error: null, contentHash: "abc" },
  });
  const node = { id: "remote", kind: "managed-node", name: "Remote", transport: "ssh", sshHost: "192.0.2.2", sshPort: 22, sshUser: "root", sshIdentity: "managed", deploymentMode: "include", mainConfigPath: "/etc/bird.conf", generatedConfigPath: "/var/lib/birdbox/generated.conf", socketPath: "/run/bird/bird.ctl", routerId: "192.0.2.1", listenPort: 179 };
  const bundle = renderBirdConfigBundle(node, [], [], [], [], [manual, dynamic]);
  assert.match(bundle.main, /define MANUAL = \[ 192\.0\.2\.0\/24 \];/);
  assert.match(bundle.main, /include "\/var\/lib\/birdbox\/resources\/define_irr_cloud\.conf";/);
  assert.doesNotMatch(bundle.main, /define CLOUD_V4/);
  assert.deepEqual(bundle.resources.map((item) => item.relativePath), ["define_irr_cloud.conf"]);
  assert.match(bundle.resources[0].content, /define CLOUD_V4 = \[/);
  assert.doesNotMatch(bundle.resources[0].content, /,\n\];/);

  const legacyNode = { ...node, transport: "local", sshHost: null, sshPort: null, sshUser: null, sshIdentity: "default", deploymentMode: "legacy", generatedConfigPath: "/ignored.conf" };
  const legacyBundle = renderBirdConfigBundle(legacyNode, [], [], [], [], [dynamic]);
  assert.match(legacyBundle.main, new RegExp(`include "${process.env.BIRDBOX_RUNTIME_DIR ?? "/var/lib/birdbox-demo"}/resources/define_irr_cloud\\.conf";`));
});
