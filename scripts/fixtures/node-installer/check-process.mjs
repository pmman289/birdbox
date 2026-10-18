import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const pid = execFileSync("systemctl", ["show", "birdbox-agent", "--property=MainPID", "--value"], { encoding: "utf8" }).trim();
assert.ok(Number(pid) > 0, "Agent service must have a running process");
const running = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
const saved = fs.readFileSync("/etc/birdbox/agent.env", "utf8").split("\n");
for (const name of ["BIRDBOX_AGENT_TOKEN", "BIRDBOX_CONTROLLER_URL", "BIRDBOX_NODE_ID"]) {
  const actual = running.find((item) => item.startsWith(`${name}=`));
  const expected = saved.find((item) => item.startsWith(`${name}=`))?.replaceAll("'", "");
  // Never include credentials in assertion output.
  assert.ok(actual && actual === expected, `Running Agent must use installed ${name}`);
}
console.log("PASS: real systemd process uses the installed identity and credentials");
