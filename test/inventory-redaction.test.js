import test from "node:test";
import assert from "node:assert/strict";

import {
  SECRET_PLACEHOLDER,
  redactPayload,
  restoreSecretPlaceholders,
} from "../src/inventory-redaction.ts";

test("redacts nested routing credentials and config previews", () => {
  const source = {
    inventory: {
      sessions: [{ bgp: { password: "bgp-secret", aoKeys: "key 1 { secret \\\"ao-secret\\\"; };" } }],
      rpki: [{ password: "rpki-secret", birdPrivateKey: "/etc/bird/key" }],
    },
    config: 'password "bgp-secret"; secret "ao-secret";',
  };
  const redacted = redactPayload(source);
  assert.equal(redacted.inventory.sessions[0].bgp.password, SECRET_PLACEHOLDER);
  assert.equal(redacted.inventory.rpki[0].birdPrivateKey, SECRET_PLACEHOLDER);
  assert.doesNotMatch(redacted.config, /bgp-secret|ao-secret/);
  assert.equal(source.inventory.sessions[0].bgp.password, "bgp-secret");
});

test("restores redacted secrets by stable resource identity", () => {
  const previous = {
    nodeConfigs: [{ nodeId: "n1", virtualLinks: [{ id: "1.1.1.1", password: "ospf-secret" }] }],
    sessions: [{ id: "s1", bgp: { password: "bgp-secret" } }],
  };
  const incoming = {
    nodeConfigs: [{ nodeId: "n1", virtualLinks: [{ id: "1.1.1.1", password: SECRET_PLACEHOLDER }] }],
    sessions: [{ id: "s1", bgp: { password: SECRET_PLACEHOLDER } }],
  };
  const restored = restoreSecretPlaceholders(incoming, previous);
  assert.equal(restored.nodeConfigs[0].virtualLinks[0].password, "ospf-secret");
  assert.equal(restored.sessions[0].bgp.password, "bgp-secret");
});
