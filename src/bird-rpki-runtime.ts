import type { RpkiRoaResponse, RpkiRuntimeResponse } from "../packages/contracts/src/api.js";
import type { AddressFamily, ManagedNode } from "../packages/contracts/src/inventory.js";
import { normalizeId } from "./bird-normalize-common.js";
import { executeNodeCommand, executeNodeRpc } from "./node-executor.js";

type Instance = RpkiRuntimeResponse["nodes"][number]["protocols"][number];
export function parseRpkiRuntime(raw: string, name: string, kind: "RPKI" | "Static"): Pick<Instance, "state" | "rtrState" | "channels"> {
  const lines = raw.replace(/\r/g, "").split("\n").map(line => line.replace(/^\d{4}[- ]/, ""));
  const header = new RegExp(`^${name}\\s+${kind}\\s+\\S+\\s+(\\S+)`, "i");
  const start = lines.findIndex(line => header.test(line));
  if (start < 0) return { state: "not_configured", rtrState: null, channels: [] };
  let end = lines.findIndex((line, index) => index > start && /^\S+\s+(?:BGP|Pipe|Static|RPKI|OSPF|Kernel|Direct|Device|BFD|RIP|Babel)\s+\S+\s+\S+/i.test(line));
  if (end < 0) end = lines.length;
  const block = lines.slice(start, end).join("\n");
  const stateValue = lines[start]!.match(header)![1]!.toLowerCase();
  const state = /\bdisabled\b/i.test(lines[start]!) ? "disabled" : stateValue === "up" || stateValue === "down" || stateValue === "start" ? stateValue : "unknown";
  const channelHeaders = [...block.matchAll(/^\s*Channel roa([46])\s*$/gm)];
  const channels: Instance["channels"] = channelHeaders.map((match, index) => {
    const content = block.slice(match.index! + match[0].length, channelHeaders[index + 1]?.index);
    return { family: match[1] === "4" ? "ipv4" : "ipv6", table: content.match(/^\s*Table:\s+(\S+)/m)?.[1] ?? "",
      state: content.match(/^\s*State:\s+(\S+)/m)?.[1] ?? null,
      imported: content.match(/Routes:\s+(\d+) imported/) ? Number(content.match(/Routes:\s+(\d+) imported/)![1]) : null };
  });
  return { state, rtrState: kind === "RPKI" ? block.match(/^\s*Status:\s+([^\n]+)/m)?.[1]?.trim() ?? null : null, channels };
}

export function parseRoaEntries(raw: string, family: AddressFamily, limit = 200): Pick<RpkiRoaResponse, "entries" | "limit" | "truncated"> {
  const entries: RpkiRoaResponse["entries"] = [];
  let truncated = raw.includes("---BIRDBOX-ROUTE-TRUNCATED---");
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const match = line.replace(/^\d{4}[- ]/, "").match(/^\s*([\da-f:.]+)\/(\d+)(?:-(\d+))?\s+AS(\d+)\s+(.*)/i);
    if (!match || match[1]!.includes(":") !== (family === "ipv6")) continue;
    if (entries.length === limit) { truncated = true; break; }
    entries.push({ prefix: `${match[1]}/${match[2]}`, maxLength: Number(match[3] ?? match[2]), asn: Number(match[4]), protocol: match[5]!.match(/\[([A-Za-z_][A-Za-z0-9_]*)\s/)?.[1] ?? null, raw: line.trim() });
  }
  return { entries, truncated, limit };
}

export async function inspectRoaTable(node: ManagedNode, tableInput: string, family: AddressFamily) {
  const table = normalizeId(tableInput, "ROA Table");
  const result = node.transport === "agent" ? await executeNodeRpc(node, "bird.routes", { socketPath: node.socketPath, table }, 25_000)
    : await executeNodeCommand(node, `birdc -s '${node.socketPath}' 'show route table ${table} all' 2>&1`, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  if (!result.ok) throw new Error(result.stderr || result.stdout || "无法查询 ROA Table");
  if (/^(?:\d{4}[- ])?(?:syntax error|No such|No valid|Table .*not found)/im.test(result.stdout)) throw new Error(result.stdout.trim());
  return parseRoaEntries(result.stdout, family);
}
