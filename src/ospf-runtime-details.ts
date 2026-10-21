import type { OspfProtocolRuntime } from "../packages/contracts/src/api.js";

/** Protocol state and Area data come from BIRD's own protocol details,
 * independently of neighbor counts and the current editor draft. */
export function parseOspfProtocolRuntime(raw: string, name: string, stateDetails?: { ok: boolean; output: string }): OspfProtocolRuntime {
  const lines = raw.replace(/\r/g, "").split("\n").map(line => line.replace(/^\d{4}[- ]/, ""));
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^${escaped}\\s+OSPF\\s+\\S+\\s+(\\S+)`, "i");
  const start = lines.findIndex(line => header.test(line));
  if (start < 0) return { state: "not_configured", areas: [], raw, error: null };
  const end = lines.findIndex((line, index) => index > start && /^\S+\s+(?:OSPF|BGP|Direct|Kernel|Static|Pipe|RPKI|Device|BFD)\s+\S+\s+\S+/.test(line));
  const block = lines.slice(start, end < 0 ? undefined : end);
  const state = block[0]!.match(header)![1]!.toLowerCase();
  const areas: OspfProtocolRuntime["areas"] = [];
  let stateLines = block.slice(1);
  if (stateDetails) {
    const output = stateDetails.output.replace(/\r/g, "").split("\n").map(line => line.replace(/^\d{4}[- ]/, ""));
    const stateStart = output.findIndex(line => line.trim() === `${name}:`);
    const stateEnd = output.findIndex((line, index) => index > stateStart && /^\S+:\s*$/.test(line) && line.trim() !== `${name}:`);
    stateLines = stateDetails.ok && stateStart >= 0 ? output.slice(stateStart + 1, stateEnd < 0 ? undefined : stateEnd) : [];
  }
  for (const line of stateLines) {
    const area = line.trim().match(/^Area:?\s+(\d+\.\d+\.\d+\.\d+)\b/i);
    if (area) areas.push({ area: area[1]!, interfaces: null, neighbors: null, adjacentNeighbors: null, raw: line });
    else if (areas.length) {
      const current = areas[areas.length - 1]!;
      current.raw += `\n${line}`;
      const count = line.match(/^\s*(?:Number of )?(Interfaces|Neighbors|Adjacent neighbors):\s*(\d+)/i);
      if (count) {
        if (count[1]!.toLowerCase() === "interfaces") current.interfaces = Number(count[2]);
        else if (count[1]!.toLowerCase() === "neighbors") current.neighbors = Number(count[2]);
        else current.adjacentNeighbors = Number(count[2]);
      }
      if (/^\s*Stub:\s*Yes\b/i.test(line)) current.type = "stub";
      if (/^\s*Stub:\s*No\b/i.test(line)) current.type = "normal";
      if (/^\s*NSSA:\s*Yes\b/i.test(line)) current.type = "nssa";
    }
  }
  const declaredCount = stateLines.map(line => line.match(/^\s*Number of areas:\s*(\d+)/i)?.[1]).find(count => count !== undefined);
  const areasAvailable = stateDetails ? stateDetails.ok && declaredCount !== undefined && Number(declaredCount) === areas.length : areas.length > 0;
  const areaError = areasAvailable ? null : stateDetails
    ? stateDetails.ok && declaredCount !== undefined ? "BIRD Area 统计不完整，请重新检查" : stateDetails.output.trim() || "BIRD 未返回当前协议的 Area 统计"
    : "当前 Agent 未提供 OSPF Area 统计，请升级 Agent 后重试";
  return { state: /\bdisabled\b/i.test(block[0]!) ? "disabled" : state === "up" || state === "down" || state === "start" ? state : "unknown", areas, areasAvailable, areaError, raw: [block.join("\n"), stateDetails?.output].filter(Boolean).join("\n\n"), error: null };
}
