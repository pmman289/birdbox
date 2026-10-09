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

test("redacts entire escaped BIRD credentials including key paths", () => {
  const result = redactPayload({ config: String.raw`password "prefix\"secret-suffix"; secret "ao\\secret"; bird private key "/private/key"; remote public key "/remote/key";` });
  assert.equal(result.config, 'password "********"; secret "********"; bird private key "********"; remote public key "********";');
});

test("does not restore a new identified record from an unrelated array position", () => {
  const previous = { links: [{ id: "old", options: { password: "old-secret" } }] };
  const restored = restoreSecretPlaceholders({ links: [{ id: "new", options: { password: SECRET_PLACEHOLDER } }] }, previous);
  assert.equal(restored.links[0].options.password, SECRET_PLACEHOLDER);
});

test("restores virtual-link passwords by Router ID and transit area", () => {
  const previous = { virtualLinks: [
    { id: "192.0.2.2", area: "0.0.0.1", password: "first-secret" },
    { id: "192.0.2.2", area: "0.0.0.2", password: "second-secret" },
  ] };
  const incoming = { virtualLinks: [...previous.virtualLinks].reverse().map((link) => ({ ...link, password: SECRET_PLACEHOLDER })) };
  const restored = restoreSecretPlaceholders(incoming, previous);
  assert.deepEqual(restored.virtualLinks.map((link) => link.password), ["second-secret", "first-secret"]);
});
