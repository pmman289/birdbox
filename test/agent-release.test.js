import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildAgentUpgradeParams, normalizeAgentArch } from "../src/agent-release.js";

test("normalizes every published Agent architecture without an amd64 fallback", () => {
  const expected = new Map([
    ["x86_64", "amd64"], ["aarch64", "arm64"], ["armv7l", "arm"],
    ["armv6l", "armv6"], ["armv5l", "armv5"], ["mips", "mips"],
    ["mipsel", "mipsle"], ["mips64", "mips64"], ["mips64el", "mips64le"],
    ["riscv64", "riscv64"],
  ]);
  for (const [input, output] of expected) assert.equal(normalizeAgentArch(input), output);
  assert.equal(normalizeAgentArch("unknown-cpu"), null);
  assert.equal(normalizeAgentArch(""), null);
});

test("builds fixed Agent upgrade parameters from the registered architecture", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "birdbox-agent-release-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "birdbox-agent-armv6"), "agent-armv6\n");
  const params = await buildAgentUpgradeParams({
    architecture: "armv6l",
    publicUrl: "https://controller.example/",
    binaryBase: directory,
    version: "test-version",
  });
  assert.match(String(params.url), /arch=armv6/);
  assert.equal(params.targetPath, "/usr/local/bin/birdbox-agent");
  assert.equal(params.service, "birdbox-agent");
  assert.equal(params.version, "test-version");
  assert.match(String(params.sha256), /^[0-9a-f]{64}$/);
  await assert.rejects(
    () => buildAgentUpgradeParams({ architecture: "unknown", publicUrl: "https://controller.example", binaryBase: directory, version: "test" }),
    (error) => error?.code === "AGENT_ARCH_UNSUPPORTED" && error?.status === 409,
  );
});
